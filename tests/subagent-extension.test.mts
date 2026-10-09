/**
 * Comprehensive verification tests for simplified Subagent Extension.
 */

import assert from "node:assert";
import { EventEmitter } from "node:events";
import subagentExtension, {
	cleanTaskText,
	extractPlanModeInfo,
	formatDelegationList,
	getNextSubagentId,
	makeSessionFile,
	spawnChildProcess,
	type SubagentDelegation,
} from "../.pi/extensions/subagent/index.ts";
import { SubagentListComponent } from "../.pi/extensions/subagent/components.ts";

console.log("Running comprehensive Subagent Extension tests...\n");

// 1. Pure helper tests
assert.strictEqual(cleanTaskText("  **build component**  "), "Build component");
assert.strictEqual(cleanTaskText("`fix bug`"), "Fix bug");

const sampleDelegations: SubagentDelegation[] = [
	{ id: 1, task: "Task 1", status: "completed", createdAt: 1000 },
	{ id: 3, task: "Task 2", status: "in_progress", createdAt: 2000, step: 2 },
];
assert.strictEqual(getNextSubagentId([]), 1);
assert.strictEqual(getNextSubagentId(sampleDelegations), 4);

const formatted = formatDelegationList(sampleDelegations);
assert.ok(formatted.includes("#1 [COMPLETED]: Task 1"));
assert.ok(formatted.includes("#3 [IN PROGRESS]: Task 2 (Linked to Plan Step #2)"));

const mockSessionFile = "/tmp/sessions/main-session.jsonl";
const subFile = makeSessionFile(mockSessionFile, 1);
assert.ok(subFile.includes("subagent-1-"));

// Plan mode extraction helper
const mockEntries = [
	{
		type: "custom",
		customType: "plan-mode",
		data: {
			enabled: true,
			todos: [
				{ step: 1, text: "Step 1", status: "completed", completed: true },
				{ step: 2, text: "Step 2", status: "in_progress", completed: false },
			],
		},
	},
];
const planInfo = extractPlanModeInfo(mockEntries as any);
assert.strictEqual(planInfo?.enabled, true);
assert.strictEqual(planInfo?.activeStep?.step, 2);
console.log("✔ 1. Pure utility functions and plan-mode extraction verified");

// 2. Child process execution and AbortSignal cancellation
const mockChild: any = new EventEmitter();
mockChild.stdout = new EventEmitter();
mockChild.stderr = new EventEmitter();
mockChild.kill = (sig: string) => {
	mockChild.killed = sig;
};

const processPromise = spawnChildProcess(
	{ id: 1, task: "Sample task", status: "in_progress", createdAt: Date.now() },
	[],
	undefined,
	(() => mockChild) as any,
);

mockChild.stdout.emit(
	"data",
	JSON.stringify({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "Subagent answer" },
	}) + "\n",
);
mockChild.emit("close", 0);

const childOutput = await processPromise;
assert.strictEqual(childOutput, "Subagent answer");

// Verify cancellation via AbortSignal
const abortController = new AbortController();
const mockAbortChild: any = new EventEmitter();
mockAbortChild.stdout = new EventEmitter();
mockAbortChild.stderr = new EventEmitter();
mockAbortChild.kill = (sig: string) => {
	mockAbortChild.killed = sig;
};

const abortPromise = spawnChildProcess(
	{ id: 2, task: "Cancel task", status: "in_progress", createdAt: Date.now() },
	[],
	abortController.signal,
	(() => mockAbortChild) as any,
);

abortController.abort();
await assert.rejects(abortPromise, /Subagent execution cancelled/);
assert.strictEqual(mockAbortChild.killed, "SIGTERM");
console.log("✔ 2. Child process execution and AbortSignal cancellation verified");

// 3. Extension registration
const registeredTools: any[] = [];
const registeredCommands: Record<string, any> = {};
const registeredShortcuts: any[] = [];
const registeredEvents: Record<string, any[]> = {};
const appendedEntries: any[] = [];
const sentMessages: any[] = [];

const mockPi: any = {
	registerTool(tool: any) {
		registeredTools.push(tool);
	},
	registerCommand(name: string, config: any) {
		registeredCommands[name] = config;
	},
	registerShortcut(shortcut: any, config: any) {
		registeredShortcuts.push({ shortcut, config });
	},
	appendEntry(name: string, state: any) {
		appendedEntries.push({ name, state });
	},
	sendMessage(msg: any, options: any) {
		sentMessages.push({ msg, options });
	},
	on(event: string, handler: any) {
		if (!registeredEvents[event]) registeredEvents[event] = [];
		registeredEvents[event].push(handler);
	},
};

subagentExtension(mockPi, {
	spawnProcess: async (delegation) => `Completed subagent task: ${delegation.task}`,
});

// 4. Verify tool schema: simplified direct invocation without action verbs
assert.strictEqual(registeredTools.length, 1, "Only subagent tool should be registered");
const subagentTool = registeredTools[0];
assert.strictEqual(subagentTool.name, "subagent");
assert.strictEqual(subagentTool.parameters.properties.task.type, "string");
assert.strictEqual(subagentTool.parameters.properties.action, undefined, "Action enum should be eliminated");
assert.strictEqual(subagentTool.parameters.properties.role.type, "string");
assert.strictEqual(subagentTool.parameters.properties.step.type, "number");
console.log("✔ 3. Streamlined LLM tool 'subagent' schema verified");

// 5. Verify registered commands and shortcuts
assert.ok(registeredCommands["subagent"], "/subagent command registered");
assert.ok(registeredCommands["sub-switch"], "/sub-switch command registered");
assert.ok(registeredCommands["sub-return"], "/sub-return command registered");
assert.ok(registeredCommands["workflow"], "/workflow command registered");
assert.strictEqual(registeredShortcuts.length, 1, "Ctrl+Alt+S shortcut registered");
console.log("✔ 4. Slash commands and shortcuts verified");

// 6. Test tool execution with plan-mode todo adaptation
const toolCallsExecuted: any[] = [];
const mockUi: any = {
	notified: [] as string[],
	notify(msg: string) {
		this.notified.push(msg);
	},
	status: undefined as any,
	setStatus(name: string, val: any) {
		this.status = val;
	},
	setWidget(_name: string, _val: any) {},
	theme: {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	},
};

const mockCtx: any = {
	ui: mockUi,
	mode: "text",
	sessionManager: {
		getSessionFile: () => "/tmp/test-session.jsonl",
		getEntries: () => mockEntries,
	},
	executeTool: async (toolName: string, params: any) => {
		toolCallsExecuted.push({ toolName, params });
		return { content: [{ type: "text", text: "ok" }] };
	},
};

// Test empty task validation
const emptyResult = await subagentTool.execute("tc-1", { task: "   " }, undefined, undefined, mockCtx);
assert.ok(emptyResult.content[0].text.includes("Error: Task description cannot be empty"));

// Test execution with linked plan step
const execResult = await subagentTool.execute(
	"tc-2",
	{ task: "Build login form", step: 3, instructions: "Keep it simple" },
	undefined,
	undefined,
	mockCtx,
);
assert.ok(execResult.content[0].text.includes("Subagent #1 completed"));
assert.ok(execResult.content[0].text.includes("Plan step #3 marked completed"));

// Verify adaptation to todo list tool (step start and step done)
assert.strictEqual(toolCallsExecuted.length, 2);
assert.deepStrictEqual(toolCallsExecuted[0], { toolName: "todo", params: { action: "start", id: 3 } });
assert.deepStrictEqual(toolCallsExecuted[1], { toolName: "todo", params: { action: "done", id: 3 } });
console.log("✔ 5. Subagent execution and plan-mode todo adaptation verified");

// 7. Test slash command /subagent clear
await registeredCommands["subagent"].handler("clear", mockCtx);
assert.ok(mockUi.notified.some((n: string) => n.includes("Cleared all sub-agent delegations")));
console.log("✔ 6. Command '/subagent clear' verified");

// 8. Verify TUI component rendering
let closed = false;
const comp = new SubagentListComponent(sampleDelegations, mockUi.theme, () => {
	closed = true;
});
const rendered = comp.render(80);
assert.ok(rendered.some((l) => l.includes("Subagent Delegations")));
assert.ok(rendered.some((l) => l.includes("Task 1")));
comp.handleInput("q");
assert.strictEqual(closed, true, "Pressing 'q' closes modal");
console.log("✔ 7. SubagentListComponent rendering and input verified");

// 9. Lifecycle hooks
assert.ok(registeredEvents["session_start"], "session_start hook registered");
assert.ok(registeredEvents["before_agent_start"], "before_agent_start hook registered");
assert.ok(registeredEvents["context"], "context hook registered");

// Restore from session
const mockRestoreCtx = {
	...mockCtx,
	cwd: process.cwd(),
	sessionManager: {
		...mockCtx.sessionManager,
		getEntries: () => [
			{
				type: "custom",
				customType: "subagent",
				data: { delegations: sampleDelegations },
			},
		],
	},
};
await registeredEvents["session_start"][0]({}, mockRestoreCtx);

// before_agent_start should return context for active delegations
const contextInject = await registeredEvents["before_agent_start"][0]();
assert.ok(contextInject.message.content.includes("ACTIVE SUBAGENT DELEGATIONS"));
assert.ok(contextInject.message.content.includes("Task 2"));
console.log("✔ 8. Lifecycle persistence and prompt injection verified");

console.log("\n============================================");
console.log("All Subagent Extension tests passed successfully! 🎉");
console.log("============================================");
