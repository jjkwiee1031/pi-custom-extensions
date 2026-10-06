/**
 * Subagent Extension for Pi
 *
 * Delegates sub-tasks to specialist agents running in isolated child `pi` processes.
 * Each subagent gets its own context window and session file.
 *
 * Modules:
 * - utils.ts: Data models, agent discovery, session files, plan extraction
 * - process.ts: Isolated child process spawning and stdout JSON stream processing
 * - workflow.ts: Sequential multi-agent pipeline engine
 * - components.ts: Interactive TUI list component
 */

import * as fs from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { SubagentListComponent } from "./components.ts";
import { getAvailableRolesDescription, spawnChildProcess } from "./process.ts";
import {
	cleanTaskText,
	extractPlanModeInfo,
	findDelegation,
	formatDelegationList,
	getActiveDelegations,
	getAgents,
	getNextSubagentId,
	makeSessionFile,
	type AgentTemplate,
	type SubagentDelegation,
	type SubagentState,
	type WorkflowConfig,
} from "./utils.ts";
import { executeWorkflow, loadWorkflowFile } from "./workflow.ts";

// Tool Parameter Schemas
const SubagentActionSchema = Type.Union([
	Type.Literal("start"),
	Type.Literal("done"),
	Type.Literal("list"),
	Type.Literal("delegate"),
]);

const SubagentParamsSchema = Type.Object({
	action: SubagentActionSchema,
	subagentId: Type.Optional(Type.Number({ description: "Sub-agent ID (number)" })),
	step: Type.Optional(Type.Number({ description: "Plan-mode step number to link (optional)" })),
	role: Type.Optional(
		Type.String({
			description: "Specialist agent role (e.g. 'planner', 'worker'). Discovered from .pi/agents/*.md",
		}),
	),
	task: Type.Optional(Type.String({ description: "Sub-agent task description" })),
	instructions: Type.Optional(Type.String({ description: "Extra instructions or guidance (optional)" })),
});

export default function subagentExtension(pi: ExtensionAPI): void {
	let delegations: SubagentDelegation[] = [];
	let agentTemplates: AgentTemplate[] = [];
	let parentPath = "";

	// Multi-agent workflow configuration
	const currentWorkflow: WorkflowConfig = {
		agents: [],
		workflowCurrentIndex: 0,
	};

	function persistState(): void {
		const state: SubagentState = { delegations };
		pi.appendEntry("subagent", state);
	}

	function updateStatus(ctx: ExtensionContext): void {
		const active = getActiveDelegations(delegations);

		// Status bar indicator
		if (active.length > 0) {
			const primary = active[0];
			const rolePart = primary.role ? ` (${primary.role})` : "";
			const countNotice = active.length > 1 ? ` +${active.length - 1}` : "";
			ctx.ui.setStatus(
				"subagent",
				ctx.ui.theme.fg(
					"accent",
					`🤖 #${primary.id}${rolePart}: ${primary.task.slice(0, 25)}${countNotice}`,
				),
			);
		} else {
			ctx.ui.setStatus("subagent", undefined);
		}

		// Widget showing active delegations above the editor
		if (active.length > 0) {
			const widgetLines = active.map((d) => {
				const roleText = d.role ? ` [${d.role}]` : "";
				const stepText = d.step !== undefined ? ` (Plan #${d.step})` : "";
				return `${ctx.ui.theme.fg("warning", "🤖 ▶ ")}${ctx.ui.theme.bold(`Subagent #${d.id}${roleText}`)}: ${d.task}${ctx.ui.theme.fg("dim", stepText)}`;
			});
			ctx.ui.setWidget("subagent-delegations", widgetLines);
		} else {
			ctx.ui.setWidget("subagent-delegations", undefined);
		}
	}

	async function updatePlanStepStatus(
		step: number,
		action: "start" | "done",
		ctx: ExtensionContext,
	): Promise<void> {
		if ("executeTool" in ctx && typeof (ctx as any).executeTool === "function") {
			try {
				await (ctx as any).executeTool("todo", { action, id: step });
			} catch {
				// Degrade gracefully if plan-mode is absent
			}
		}
	}

	// Register the `subagent` tool for LLM delegation
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: `Delegate sub-tasks to specialist agents running in isolated child processes.
Each subagent gets its own context window and session file.

Actions:
- start: Spawn a child pi process for a task. Optionally specify a specialist role and link to a plan step.
- done: Mark a delegation as completed (and mark the linked plan step done).
- list: List all delegations.
- delegate: Auto-link to the current active plan-mode step.

Available specialist roles:
${getAvailableRolesDescription(agentTemplates)}`,
		parameters: SubagentParamsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "start": {
					if (!params.task) {
						return {
							content: [{ type: "text", text: "Error: task description is required for action 'start'." }],
						};
					}

					const id = params.subagentId ?? getNextSubagentId(delegations);
					const task = cleanTaskText(params.task);
					const role = params.role;
					const parentSession = ctx.sessionManager.getSessionFile();
					const sessionFile = makeSessionFile(parentSession, id);

					if (params.step !== undefined) {
						await updatePlanStepStatus(params.step, "start", ctx);
					}

					const delegation: SubagentDelegation = {
						id,
						task,
						instructions: params.instructions,
						role,
						step: params.step,
						status: "in_progress",
						sessionFile,
						createdAt: Date.now(),
					};

					const existingIdx = delegations.findIndex((d) => d.id === id);
					if (existingIdx >= 0) {
						delegations[existingIdx] = delegation;
					} else {
						delegations.push(delegation);
					}

					updateStatus(ctx);
					persistState();

					ctx.ui.notify(`🤖 Spawning subagent #${id}${role ? ` (${role})` : ""}...`, "info");

					let childResult: string;
					try {
						childResult = await spawnChildProcess(ctx, delegation, agentTemplates);
					} catch (err) {
						childResult = `Error: Child process failed: ${err}`;
					}

					delegation.status = "completed";
					delegation.completedAt = Date.now();

					if (params.step !== undefined) {
						await updatePlanStepStatus(params.step, "done", ctx);
					}

					updateStatus(ctx);
					persistState();

					const roleLabel = role ? ` (${role})` : "";
					const stepLabel = params.step !== undefined ? ` Plan step #${params.step} marked completed ✓.` : "";

					return {
						content: [
							{
								type: "text",
								text: `Subagent #${id}${roleLabel} completed task: "${task}" ✓.${stepLabel}\n\nSubagent Response:\n${childResult}`,
							},
						],
					};
				}

				case "done": {
					const target = findDelegation(delegations, params.subagentId);
					if (!target) {
						const idDesc = params.subagentId !== undefined ? `#${params.subagentId}` : "(no active delegation)";
						return {
							content: [{ type: "text", text: `Error: Subagent delegation ${idDesc} not found.` }],
						};
					}

					target.status = "completed";
					target.completedAt = Date.now();

					const linkedStep = params.step ?? target.step;
					if (linkedStep !== undefined) {
						await updatePlanStepStatus(linkedStep, "done", ctx);
					}

					updateStatus(ctx);
					persistState();

					const linkNotice = linkedStep !== undefined ? ` Linked plan step #${linkedStep} marked completed ✓.` : "";
					return {
						content: [
							{
								type: "text",
								text: `Subagent #${target.id} completed task: "${target.task}" ✓.${linkNotice}`,
							},
						],
					};
				}

				case "list": {
					const rolesList = getAvailableRolesDescription(agentTemplates);
					const formatted = formatDelegationList(delegations);
					return {
						content: [
							{
								type: "text",
								text: `Available Specialist Roles:\n${rolesList}\n\nSubagent Delegations:\n\n${formatted}`,
							},
						],
					};
				}

				case "delegate": {
					const entries = ctx.sessionManager.getEntries();
					const planInfo = extractPlanModeInfo(entries);
					const activeStep = planInfo?.activeStep;

					const step = params.step ?? activeStep?.step;
					const fallbackTask = activeStep ? activeStep.text : "Delegated sub-task";
					const task = cleanTaskText(params.task ?? fallbackTask);
					const role = params.role ?? "worker";
					const id = params.subagentId ?? getNextSubagentId(delegations);
					const parentSession = ctx.sessionManager.getSessionFile();
					const sessionFile = makeSessionFile(parentSession, id);

					if (!activeStep && !params.task) {
						return {
							content: [{
							type: "text",
							text: "Error: No active plan steps found to delegate. Initialize a plan first with /plan, or specify a task explicitly with subagent(action: 'delegate', task: '...')."
							}]
						};
					}

					if (step !== undefined) {
						await updatePlanStepStatus(step, "start", ctx);
					}

					const delegation: SubagentDelegation = {
						id,
						task,
						instructions: params.instructions,
						role,
						step,
						status: "in_progress",
						sessionFile,
						createdAt: Date.now(),
					};

					delegations.push(delegation);
					updateStatus(ctx);
					persistState();

					ctx.ui.notify(`🤖 Spawning subagent #${id} (${role}) for plan step #${step ?? "?"}...`, "info");

					let childResult: string;
					try {
						childResult = await spawnChildProcess(ctx, delegation, agentTemplates);
					} catch (err) {
						childResult = `Error: Child process failed: ${err}`;
					}

					delegation.status = "completed";
					delegation.completedAt = Date.now();

					if (step !== undefined) {
						await updatePlanStepStatus(step, "done", ctx);
					}

					updateStatus(ctx);
					persistState();

					const stepLabel = step !== undefined ? ` Plan step #${step} marked completed ✓.` : "";
					return {
						content: [
							{
								type: "text",
								text: `Subagent #${id} (${role}) completed delegated task: "${task}" ✓.${stepLabel}\n\nSubagent Response:\n${childResult}`,
							},
						],
					};
				}

				default:
					return {
						content: [
							{
								type: "text",
								text: `Unknown action: ${(params as { action: string }).action}`,
							},
						],
					};
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("muted", args.action);
			if (args.subagentId !== undefined) text += ` ${theme.fg("accent", `#${args.subagentId}`)}`;
			if (args.role) text += ` ${theme.fg("dim", `[${args.role}]`)}`;
			if (args.step !== undefined) text += ` ${theme.fg("dim", `(step #${args.step})`)}`;
			if (args.task) text += ` ${theme.fg("dim", `"${args.task}"`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const firstLine = text.split("\n")[0] ?? "";
			return new Text(theme.fg("success", "🤖 ") + theme.fg("muted", firstLine), 0, 0);
		},
	});

	// Register /subagent command
	pi.registerCommand("subagent", {
		description: "Start or manage sub-agent delegations (usage: /subagent [<task>|list|clear|roles])",
		handler: async (args, ctx) => {
			const raw = args?.trim() ?? "";

			if (raw.toLowerCase() === "list") {
				if (ctx.mode === "tui") {
					await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
						return new SubagentListComponent(delegations, theme, () => done());
					});
				} else {
					ctx.ui.notify(formatDelegationList(delegations), "info");
				}
				return;
			}

			if (raw.toLowerCase() === "clear" || raw.toLowerCase() === "reset") {
				delegations = [];
				updateStatus(ctx);
				persistState();
				ctx.ui.notify("Cleared all sub-agent delegations.", "info");
				return;
			}

			if (raw.toLowerCase() === "roles") {
				ctx.ui.notify(`Available specialist roles:\n${getAvailableRolesDescription(agentTemplates)}`, "info");
				return;
			}

			let role: string | undefined;
			let task = raw;

			if (!task && ctx.hasUI) {
				const input = await ctx.ui.input("Enter sub-agent task:", "e.g., Implement header component");
				if (!input?.trim()) {
					ctx.ui.notify("Sub-agent turn cancelled.", "info");
					return;
				}
				task = input.trim();
			}

			if (!task) {
				ctx.ui.notify("Usage: /subagent <task> (or /subagent list, /subagent clear, /subagent roles)", "error");
				return;
			}

			const firstWord = task.split(/\s+/)[0]?.toLowerCase();
			const matchedAgent = agentTemplates.find((a) => a.name.toLowerCase() === firstWord);
			if (matchedAgent) {
				role = matchedAgent.name;
				task = task.slice(firstWord!.length).trim();
				if (!task) {
					ctx.ui.notify(`Usage: /subagent ${role} <task>`, "error");
					return;
				}
			}

			const entries = ctx.sessionManager.getEntries();
			const planInfo = extractPlanModeInfo(entries);
			const step = planInfo?.activeStep?.step;

			const id = getNextSubagentId(delegations);
			const cleaned = cleanTaskText(task);
			const parentSession = ctx.sessionManager.getSessionFile();
			const sessionFile = makeSessionFile(parentSession, id);

			if (step !== undefined) {
				await updatePlanStepStatus(step, "start", ctx);
			}

			const delegation: SubagentDelegation = {
				id,
				task: cleaned,
				role,
				step,
				status: "in_progress",
				sessionFile,
				createdAt: Date.now(),
			};

			delegations.push(delegation);
			updateStatus(ctx);
			persistState();

			ctx.ui.notify(`🤖 Spawning subagent #${id}${role ? ` (${role})` : ""}...`, "info");

			let childResult: string;
			try {
				childResult = await spawnChildProcess(ctx, delegation, agentTemplates);
			} catch (err) {
				childResult = `Error: ${err}`;
			}

			delegation.status = "completed";
			delegation.completedAt = Date.now();

			if (step !== undefined) {
				await updatePlanStepStatus(step, "done", ctx);
			}

			updateStatus(ctx);
			persistState();

			const roleLabel = role ? ` (${role})` : "";
			pi.sendMessage(
				{
					customType: "subagent-result",
					content: `Subagent #${id}${roleLabel} completed: "${cleaned}"\n\nResult:\n${childResult}`,
					display: true,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);

			ctx.ui.notify(`🤖 Subagent #${id} finished.`, "info");
		},
	});

	// Register /sub-switch command — switch into a subagent's session
	pi.registerCommand("sub-switch", {
		description: "Switch to a sub-agent's session (usage: /sub-switch <agent-name or #id>)",
		handler: async (args, ctx) => {
			const query = args?.trim();
			if (!query) {
				ctx.ui.notify("Usage: /sub-switch <agent-name or #id>", "error");
				return;
			}

			let target: SubagentDelegation | undefined;
			if (query.startsWith("#")) {
				const id = Number(query.slice(1));
				target = delegations.find((d) => d.id === id);
			} else {
				target = [...delegations].reverse().find((d) => d.role === query);
			}

			if (!target) {
				ctx.ui.notify(`Subagent "${query}" not found.`, "error");
				return;
			}

			if (!target.sessionFile || !fs.existsSync(target.sessionFile)) {
				ctx.ui.notify(`No session file found for subagent #${target.id}.`, "error");
				return;
			}

			parentPath = ctx.sessionManager.getSessionFile();
			await ctx.switchSession(target.sessionFile, {
				withSession: async (newCtx) => {
					const roleLabel = target!.role ? ` (${target!.role})` : "";
					newCtx.ui.notify(`Switched to subagent #${target!.id}${roleLabel}. Use /sub-return to go back.`, "info");
					newCtx.ui.setWidget("subagent-session-widget", [
						newCtx.ui.theme.fg("accent", `🤖 Subagent #${target!.id}${roleLabel} session — /sub-return to exit`),
					]);
				},
			});
		},
	});

	// Register /sub-return command — return to parent session
	pi.registerCommand("sub-return", {
		description: "Return to the parent session from a sub-agent session",
		handler: async (_args, ctx) => {
			if (!parentPath) {
				ctx.ui.notify("No parent session to return to.", "error");
				return;
			}
			await ctx.switchSession(parentPath, {});
		},
	});

	// Register /workflow command
	pi.registerCommand("workflow", {
		description: "Load and run multi-agent workflows (usage: /workflow load <file> | /workflow run <task>)",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/) ?? [];
			const subCmd = parts[0]?.toLowerCase();
			const rest = parts.slice(1).join(" ");

			if (subCmd === "load") {
				try {
					const loaded = loadWorkflowFile(rest || "workflow.json");
					currentWorkflow.agents = loaded.agents;
					currentWorkflow.workflowCurrentIndex = 0;
					currentWorkflow.context = undefined;
					ctx.ui.notify(`Loaded workflow with ${currentWorkflow.agents.length} agent(s).`, "info");
				} catch (err) {
					ctx.ui.notify(`Failed to load workflow: ${err}`, "error");
				}
				return;
			}

			if (subCmd === "run") {
				try {
					await executeWorkflow({
						pi,
						ctx,
						task: rest || "Execute the workflow",
						workflow: currentWorkflow,
						delegations,
						agentTemplates,
						onUpdate: () => {
							updateStatus(ctx);
							persistState();
						},
					});
				} catch (err: any) {
					ctx.ui.notify(`Workflow error: ${err.message}`, "error");
				}
				return;
			}

			ctx.ui.notify("Usage: /workflow load <file> | /workflow run <task>", "error");
		},
	});

	// Register keyboard shortcut Ctrl+Alt+S
	pi.registerShortcut(Key.ctrlAlt("s"), {
		description: "Start a sub-agent turn",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;

			const input = await ctx.ui.input("Enter sub-agent task:", "e.g., Write unit test suite");
			if (!input?.trim()) {
				ctx.ui.notify("Sub-agent turn cancelled.", "info");
				return;
			}

			const task = cleanTaskText(input.trim());
			const entries = ctx.sessionManager.getEntries();
			const planInfo = extractPlanModeInfo(entries);
			const step = planInfo?.activeStep?.step;

			const id = getNextSubagentId(delegations);
			const parentSession = ctx.sessionManager.getSessionFile();
			const sessionFile = makeSessionFile(parentSession, id);

			if (step !== undefined) {
				await updatePlanStepStatus(step, "start", ctx);
			}

			const delegation: SubagentDelegation = {
				id,
				task,
				step,
				status: "in_progress",
				sessionFile,
				createdAt: Date.now(),
			};

			delegations.push(delegation);
			updateStatus(ctx);
			persistState();

			ctx.ui.notify(`🤖 Spawning subagent #${id}...`, "info");

			let childResult: string;
			try {
				childResult = await spawnChildProcess(ctx, delegation, agentTemplates);
			} catch (err) {
				childResult = `Error: ${err}`;
			}

			delegation.status = "completed";
			delegation.completedAt = Date.now();

			if (step !== undefined) {
				await updatePlanStepStatus(step, "done", ctx);
			}

			updateStatus(ctx);
			persistState();

			pi.sendMessage(
				{
					customType: "subagent-result",
					content: `Subagent #${id} completed: "${task}"\n\nResult:\n${childResult}`,
					display: true,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);

			ctx.ui.notify(`🤖 Subagent #${id} finished.`, "info");
		},
	});

	// Lifecycle: Restore persisted state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		agentTemplates = getAgents(ctx.cwd);

		const entries = ctx.sessionManager.getEntries();
		const subagentEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "subagent")
			.pop() as { data?: SubagentState } | undefined;

		if (subagentEntry?.data && Array.isArray(subagentEntry.data.delegations)) {
			delegations = subagentEntry.data.delegations;
		}

		updateStatus(ctx);
	});

	// Lifecycle: Inject guidance before agent turn starts if subagents are in progress
	pi.on("before_agent_start", async () => {
		const active = getActiveDelegations(delegations);
		if (active.length === 0) return;

		const activeSummary = active
			.map((d) => {
				const roleLabel = d.role ? ` (${d.role})` : "";
				return `#${d.id}${roleLabel}: "${d.task}"${d.step !== undefined ? ` [Plan Step #${d.step}]` : ""}`;
			})
			.join("\n");

		return {
			message: {
				customType: "subagent-context",
				content: `[ACTIVE SUBAGENT DELEGATIONS]
${activeSummary}

Available specialist roles:
${getAvailableRolesDescription(agentTemplates)}

Use subagent(action: "start", role: "<role>", task: "<task>") to delegate work to isolated child processes.
Use subagent(action: "done", subagentId: <id>) to mark completed manually if needed.`,
				display: false,
			},
		};
	});

	// Lifecycle: Clean out stale subagent context messages
	pi.on("context", async (event) => {
		const active = getActiveDelegations(delegations);
		if (active.length > 0) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				return msg.customType !== "subagent-context";
			}),
		};
	});
}
