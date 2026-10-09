/**
 * Plan Mode Extension for Pi
 *
 * Read-only exploration and planning mode with tool-driven Todo List execution tracking.
 * When enabled, file editing/writing tools are disabled, and bash is restricted
 * to safe inspection commands.
 *
 * Architecture:
 * - index.ts: Core extension module, safe command validation, todo tool, and lifecycle hooks.
 * - components.ts: Interactive TUI list component for /todos.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { TodoListComponent } from "./components.ts";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	step: number;
	text: string;
	status: TodoStatus;
	completed: boolean;
}

export interface PlanModeState {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
	toolsBeforePlanMode?: string[];
}

// Tool management constants
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "todo", "ask_questions", "questionnaire"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write", "todo"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write"]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

// Destructive commands blocked in plan mode
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

// Safe read-only commands allowed in plan mode
const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

/**
 * Checks whether a shell command is read-only safe in plan mode.
 */
export function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
	return !isDestructive && isSafe;
}

/**
 * Normalizes and formats step description text.
 */
export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
		.replace(/`([^`]+)`/g, "$1") // Remove code
		.trim()
		.replace(
			/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 50) {
		cleaned = `${cleaned.slice(0, 47)}...`;
	}
	return cleaned;
}

// Tool schema: streamlined action set (removed redundant 'toggle')
const TodoActionSchema = Type.Union([
	Type.Literal("list"),
	Type.Literal("add"),
	Type.Literal("start"),
	Type.Literal("done"),
	Type.Literal("set"),
	Type.Literal("clear"),
]);

const TodoParamsSchema = Type.Object({
	action: TodoActionSchema,
	id: Type.Optional(Type.Number({ description: "Step number / ID (for start, done)" })),
	text: Type.Optional(Type.String({ description: "Task description (for add)" })),
	todos: Type.Optional(
		Type.Array(Type.String(), { description: "Array of task descriptions to initialize the plan (for set)" }),
	),
});

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let toolsBeforePlanMode: string[] | undefined;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration and planning)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			const percent = Math.round((completed / todoItems.length) * 100);
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length} (${percent}%)`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ -plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Widget showing checklist of plan steps
		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				if (item.status === "in_progress") {
					return ctx.ui.theme.fg("warning", "▶ ") + ctx.ui.theme.bold(item.text);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function uniqueToolNames(toolNames: string[]): string[] {
		return [...new Set(toolNames)];
	}

	function getPlanModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...activeToolNames.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
			...PLAN_MODE_TOOLS,
		]);
	}

	function getNormalModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...NORMAL_MODE_TOOLS,
			...activeToolNames.filter((name) => !PLAN_MANAGED_TOOLS.has(name)),
		]);
	}

	function enablePlanModeTools(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
		pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
	}

	function restoreNormalModeTools(): void {
		pi.setActiveTools(toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools()));
		toolsBeforePlanMode = undefined;
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			toolsBeforePlanMode,
		});
	}

	function getNextPendingStep(): TodoItem | undefined {
		return todoItems.find((t) => !t.completed);
	}

	function setPlanMode(enable: boolean, ctx: ExtensionContext): void {
		if (planModeEnabled === enable) {
			ctx.ui.notify(
				enable ? "Plan mode is already enabled." : "Plan mode is already disabled.",
				"info",
			);
			return;
		}

		planModeEnabled = enable;
		executionMode = false;

		if (planModeEnabled) {
			enablePlanModeTools();
			ctx.ui.notify("Plan mode enabled. Built-in write tools disabled; read-only commands allowed.");
		} else {
			restoreNormalModeTools();
			ctx.ui.notify("Plan mode disabled. Full tool access restored.");
		}
		updateStatus(ctx);
		persistState();
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		setPlanMode(!planModeEnabled, ctx);
	}

	// Register /plan command
	pi.registerCommand("plan", {
		description: "Toggle or configure plan mode (usage: /plan [on|off|clear])",
		handler: async (args, ctx) => {
			const action = args?.trim().toLowerCase();
			if (action === "on") {
				setPlanMode(true, ctx);
			} else if (action === "off") {
				setPlanMode(false, ctx);
			} else if (action === "clear" || action === "reset") {
				planModeEnabled = false;
				executionMode = false;
				todoItems = [];
				restoreNormalModeTools();
				updateStatus(ctx);
				persistState();
				ctx.ui.notify("Plan reset. Todos cleared and normal tools restored.", "info");
			} else {
				togglePlanMode(ctx);
			}
		},
	});

	// Register /todos command
	pi.registerCommand("todos", {
		description: "View or manage plan todos (usage: /todos [done <n>|start <n>|add <text>|clear])",
		handler: async (args, ctx) => {
			const raw = args?.trim() ?? "";
			if (!raw) {
				if (ctx.mode === "tui") {
					await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
						return new TodoListComponent(todoItems, theme, () => done());
					});
				} else {
					if (todoItems.length === 0) {
						ctx.ui.notify("No plan todos active. Create a plan first with /plan", "info");
						return;
					}
					const list = todoItems
						.map((item) => {
							const marker = item.completed ? "☑" : item.status === "in_progress" ? "▶" : "☐";
							return `${item.step}. ${marker} ${item.text}`;
						})
						.join("\n");
					const completedCount = todoItems.filter((t) => t.completed).length;
					ctx.ui.notify(`Plan Todos (${completedCount}/${todoItems.length}):\n${list}`, "info");
				}
				return;
			}

			const parts = raw.split(/\s+/);
			const subcommand = parts[0]?.toLowerCase();
			const target = parts.slice(1).join(" ");

			if (subcommand === "done" || subcommand === "check") {
				const id = Number(target);
				if (!Number.isFinite(id)) {
					ctx.ui.notify("Usage: /todos done <step_number>", "error");
					return;
				}
				const item = todoItems.find((t) => t.step === id);
				if (!item) {
					ctx.ui.notify(`Step #${id} not found`, "error");
					return;
				}
				item.completed = true;
				item.status = "completed";
				updateStatus(ctx);
				persistState();
				ctx.ui.notify(`Marked step #${id} as completed ✓`, "info");
			} else if (subcommand === "start") {
				const id = Number(target);
				if (!Number.isFinite(id)) {
					ctx.ui.notify("Usage: /todos start <step_number>", "error");
					return;
				}
				const item = todoItems.find((t) => t.step === id);
				if (!item) {
					ctx.ui.notify(`Step #${id} not found`, "error");
					return;
				}
				item.completed = false;
				item.status = "in_progress";
				updateStatus(ctx);
				persistState();
				ctx.ui.notify(`Marked step #${id} as in progress ▶`, "info");
			} else if (subcommand === "add") {
				if (!target) {
					ctx.ui.notify("Usage: /todos add <step description>", "error");
					return;
				}
				const cleaned = cleanStepText(target);
				todoItems.push({
					step: todoItems.length + 1,
					text: cleaned,
					status: "pending",
					completed: false,
				});
				executionMode = true;
				updateStatus(ctx);
				persistState();
				ctx.ui.notify(`Added step #${todoItems.length}: ${cleaned}`, "info");
			} else if (subcommand === "clear") {
				todoItems = [];
				executionMode = false;
				updateStatus(ctx);
				persistState();
				ctx.ui.notify("Cleared all plan todos.", "info");
			} else {
				ctx.ui.notify("Unknown subcommand. Use /todos [done <n> | start <n> | add <text> | clear]", "error");
			}
		},
	});

	// Register keyboard shortcut safely with fallback
	const shortcutKey = typeof (Key as any)?.ctrlAlt === "function" ? (Key as any).ctrlAlt("p") : "ctrl+alt+p";
	pi.registerShortcut(shortcutKey, {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	async function promptUserForPlan(
		ctx: ExtensionContext,
	): Promise<"execute" | "stay" | { refine: string }> {
		if (todoItems.length === 0) return "stay";

		// 1. Send proposed plan message to the chat transcript
		const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
		pi.sendMessage({
			customType: "plan-todo-list",
			content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
			display: true,
		});

		// 2. Update widget so checklist is immediately visible above the prompt editor
		const widgetLines = todoItems.map((item) => `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`);
		ctx.ui.setWidget("plan-todos", widgetLines);

		// 3. Prompt user for approval
		const planSummary = todoItems.map((t) => `  ${t.step}. ${t.text}`).join("\n");
		const selectPrompt = `📋 Plan Ready (${todoItems.length} steps):\n\n${planSummary}\n\nWhat would you like to do?`;

		const choice = await ctx.ui.select(selectPrompt, [
			"Execute the plan (track progress)",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			const firstTodoItem = todoItems[0];
			if (firstTodoItem) {
				firstTodoItem.status = "in_progress";
			}
			planModeEnabled = false;
			executionMode = true;
			restoreNormalModeTools();
			updateStatus(ctx);
			persistState();
			return "execute";
		}

		if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			return { refine: refinement?.trim() || "" };
		}

		// User chose "Stay in plan mode" or dismissed (Esc)
		ctx.ui.notify("Staying in plan mode. You can continue discussing or refining the plan.", "info");
		updateStatus(ctx);
		return "stay";
	}

	// Register the `todo` tool for the LLM
	pi.registerTool({
		name: "todo",
		label: "Plan Todo",
		description:
			"Manage and track the plan execution todo list. Actions: list (view todos), add (add step), start (mark step in-progress by id), done (mark step completed by id), set (initialize plan todos), clear (clear todos).",
		parameters: TodoParamsSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "list": {
					if (todoItems.length === 0) {
						return {
							content: [
								{
									type: "text",
									text: "No plan todos currently defined. Call todo(action: 'set', todos: [...]) to initialize a plan.",
								},
							],
						};
					}
					const list = todoItems
						.map((t) => {
							const marker = t.completed ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
							return `${marker} #${t.step}: ${t.text}`;
						})
						.join("\n");
					const doneCount = todoItems.filter((t) => t.completed).length;
					const next = getNextPendingStep();
					const nextHint = next
						? `\nNext tool to call: todo(action: 'start', id: ${next.step}) to begin step #${next.step}: "${next.text}".`
						: "\nAll steps completed! You can now summarize the final results to the user.";

					return {
						content: [
							{
								type: "text",
								text: `Current Plan Progress (${doneCount}/${todoItems.length}):\n${list}${nextHint}`,
							},
						],
					};
				}

				case "set": {
					if (!params.todos || params.todos.length === 0) {
						return {
							content: [{ type: "text", text: "Error: todos array is required for action 'set'." }],
						};
					}
					todoItems = params.todos.map((text, idx) => ({
						step: idx + 1,
						text: cleanStepText(text),
						status: "pending",
						completed: false,
					}));
					updateStatus(ctx);
					persistState();

					if (ctx.hasUI) {
						const decision = await promptUserForPlan(ctx);

						if (decision === "execute") {
							const first = todoItems[0];
							return {
								content: [
									{
										type: "text",
										text: `Plan approved by user! You are now in EXECUTION MODE with full tool access unlocked (edit, write, bash enabled).\n\nActive step: Step #1: "${first?.text}".\nNext tools to call: Use read, edit, write, or bash to implement Step 1. When finished, call todo(action: 'done', id: 1).`,
									},
								],
							};
						}

						if (typeof decision === "object" && "refine" in decision) {
							return {
								content: [
									{
										type: "text",
										text: `User reviewed the plan and requested refinements:\n"${decision.refine}"\n\nPlease address the user's feedback, adjust your plan, and call todo(action: "set", todos: [...]) with the updated plan. Do not execute code changes yet.`,
									},
								],
							};
						}

						return {
							content: [
								{
									type: "text",
									text: "User reviewed the plan and chose to stay in plan mode without executing yet. Do not make code changes. Wait for user instructions or answer any user questions in chat.",
								},
							],
						};
					}

					return {
						content: [
							{
								type: "text",
								text: `Initialized ${todoItems.length} plan steps for execution tracking. Waiting for user approval.`,
							},
						],
					};
				}

				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text is required for action 'add'." }],
						};
					}
					const cleaned = cleanStepText(params.text);
					const newItem: TodoItem = {
						step: todoItems.length + 1,
						text: cleaned,
						status: "pending",
						completed: false,
					};
					todoItems.push(newItem);
					updateStatus(ctx);
					persistState();

					return {
						content: [
							{
								type: "text",
								text: `Added plan step #${newItem.step}: "${newItem.text}".\nNext tools to call: continue with your current step, or call todo(action: 'start', id: ${newItem.step}) when ready.`,
							},
						],
					};
				}

				case "start": {
					if (planModeEnabled) {
						return {
							content: [
								{
									type: "text",
									text: "Error: Cannot start execution steps while still in plan mode. The plan must first be initialized with todo(action: 'set', todos: [...]) and approved by the user.",
								},
							],
						};
					}

					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id is required for action 'start'." }],
						};
					}
					const item = todoItems.find((t) => t.step === params.id);
					if (!item) {
						return {
							content: [{ type: "text", text: `Error: step #${params.id} not found.` }],
						};
					}
					item.status = "in_progress";
					item.completed = false;
					updateStatus(ctx);
					persistState();

					return {
						content: [
							{
								type: "text",
								text: `Started step #${item.step}: "${item.text}" ▶.\nNext tools to call: Use read, edit, write, or bash to implement and test this step. Once finished, call todo(action: 'done', id: ${item.step}).`,
							},
						],
					};
				}

				case "done": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id is required for action 'done'." }],
						};
					}
					const item = todoItems.find((t) => t.step === params.id);
					if (!item) {
						return {
							content: [{ type: "text", text: `Error: step #${params.id} not found.` }],
						};
					}
					item.completed = true;
					item.status = "completed";
					updateStatus(ctx);
					persistState();

					const allDone = todoItems.length > 0 && todoItems.every((t) => t.completed);
					if (allDone) {
						const completedList = todoItems.map((t) => `☑ ~~${t.text}~~`).join("\n");
						pi.sendMessage(
							{
								customType: "plan-complete",
								content: `**Plan Execution Complete!** ✓\n\nAll ${todoItems.length} steps successfully finished:\n${completedList}`,
								display: true,
							},
							{ triggerTurn: false },
						);
						executionMode = false;
						updateStatus(ctx);
						persistState();

						return {
							content: [
								{
									type: "text",
									text: `Completed step #${item.step}: "${item.text}" ✓.\nAll ${todoItems.length} plan steps are now complete! Provide a final summary of your changes to the user.`,
								},
							],
						};
					}

					const next = getNextPendingStep();
					const nextGuidance = next
						? `Next tool to call: todo(action: 'start', id: ${next.step}) to begin step #${next.step}: "${next.text}".`
						: "All steps complete!";

					return {
						content: [
							{
								type: "text",
								text: `Completed step #${item.step}: "${item.text}" ✓.\n${nextGuidance}`,
							},
						],
					};
				}

				case "clear": {
					const count = todoItems.length;
					todoItems = [];
					executionMode = false;
					updateStatus(ctx);
					persistState();

					return {
						content: [{ type: "text", text: `Cleared ${count} plan todos.` }],
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${(params as { action: string }).action}` }],
					};
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text), 0, 0);
		},
	});

	pi.registerMessageRenderer("plan-todo-list", (message, _options, theme) => {
		const text = theme.fg("accent", theme.bold("📋 Proposed Plan Steps:\n\n")) + theme.fg("text", message.content);
		return new Text(text, 0, 0);
	});

	// Block modifying tools and unsafe bash commands in plan mode
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		if (PLAN_MODE_DISABLED_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: `Plan mode active: Tool "${event.toolName}" is disabled while in plan mode.
Next tool to call: Once you finish your read-only code investigation, call todo(action: "set", todos: ["Step 1 description", "Step 2 description", ...]) to establish the plan todo list.
Once the plan is approved by the user, full write/edit access will be unlocked.`,
			};
		}

		if (event.toolName === "bash") {
			const command = (event.input?.command as string) ?? "";
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode active: Bash command blocked (not allowlisted as read-only safe).\nCommand: ${command}\nUse /plan to disable plan mode first.`,
				};
			}
		}
	});

	// Clean out stale plan mode context when not in plan mode
	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject plan or execution context before agent turn starts with explicit tool instructions
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration and planning mode for safe code analysis.

Restrictions:
- Built-in edit and write tools are disabled
- Bash is strictly restricted to read-only inspection commands (cat, ls, grep, find, git status, git log, git diff, etc.)

Instructions on what tools to call:
1. Investigation: Call \`read\`, \`grep\`, \`find\`, \`ls\`, or safe read-only \`bash\` commands to inspect the codebase thoroughly.
2. Clarification: If requirements or design decisions need user feedback, ask directly in chat.
3. Initialize the Plan: Once your investigation is complete, you MUST call the \`todo\` tool with action "set" to establish the checklist:
   \`todo(action: "set", todos: ["Step 1 description", "Step 2 description", "Step 3 description", ...])\`
   Calling \`todo(action: "set")\` is REQUIRED to trigger user approval and advance to execution mode.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining
				.map((t) => {
					const marker = t.status === "in_progress" ? "[IN PROGRESS]" : "[PENDING]";
					return `${t.step}. ${marker} ${t.text}`;
				})
				.join("\n");

			const currentStep = todoItems.find((t) => t.status === "in_progress") ?? getNextPendingStep();
			const nextStepGuidance = currentStep
				? currentStep.status === "in_progress"
					? `Current active step: #${currentStep.step} ("${currentStep.text}").
Next tools to call:
- Implement with \`read\`, \`edit\`, \`write\`, or \`bash\`.
- When completed, call: \`todo(action: "done", id: ${currentStep.step})\`.`
					: `Next step to execute: #${currentStep.step} ("${currentStep.text}").
Next tools to call:
- Start step: call \`todo(action: "start", id: ${currentStep.step})\`.
- Implement with \`read\`, \`edit\`, \`write\`, or \`bash\`.
- Complete step: call \`todo(action: "done", id: ${currentStep.step})\`.`
				: "All steps are completed. Provide a final summary.";

			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Active Plan Todos:
${todoList}

Execution Tracking via the \`todo\` Tool:
${nextStepGuidance}

IMPORTANT: You MUST call the \`todo\` tool to update progress and modify the checklist. Do NOT use text tag markers in replies; only tool calls update the todo list.`,
					display: false,
				},
			};
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();

		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: PlanModeState } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
		}

		if (planModeEnabled) {
			enablePlanModeTools();
		}
		updateStatus(ctx);
	});
}
