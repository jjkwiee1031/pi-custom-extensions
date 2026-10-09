/**
 * Subagent Extension for Pi
 *
 * Delegates sub-tasks to specialist agents running in isolated child `pi` processes.
 * Integrates with plan-mode todo list execution and persists subagent sessions.
 *
 * Architecture:
 * - index.ts: Core extension module, child process runner, workflow engine, and lifecycle hooks.
 * - components.ts: Interactive TUI list component for viewing delegations.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { SubagentListComponent } from "./components.ts";

export type SubagentStatus = "in_progress" | "completed";

export interface AgentTemplate {
	name: string;
	desc: string;
	body: string;
}

export interface SubagentDelegation {
	id: number;
	task: string;
	instructions?: string;
	role?: string;
	step?: number;
	status: SubagentStatus;
	sessionFile?: string;
	createdAt: number;
	completedAt?: number;
}

export interface SubagentState {
	delegations: SubagentDelegation[];
}

export interface PlanStepInfo {
	step: number;
	text: string;
	status?: "pending" | "in_progress" | "completed";
	completed?: boolean;
}

export interface PlanModeInfo {
	enabled: boolean;
	executing?: boolean;
	todos: PlanStepInfo[];
	activeStep?: PlanStepInfo;
}

export interface WorkflowConfig {
	agents: string[];
	workflowCurrentIndex: number;
	context?: string;
}

/**
 * Normalizes and cleans task description text.
 */
export function cleanTaskText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	return cleaned;
}

/**
 * Calculates the next available subagent ID.
 */
export function getNextSubagentId(delegations: SubagentDelegation[]): number {
	if (delegations.length === 0) return 1;
	return Math.max(...delegations.map((d) => d.id)) + 1;
}

/**
 * Formats a list of delegations for terminal display.
 */
export function formatDelegationList(delegations: SubagentDelegation[]): string {
	if (delegations.length === 0) {
		return "No sub-agent delegations in this session.";
	}

	return delegations
		.map((d) => {
			const statusMarker = d.status === "completed" ? "[COMPLETED]" : "[IN PROGRESS]";
			const roleMarker = d.role ? ` (Role: ${d.role})` : "";
			const stepMarker = d.step !== undefined ? ` (Linked to Plan Step #${d.step})` : "";
			const instructions = d.instructions ? `\n    Instructions: ${d.instructions}` : "";
			const sessionFile = d.sessionFile ? `\n    Session: ${d.sessionFile}` : "";
			return `#${d.id} ${statusMarker}: ${d.task}${roleMarker}${stepMarker}${instructions}${sessionFile}`;
		})
		.join("\n");
}

/**
 * Extracts active plan-mode info from session entries.
 */
export function extractPlanModeInfo(
	entries: Array<{ type: string; customType?: string; data?: any }>,
): PlanModeInfo | undefined {
	const planEntry = [...entries]
		.reverse()
		.find((e) => e.type === "custom" && e.customType === "plan-mode");

	if (!planEntry || !planEntry.data) {
		return undefined;
	}

	const data = planEntry.data;
	const todos: PlanStepInfo[] = Array.isArray(data.todos) ? data.todos : [];
	const activeStep =
		todos.find((t) => t.status === "in_progress") ??
		todos.find((t) => !t.completed);

	return {
		enabled: Boolean(data.enabled),
		executing: Boolean(data.executing),
		todos,
		activeStep,
	};
}

/**
 * Discovers specialist agent markdown definitions from `.pi/agents/*.md`.
 */
export function getAgents(baseDir: string = process.cwd()): AgentTemplate[] {
	const dir = path.join(baseDir, ".pi", "agents");
	try {
		if (!fs.existsSync(dir)) return [];
		const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
		const results: AgentTemplate[] = [];

		for (const f of files) {
			const raw = fs.readFileSync(path.join(dir, f), "utf8");
			const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
			if (match) {
				const front = match[1];
				const nameMatch = front.match(/name:\s*(.+)/);
				const descMatch = front.match(/description:\s*(.+)/);
				if (nameMatch) {
					results.push({
						name: nameMatch[1].trim(),
						desc: descMatch ? descMatch[1].trim() : "",
						body: match[2].trim(),
					});
				}
			}
		}
		return results;
	} catch {
		return [];
	}
}

/**
 * Formats specialist roles for prompts and notifications.
 */
export function getAvailableRolesDescription(agentTemplates: AgentTemplate[]): string {
	if (agentTemplates.length === 0) return "No specialist agents found.";
	return agentTemplates.map((a) => `- ${a.name}: ${a.desc}`).join("\n");
}

/**
 * Generates an isolated session file path for child subagents.
 */
export function makeSessionFile(sessionFile: string, id: string | number): string {
	try {
		const sessionDir = path.dirname(sessionFile);
		const sessionName = path.basename(sessionFile, path.extname(sessionFile));
		const subagentDir = path.join(sessionDir, sessionName);
		fs.mkdirSync(subagentDir, { recursive: true });
		return path.join(subagentDir, `subagent-${id}-${Date.now()}.jsonl`);
	} catch {
		const tmpDir = path.join(process.cwd(), ".pi", "subagents");
		fs.mkdirSync(tmpDir, { recursive: true });
		return path.join(tmpDir, `subagent-${id}-${Date.now()}.jsonl`);
	}
}

/**
 * Loads a multi-agent workflow definition from a JSON file.
 */
export function loadWorkflowFile(filePath: string): WorkflowConfig {
	const resolved = path.resolve(filePath);
	const raw = fs.readFileSync(resolved, "utf8");
	const data = JSON.parse(raw);
	return {
		agents: Array.isArray(data.agents) ? data.agents : [],
		workflowCurrentIndex: 0,
		context: undefined,
	};
}

/**
 * Spawns an isolated child `pi` process with cancellation support and stderr capture.
 */
export function spawnChildProcess(
	delegation: SubagentDelegation,
	agentTemplates: AgentTemplate[],
	signal?: AbortSignal,
	spawnFn: typeof spawn = spawn,
): Promise<string> {
	const agent = delegation.role
		? agentTemplates.find((a) => a.name.toLowerCase() === delegation.role?.toLowerCase())
		: undefined;

	const systemPrompt = agent?.body ?? "You are a specialist agent. Complete the delegated task thoroughly.";
	const sessionFile = delegation.sessionFile ?? "";

	const childArgs = [
		"--mode", "json",
		"--system-prompt", systemPrompt,
		...(sessionFile ? ["--session", sessionFile] : []),
		"--tools", "read,bash,edit,write,grep,find,ls",
		"-p",
		delegation.instructions
			? `${delegation.task}\n\nAdditional instructions: ${delegation.instructions}`
			: delegation.task,
	];

	return new Promise((resolve, reject) => {
		const child = spawnFn("pi", childArgs, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
		});

		let buffer = "";
		let result = "";
		let stderrBuffer = "";

		const abortListener = () => {
			child.kill("SIGTERM");
			reject(new Error("Subagent execution cancelled."));
		};

		if (signal) {
			if (signal.aborted) {
				child.kill("SIGTERM");
				return reject(new Error("Subagent execution cancelled."));
			}
			signal.addEventListener("abort", abortListener, { once: true });
		}

		if (typeof child.stdout?.setEncoding === "function") {
			child.stdout.setEncoding("utf8");
		}
		child.stdout?.on("data", (chunk: string | Buffer) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line);
					if (
						event.type === "message_update" &&
						event.assistantMessageEvent?.type === "text_delta"
					) {
						result += event.assistantMessageEvent.delta;
					}
				} catch {
					// Ignore non-JSON lines
				}
			}
		});

		if (typeof child.stderr?.setEncoding === "function") {
			child.stderr.setEncoding("utf8");
		}
		child.stderr?.on("data", (chunk: string | Buffer) => {
			stderrBuffer += chunk.toString();
		});

		child.on("close", (code) => {
			if (signal) {
				signal.removeEventListener("abort", abortListener);
			}

			if (code !== 0 && !result.trim()) {
				const errMsg = stderrBuffer.trim()
					? `Child process exited with code ${code}: ${stderrBuffer.trim()}`
					: `Child process exited with code ${code ?? 0}.`;
				resolve(errMsg);
				return;
			}

			resolve(result.trim() || `Child process completed (exit code ${code ?? 0}).`);
		});

		child.on("error", (err) => {
			if (signal) {
				signal.removeEventListener("abort", abortListener);
			}
			reject(err);
		});
	});
}

// Tool schema: simplified direct invocation without action verbs
const SubagentParamsSchema = Type.Object({
	task: Type.String({ description: "Sub-agent task description" }),
	role: Type.Optional(
		Type.String({
			description: "Specialist agent role (e.g. 'planner', 'worker') discovered from .pi/agents/*.md",
		}),
	),
	instructions: Type.Optional(Type.String({ description: "Extra instructions or guidance (optional)" })),
	step: Type.Optional(Type.Number({ description: "Plan-mode todo step number to link and track" })),
});

export default function subagentExtension(
	pi: ExtensionAPI,
	options?: {
		spawnProcess?: (
			delegation: SubagentDelegation,
			agentTemplates: AgentTemplate[],
			signal?: AbortSignal,
		) => Promise<string>;
	},
): void {
	const runProcess = options?.spawnProcess ?? spawnChildProcess;
	let delegations: SubagentDelegation[] = [];
	let agentTemplates: AgentTemplate[] = [];
	let parentPath = "";

	const currentWorkflow: WorkflowConfig = {
		agents: [],
		workflowCurrentIndex: 0,
	};

	function persistState(): void {
		const state: SubagentState = { delegations };
		pi.appendEntry("subagent", state);
	}

	function updateStatus(ctx: ExtensionContext): void {
		const active = delegations.filter((d) => d.status === "in_progress");

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

			const widgetLines = active.map((d) => {
				const roleText = d.role ? ` [${d.role}]` : "";
				const stepText = d.step !== undefined ? ` (Plan #${d.step})` : "";
				return `${ctx.ui.theme.fg("warning", "🤖 ▶ ")}${ctx.ui.theme.bold(`Subagent #${d.id}${roleText}`)}: ${d.task}${ctx.ui.theme.fg("dim", stepText)}`;
			});
			ctx.ui.setWidget("subagent-delegations", widgetLines);
		} else {
			ctx.ui.setStatus("subagent", undefined);
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

	// Register streamlined `subagent` tool
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: `Delegate sub-tasks to specialist agents running in isolated child processes.
Each subagent executes in its own context window and session file.

Available specialist roles:
${getAvailableRolesDescription(agentTemplates)}`,
		parameters: SubagentParamsSchema,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const task = cleanTaskText(params.task);
			if (!task) {
				return {
					content: [{ type: "text", text: "Error: Task description cannot be empty." }],
				};
			}

			const id = getNextSubagentId(delegations);
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

			// Upsert (update or insert) delegation to prevent duplicate IDs
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
				childResult = await runProcess(delegation, agentTemplates, signal);
			} catch (err: any) {
				childResult = `Error: Child process failed: ${err.message || err}`;
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
						text: `Subagent #${id}${roleLabel} completed: "${task}" ✓.${stepLabel}\n\nSubagent Response:\n${childResult}`,
					},
				],
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("subagent "));
			if (args.role) text += `${theme.fg("accent", `[${args.role}] `)}`;
			if (args.step !== undefined) text += `${theme.fg("dim", `(plan #${args.step}) `)}`;
			if (args.task) text += `${theme.fg("muted", `"${args.task}"`)}`;
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
		description: "Start or manage sub-agent delegations (/subagent [<task>|list|clear|roles])",
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

			// In interactive command, auto-link active plan step if available
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
				childResult = await runProcess(delegation, agentTemplates);
			} catch (err: any) {
				childResult = `Error: ${err.message || err}`;
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

	// Register /sub-switch command — switch into a subagent's session transcript
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
				target = [...delegations].reverse().find((d) => d.role?.toLowerCase() === query.toLowerCase());
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
				} catch (err: any) {
					ctx.ui.notify(`Failed to load workflow: ${err.message || err}`, "error");
				}
				return;
			}

			if (subCmd === "run") {
				if (currentWorkflow.agents.length === 0) {
					ctx.ui.notify("No workflow loaded. Load a workflow definition first.", "error");
					return;
				}

				const task = rest || "Execute the workflow";
				currentWorkflow.workflowCurrentIndex = 0;
				currentWorkflow.context = "";

				for (let i = 0; i < currentWorkflow.agents.length; i++) {
					const agentRole = currentWorkflow.agents[i];
					currentWorkflow.workflowCurrentIndex = i;

					ctx.ui.notify(
						`🤖 Workflow step ${i + 1}/${currentWorkflow.agents.length}: Running ${agentRole}...`,
						"info",
					);

					const id = getNextSubagentId(delegations);
					const parentSession = ctx.sessionManager.getSessionFile();
					const sessionFile = makeSessionFile(parentSession, id);
					const fullTask = currentWorkflow.context
						? `Previous agent output:\n${currentWorkflow.context}\n\nTask:\n${task}`
						: task;

					const delegation: SubagentDelegation = {
						id,
						task: `Workflow step ${i + 1}: ${agentRole} — ${task}`,
						role: agentRole,
						status: "in_progress",
						sessionFile,
						createdAt: Date.now(),
					};

					delegations.push(delegation);
					updateStatus(ctx);
					persistState();

					let childResult: string;
					try {
						childResult = await runProcess(delegation, agentTemplates);
					} catch (err: any) {
						childResult = `Error: ${err.message || err}`;
						ctx.ui.notify(`Workflow failed at step ${i + 1} (${agentRole}): ${childResult}`, "error");
						delegation.status = "completed";
						delegation.completedAt = Date.now();
						updateStatus(ctx);
						persistState();
						break;
					}

					delegation.status = "completed";
					delegation.completedAt = Date.now();
					currentWorkflow.context = childResult;
					updateStatus(ctx);
					persistState();
				}

				pi.sendMessage(
					{
						customType: "workflow-result",
						content: `Workflow complete (${currentWorkflow.agents.length} agents).\n\nFinal result:\n${currentWorkflow.context}`,
						display: true,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);

				ctx.ui.notify("🤖 Workflow complete!", "info");
				return;
			}

			ctx.ui.notify("Usage: /workflow load <file> | /workflow run <task>", "error");
		},
	});

	// Register keyboard shortcut Ctrl+Alt+S
	const shortcutKey = typeof (Key as any)?.ctrlAlt === "function" ? (Key as any).ctrlAlt("s") : "ctrl+alt+s";
	pi.registerShortcut(shortcutKey, {
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
				childResult = await runProcess(delegation, agentTemplates);
			} catch (err: any) {
				childResult = `Error: ${err.message || err}`;
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
		const active = delegations.filter((d) => d.status === "in_progress");
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

Use subagent(task: "<task>", role?: "<role>", step?: <step>) to delegate work to isolated child processes.`,
				display: false,
			},
		};
	});

	// Lifecycle: Clean out stale subagent context messages
	pi.on("context", async (event) => {
		const active = delegations.filter((d) => d.status === "in_progress");
		if (active.length > 0) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				return msg.customType !== "subagent-context";
			}),
		};
	});
}
