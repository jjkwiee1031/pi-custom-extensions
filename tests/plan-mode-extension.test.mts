/**
 * Comprehensive verification tests for simplified Plan Mode Extension.
 */

import assert from "node:assert";
import planModeExtension, {
	cleanStepText,
	isSafeCommand,
	type TodoItem,
} from "../.pi/extensions/plan-mode/index.ts";
import { TodoListComponent } from "../.pi/extensions/plan-mode/components.ts";

console.log("Running comprehensive Plan Mode Extension tests...\n");

// 1. Pure helper tests: cleanStepText
assert.strictEqual(cleanStepText("  **Create header component**  "), "Header component");
assert.strictEqual(cleanStepText("`Write` unit tests for auth"), "Unit tests for auth");
assert.strictEqual(cleanStepText("Execute the database migration"), "Database migration");
console.log("✔ 1. cleanStepText unit tests passed");

// 2. Safe command allowlist and denylist tests
assert.strictEqual(isSafeCommand("ls -la"), true);
assert.strictEqual(isSafeCommand("cat package.json"), true);
assert.strictEqual(isSafeCommand("git status"), true);
assert.strictEqual(isSafeCommand("git diff HEAD~1"), true);
assert.strictEqual(isSafeCommand("grep -rn 'function' ."), true);
assert.strictEqual(isSafeCommand("find . -name '*.ts'"), true);

assert.strictEqual(isSafeCommand("rm -rf node_modules"), false);
assert.strictEqual(isSafeCommand("mv old.txt new.txt"), false);
assert.strictEqual(isSafeCommand("git commit -m 'wip'"), false);
assert.strictEqual(isSafeCommand("echo 'malicious' > output.txt"), false);
assert.strictEqual(isSafeCommand("npm install express"), false);
assert.strictEqual(isSafeCommand("sudo apt update"), false);
console.log("✔ 2. isSafeCommand allowlist/denylist verified");

// 3. Mock Extension API and registration
const registeredTools: any[] = [];
const registeredCommands: Record<string, any> = {};
const registeredShortcuts: any[] = [];
const registeredFlags: Record<string, any> = {};
const registeredEvents: Record<string, any[]> = {};
const appendedEntries: any[] = [];
const sentMessages: any[] = [];
let activeTools = ["read", "bash", "edit", "write"];

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
	registerFlag(name: string, config: any) {
		registeredFlags[name] = config;
	},
	registerMessageRenderer() {},
	appendEntry(name: string, state: any) {
		appendedEntries.push({ name, state });
	},
	sendMessage(msg: any, options: any) {
		sentMessages.push({ msg, options });
	},
	getActiveTools() {
		return activeTools;
	},
	setActiveTools(tools: string[]) {
		activeTools = tools;
	},
	getFlag(name: string) {
		return registeredFlags[name]?.default;
	},
	on(event: string, handler: any) {
		if (!registeredEvents[event]) registeredEvents[event] = [];
		registeredEvents[event].push(handler);
	},
};

planModeExtension(mockPi);

// 4. Verify tool schema: streamlined action set (toggle removed)
assert.strictEqual(registeredTools.length, 1, "Only todo tool should be registered");
const todoTool = registeredTools[0];
assert.strictEqual(todoTool.name, "todo");
const actionLiterals = todoTool.parameters.properties.action.anyOf.map((a: any) => a.const);
assert.ok(actionLiterals.includes("list"));
assert.ok(actionLiterals.includes("add"));
assert.ok(actionLiterals.includes("start"));
assert.ok(actionLiterals.includes("done"));
assert.ok(actionLiterals.includes("set"));
assert.ok(actionLiterals.includes("clear"));
assert.strictEqual(actionLiterals.includes("toggle"), false, "Redundant 'toggle' action removed");
console.log("✔ 3. Streamlined 'todo' tool schema verified");

// 5. Verify commands, flags, and shortcuts
assert.ok(registeredCommands["plan"], "/plan command registered");
assert.ok(registeredCommands["todos"], "/todos command registered");
assert.strictEqual(registeredShortcuts.length, 1, "Ctrl+Alt+P shortcut registered");
assert.ok(registeredFlags["plan"], "--plan flag registered");
console.log("✔ 4. Slash commands, shortcuts, and flags verified");

// 6. Test tool execution and plan lifecycle
const mockUi: any = {
	notified: [] as string[],
	notify(msg: string) {
		this.notified.push(msg);
	},
	setStatus() {},
	setWidget() {},
	theme: {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	},
};

const mockCtx: any = {
	ui: mockUi,
	mode: "text",
	hasUI: false,
	sessionManager: {
		getSessionFile: () => "/tmp/plan-session.jsonl",
		getEntries: () => [],
	},
};

// Test todo action 'set'
const setResult = await todoTool.execute(
	"tc-1",
	{ action: "set", todos: ["Analyze dependencies", "Write migration script", "Run tests"] },
	undefined,
	undefined,
	mockCtx,
);
assert.ok(setResult.content[0].text.includes("Initialized 3 plan steps"));

// Test todo action 'list'
const listResult = await todoTool.execute("tc-2", { action: "list" }, undefined, undefined, mockCtx);
assert.ok(listResult.content[0].text.includes("Current Plan Progress (0/3)"));
assert.ok(listResult.content[0].text.includes("#1: Analyze dependencies"));

// Test todo action 'start' (step 1)
const startResult = await todoTool.execute("tc-3", { action: "start", id: 1 }, undefined, undefined, mockCtx);
assert.ok(startResult.content[0].text.includes("Started step #1: \"Analyze dependencies\""));

// Test todo action 'add'
const addResult = await todoTool.execute("tc-4", { action: "add", text: "New validation check" }, undefined, undefined, mockCtx);
assert.ok(addResult.content[0].text.includes("Added plan step #4"));

// Test todo action 'done' (step 1)
const doneResult = await todoTool.execute("tc-5", { action: "done", id: 1 }, undefined, undefined, mockCtx);
assert.ok(doneResult.content[0].text.includes("Completed step #1: \"Analyze dependencies\" ✓"));

console.log("✔ 5. 'todo' tool lifecycle (set, list, start, add, done) verified");

// 7. Test plan-mode tool blocking
await registeredCommands["plan"].handler("on", mockCtx);

// Verify modifying tools are blocked
const toolCallHook = registeredEvents["tool_call"][0];
const blockedEdit = await toolCallHook({ toolName: "edit" });
assert.strictEqual(blockedEdit?.block, true);
assert.ok(blockedEdit?.reason.includes("Plan mode active: Tool \"edit\" is disabled"));

const blockedWrite = await toolCallHook({ toolName: "write" });
assert.strictEqual(blockedWrite?.block, true);

// Verify unsafe bash is blocked
const blockedBash = await toolCallHook({ toolName: "bash", input: { command: "rm -rf /" } });
assert.strictEqual(blockedBash?.block, true);
assert.ok(blockedBash?.reason.includes("Bash command blocked"));

// Verify safe bash is allowed
const allowedBash = await toolCallHook({ toolName: "bash", input: { command: "git status" } });
assert.strictEqual(allowedBash, undefined);
console.log("✔ 6. Plan mode tool and safe-bash interception verified");

// 8. Test /todos command manipulation
await registeredCommands["todos"].handler("done 2", mockCtx);
assert.ok(mockUi.notified.some((n: string) => n.includes("Marked step #2 as completed ✓")));

await registeredCommands["todos"].handler("start 3", mockCtx);
assert.ok(mockUi.notified.some((n: string) => n.includes("Marked step #3 as in progress ▶")));

await registeredCommands["todos"].handler("clear", mockCtx);
assert.ok(mockUi.notified.some((n: string) => n.includes("Cleared all plan todos.")));
console.log("✔ 7. '/todos' command manipulation verified");

// 9. Test TUI TodoListComponent rendering
let closed = false;
const sampleTodos: TodoItem[] = [
	{ step: 1, text: "Task 1", status: "completed", completed: true },
	{ step: 2, text: "Task 2", status: "in_progress", completed: false },
	{ step: 3, text: "Task 3", status: "pending", completed: false },
];
const comp = new TodoListComponent(sampleTodos, mockUi.theme, () => {
	closed = true;
});
const rendered = comp.render(80);
assert.ok(rendered.some((l) => l.includes("Plan Execution Todos")));
assert.ok(rendered.some((l) => l.includes("1/3 completed (33%)")));
assert.ok(rendered.some((l) => l.includes("Task 1")));
comp.handleInput("q");
assert.strictEqual(closed, true, "Pressing 'q' closes modal");
console.log("✔ 8. TodoListComponent TUI component verified");

// 10. Lifecycle state restoration
const mockRestoreCtx = {
	...mockCtx,
	sessionManager: {
		...mockCtx.sessionManager,
		getEntries: () => [
			{
				type: "custom",
				customType: "plan-mode",
				data: { enabled: false, todos: sampleTodos, executing: true },
			},
		],
	},
};
await registeredEvents["session_start"][0]({}, mockRestoreCtx);

const execContext = await registeredEvents["before_agent_start"][0]();
assert.ok(execContext.message.content.includes("EXECUTING PLAN"));
assert.ok(execContext.message.content.includes("Task 2"));
console.log("✔ 9. Session state restoration and context prompt verified");

console.log("\n============================================");
console.log("All Plan Mode Extension tests passed successfully! 🎉");
console.log("============================================");
