/**
 * Plan Mode Extension for Pi
 *
 * Read-only exploration and planning mode with tool-driven Todo List execution tracking.
 * When enabled, file editing/writing tools are disabled, and bash is restricted
 * to safe inspection commands.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P shortcut to toggle plan mode
 * - Full-featured /todos command to view or manually manage todos
 * - Integrated `todo` tool: The ONLY way the agent can modify the todo list
 * - Explicit prompt instructions guiding the agent on what tools to call next
 * - Live checklist widget above the editor showing current tasks and status
 * - Status bar indicator showing completion count and percentage
 * - Interactive TUI modal to review the plan checklist
 * - Full session persistence and resume support
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	cleanStepText,
	extractTodoItems,
	isSafeCommand,
	type TodoItem,
	type TodoStatus,
} from "./utils.ts";

// Tools configuration
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "todo", "ask_questions", "questionnaire"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write", "todo"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write"]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

interface PlanModeState {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
	toolsBeforePlanMode?: string[];
}

const TodoActionSchema = Type.Union([
	Type.Literal("list"),
	Type.Literal("add"),
	Type.Literal("start"),
	Type.Literal("done"),
	Type.Literal("toggle"),
	Type.Literal("set"),
	Type.Literal("clear"),
]);

const TodoParamsSchema = Type.Object({
	action: TodoActionSchema,
	id: Type.Optional(Type.Number({ description: "Step number / ID (for start, done, toggle)" })),
	text: Type.Optional(Type.String({ description: "Task description (for add)" })),
	todos: Type.Optional(Type.Array(Type.String(), { description: "Array of task descriptions to set the full plan (for set)" })),
});

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * Interactive UI Component for /todos
 */
class TodoListComponent {
	private todos: TodoItem[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: TodoItem[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter") || data === "q") {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Plan Execution Todos ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 26)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No active plan todos. Create a plan with /plan")}`, width));
		} else {
			const done = this.todos.filter((t) => t.completed).length;
			const inProg = this.todos.filter((t) => t.status === "in_progress").length;
			const total = this.todos.length;
			const percent = Math.round((done / total) * 100);

			let summary = `  ${th.fg("muted", `${done}/${total} completed (${percent}%)`)}`;
			if (inProg > 0) {
				summary += th.fg("warning", ` • ${inProg} in progress`);
			}
			lines.push(truncateToWidth(summary, width));
			lines.push("");

			for (const todo of this.todos) {
				let icon = th.fg("dim", "○");
				let itemText = th.fg("text", todo.text);

				if (todo.completed) {
					icon = th.fg("success", "✓");
					itemText = th.fg("dim", th.strikethrough(todo.text));
				} else if (todo.status === "in_progress") {
					icon = th.fg("warning", "▶");
					itemText = th.bold(th.fg("accent", todo.text));
				}

				const id = th.fg("dim", `#${todo.step}`);
				lines.push(truncateToWidth(`  ${icon} ${id} ${itemText}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape, Enter, or 'q' to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let toolsBeforePlanMode: string[] | undefined;
	let planSetInThisTurn = false;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration and planning)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		// Footer status
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

	// Register keyboard shortcut
	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Register the `todo` tool for the LLM — the ONLY way the agent modifies todos
	pi.registerTool({
		name: "todo",
		label: "Plan Todo",
		description:
			"Manage and track the plan execution todo list. Actions: list (view todos), add (add step), start (mark step in-progress by id), done (mark step completed by id), toggle (toggle step completion by id), set (set initial list of todos), clear (clear todos). Calling this tool is REQUIRED to update plan progress.",
		parameters: TodoParamsSchema,

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
					planSetInThisTurn = true;
					updateStatus(ctx);
					persistState();

					return {
						content: [
							{
								type: "text",
								text: `Initialized ${todoItems.length} plan steps for execution tracking. Present your plan clearly to the user under a "Plan:" header.`,
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
					if (planModeEnabled) {
						planSetInThisTurn = true;
					}
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

				case "done":
				case "toggle": {
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
					if (params.action === "toggle") {
						item.completed = !item.completed;
						item.status = item.completed ? "completed" : "pending";
					} else {
						item.completed = true;
						item.status = "completed";
					}
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

	// Inject plan or execution context before agent turn starts with explicit next tool instructions
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
1. Investigation: First, call \`read\`, \`grep\`, \`find\`, \`ls\`, or safe read-only \`bash\` commands to inspect the codebase thoroughly.
2. Clarification: If requirements or design decisions need user feedback, call \`ask_questions\` / \`questionnaire\` or ask directly in chat.
3. Initialize the Plan Todo List: Once your investigation and analysis are complete, you MUST call the \`todo\` tool with action "set" to initialize the execution checklist:
   \`todo(action: "set", todos: ["Step 1 description", "Step 2 description", "Step 3 description", ...])\`
   Calling \`todo\` with action "set" is REQUIRED to establish the plan and advance to execution.
4. Also present your plan clearly in your response text under a "Plan:" header with numbered steps:

Plan:
1. First step description
2. Second step description
3. Third step description

CRITICAL: Do NOT remain analyzing indefinitely. Once you have enough context, call \`todo(action: "set", todos: [...])\` to set the plan and transition to execution. Do NOT attempt to modify files directly in plan mode.`,
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

	function hasQuestionToolCall(message: AssistantMessage): boolean {
		if (!Array.isArray(message.content)) return false;
		return message.content.some((block) => {
			const b = block as Record<string, unknown>;
			const name = String(b.name ?? b.toolName ?? "");
			return (
				(b.type === "toolCall" || b.type === "tool_call" || b.type === "toolUse") &&
				/question|ask/i.test(name)
			);
		});
	}

	function isAskingQuestion(text: string): boolean {
		const trimmed = text.trim();
		if (!trimmed) return false;

		// Check if message ends with a question mark
		const lastParagraph = trimmed.split(/\n\s*\n/).pop()?.trim() ?? "";
		if (/\?\s*(\*{1,2}|_{1,2}|["'`])?\s*$/.test(lastParagraph)) {
			return true;
		}

		// Check for question or clarification sections
		if (/(?:questions?|clarifications?)\s*(?:for you|needed|to clarify|before we (?:proceed|begin|start))?:/i.test(trimmed)) {
			return true;
		}

		// Check for closing question prompts
		if (/(?:please\s+)?(?:let me know|clarify|confirm)\s+which\b/i.test(lastParagraph)) {
			return true;
		}

		return false;
	}

	// Handle plan creation dialog and plan completion
	pi.on("agent_end", async (event, ctx) => {
		if (!planModeEnabled || !ctx.hasUI) return;

		// Find the latest assistant message
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (!lastAssistant) return;

		// 1. If the assistant called a question tool, it is actively asking questions: do not prompt
		if (hasQuestionToolCall(lastAssistant)) return;

		const assistantText = getTextContent(lastAssistant);

		// 2. If the assistant text is asking a question or requesting clarification: do not prompt
		if (isAskingQuestion(assistantText)) return;

		// 3. Check if a plan was output in text, or previously initialized via the todo tool in this turn
		const extracted = extractTodoItems(assistantText);
		if (extracted.length > 0) {
			todoItems = extracted;
			planSetInThisTurn = true;
		}

		// Only prompt if a plan was actually initialized or formulated in THIS turn
		if (!planSetInThisTurn || todoItems.length === 0) {
			return;
		}
		planSetInThisTurn = false;
		persistState();

		// Show plan steps and prompt user for next step
		const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
		const planTodoListMessage = {
			customType: "plan-todo-list",
			content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
			display: true,
		};

		// 1. Immediately send the plan message to the chat transcript before asking for choice
		pi.sendMessage(planTodoListMessage);

		// 2. Update widget so the checklist is immediately visible above the editor
		const widgetLines = todoItems.map((item) => `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`);
		ctx.ui.setWidget("plan-todos", widgetLines);

		// 3. Display the plan steps directly inside the selection prompt so the user sees it while choosing
		const planSummary = todoItems.map((t) => `  ${t.step}. ${t.text}`).join("\n");
		const selectPrompt = `📋 Plan Ready (${todoItems.length} steps):\n\n${planSummary}\n\nWhat would you like to do?`;

		const choice = await ctx.ui.select(selectPrompt, [
			"Execute the plan (track progress)",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			const firstTodoItem = todoItems[0];
			if (!firstTodoItem) return;

			planModeEnabled = false;
			executionMode = true;
			firstTodoItem.status = "in_progress";
			restoreNormalModeTools();
			updateStatus(ctx);
			persistState();

			const remainingList = todoItems.map((t) => `${t.step}. ${t.text}`).join("\n");
			const execMessage = `Execute the plan.

Plan Todos:
${remainingList}

Next tools to call:
1. Step 1 is now active: "${firstTodoItem.text}".
2. Call \`read\`, \`edit\`, \`write\`, or \`bash\` to implement Step 1.
3. Call \`todo(action: "done", id: 1)\` once Step 1 is verified and complete.
4. Next, call \`todo(action: "start", id: 2)\` for the next step.

Remember: Call the \`todo\` tool to update progress as you complete each step.`;

			pi.sendMessage(
				{ customType: "plan-mode-execute", content: execMessage, display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		} else {
			// User chose "Stay in plan mode" or dismissed (Esc)
			ctx.ui.notify("Staying in plan mode. You can continue discussing or refining the plan.", "info");
			updateStatus(ctx);
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state if available
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
