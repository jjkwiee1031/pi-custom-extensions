# Pi Agent Project: Plan Mode & Subagent Extensions

A comprehensive agent framework with plan-mode exploration and subagent delegation capabilities.

## Project Overview

This project implements a Pi agent framework enhanced with two powerful extensions:

### Plan Mode Extension
A read-only exploration and planning mode with tool-driven Todo List execution tracking. When enabled, file editing/writing tools are disabled and bash is restricted to safe inspection commands, providing a safe environment for code analysis and planning.

### Subagent Extension
Allows the agent to delegate sub-tasks to specialist agents running in isolated child `pi` processes. Each subagent gets its own context window and session file, enabling parallel or sequential multi-agent workflows.

## Key Features

### Plan Mode Features
- **Read-Only Exploration**: Built-in file editing/writing tools are disabled to prevent accidental changes while researching
- **Safe Command Allowlist**: Restricts bash tool execution to read-only inspection commands (`cat`, `grep`, `find`, `ls`, `git status`, `git diff`, etc.) while blocking modification commands
- **Plan Extraction**: Intelligently parses numbered steps from markdown `Plan:` sections produced by the agent
- **Interactive Plan Transition**: Prompts with actions when a plan is ready:
  - Execute the plan (track progress)
  - Stay in plan mode
  - Refine the plan
- **Tool-Driven Execution Tracking**: The agent must call the registered `todo` tool to modify the checklist (`start`, `done`, `add`, `set`, etc.)
- **Live Checklist Widget**: Displays live progress with status indicators (`☑` completed, `▶` in progress, `☐` pending)
- **Status Bar Indicator**: Real-time ratio and percentage (e.g., `📋 2/5 (40%)`)
- **Interactive `/todos` Modal**: Full TUI overlay to inspect plan progress
- **Session Persistence**: Saves and restores plan state across session pauses and resumes

### Subagent Features
- **`subagent` tool**: The LLM calls `subagent` to hand a sub-task to a sub-agent turn
- **Plan-mode integration**: Link a subagent call to a plan-mode todo step, so the step is auto-marked in-progress/completed
- **`/subagent` command**: Manually spawn a sub-agent turn for a step without an LLM tool call
- **State tracking**: Each sub-agent delegation is stored in the session so delegations survive pauses/resumes and branch correctly
- **Independent of plan mode**: Works without plan-mode installed; when both are installed, the two track each other's state

## Architecture Diagram (Text-Based)

```
+-----------------------------------------------------------+
|                     Pi Agent Framework                    |
|                                                           |
|  +----------------------+     +------------------------+ |
|  |   Plan Mode Extension|     |   Subagent Extension   | |
|  |  (read-only mode)    |     |  (isolated child      | |
|  |                      |     |   pi processes)      | |
|  +----------+-----------+     +----------+-----------+ |
|            |                         |                |
|            |   sub-agent delegation  |   plan steps   |
|            v                         v                |
|  +----------+-----------+     +----------+-----------+ |
|  |   Tool Management    |     |   Todo List Tool     | |
|  |   (safe commands)    |     |   (todo: start/done) | |
|  +----------------------+     +----------------------+ |
|                                                           |
|  +----------------------+     +------------------------+ |
|  |   Session Manager    |     |   Agent Templates      | |
|  |   (state persist)    |     |   (.pi/agents/*.md)    | |
|  +----------------------+     +------------------------+ |
|                                                           |
+-----------------------------------------------------------+
```

## Installation Instructions

### Prerequisites
- Pi agent framework installed
- Node.js 18+ (for TypeScript extensions)

### Install Extensions
1. Clone this repository or ensure the project structure exists at `/home/jjk-wsl/newPI`
2. The extensions are already included in the `.pi/extensions` directory:

```bash
# Verify extension directories exist
ls -la /home/jjk-wsl/newPI/.pi/extensions/
# plan-mode/  subagent/
```

3. Ensure agent definitions are in place:

```bash
ls -la /home/jjk-wsl/newPI/.pi/agents/
# planner.md  worker.md
```

### Start Pi with Plan Mode
```bash
pi --plan "Audit the repository and plan TypeScript migration"
```

### Start Pi with Subagent Capabilities
Simply start Pi normally - the subagent extension is active by default:

```bash
pi "Your task here"
```

## Usage Examples

### Plan Mode Usage

#### Toggle Plan Mode
```bash
/plan          # Toggle plan mode on/off
/plan on       # Explicitly enable plan mode
/plan off      # Explicitly disable plan mode
/plan clear    # Clear all todos, restore normal mode, and reset status
```

#### Manage Plan Todos
```bash
/todos         # View current plan todos
/todos done <n>  # Mark step #n as completed
/todos start <n> # Mark step #n as in progress
/todos add <text>  # Append a new step to the active plan
/todos clear   # Clear all active plan todos
```

#### Keyboard Shortcut
- `Ctrl+Alt+P` — Toggle plan mode

#### CLI Flag
```bash
pi --plan "Audit the repository and plan TypeScript migration"
```

#### Agent `todo` Tool Usage (LLM calls)
```json
{
  "action": "set",
  "todos": ["Step 1 description", "Step 2 description", "Step 3 description"]
}
```

### Subagent Delegation Usage

#### Tool: `subagent`
```json
{
  "action": "start",
  "subagentId": 1,
  "task": "Write the user-facing greeting component",
  "instructions": "Use Tailwind CSS and keep it under 200 lines."
}
```

#### Link to Plan Mode Step
```json
{
  "action": "start",
  "subagentId": 1,
  "step": 3,
  "task": "Write the user-facing greeting component",
  "instructions": "Use Tailwind CSS and keep it under 200 lines."
}
```

#### Mark Completion
```json
{
  "action": "done",
  "subagentId": 1
}
```

#### Manual Sub-agent Spawn
```bash
/subagent Write unit tests for the authentication module
/subagent planner Analyze the security vulnerabilities
/subagent worker Implement the API endpoint
```

#### Sub-agent Commands
```bash
/subagent list           # List all active sub-agent delegations
/subagent clear          # Clear all sub-agent delegation state
/subagent roles          # List available specialist roles
/sub-switch #subagent-1  # Switch to sub-agent's session transcript
/sub-return              # Return to the parent session
```

#### Workflow Commands
```bash
/workflow load workflow.json    # Load a multi-agent workflow pipeline
/workflow run "Execute pipeline"  # Sequentially execute the loaded pipeline
```

#### Keyboard Shortcut
- `Ctrl+Alt+S` — Start a sub-agent turn (prompt for the task)

### Multi-Agent Workflows

#### Using workflow.json
The project includes a `workflow.json` that defines the agent sequence:

```json
{
    "agents": ["planner", "worker"]
}
```

#### Load and Run Pipeline
```bash
/workflow load /path/to/workflow.json
/workflow run "Execute the full pipeline"
```

This will sequentially execute agents defined in the workflow, enabling structured multi-agent processing.

## Workflow Pipeline vs Child Subagents

Here is a side-by-side comparison:

| Dimension | Workflow Pipeline (`/workflow`) | Child Subagent Tool (`subagent`) |
|-----------|----------------------------------|----------------------------------|
| **Structure** | Fixed / Deterministic: Defined beforehand (e.g. `["planner", "worker"]` in `workflow.json`). | Flexible / Dynamic: Decided on-the-fly by the main agent based on needs. |
| **Execution** | Strictly Sequential: Step 1 must finish before Step 2 starts. | Can run in Parallel: Multiple subagents execute concurrently when tasks are independent. |
| **Context Passing** | Chained Handoff: Output of Agent A is piped directly into the prompt of Agent B. | Hub-and-Spoke: Results flow back to the Main Agent, which synthesizes and decides next steps. |
| **Control** | Controlled by the pipeline script (fixed order). | Controlled by the Main Agent LLM (autonomous judgment). |

### When to use which?

#### Use Workflow Pipeline when:

• You have a standard, repeatable assembly line where the order never changes:
    • Example: `Scout → Planner → Worker → Reviewer`.
• Each step strictly depends on the output of the previous step.

#### Use Child Subagents when:

• You need speed & concurrency:
    • Example: "Inspect the auth module AND inspect the database schema at the same time." (spawns 2 subagents simultaneously).
• The task is unpredictable:
    • The main agent doesn't know in advance how many sub-tasks will be needed until it starts exploring.

## File Structure

```
/home/jjk-wsl/newPI/
├── workflow.json              # Multi-agent workflow configuration
├── .pi/
│   ├── agents/
│   │   ├── planner.md         # Planner agent definition
│   │   └── worker.md          # Worker agent definition
│   ├── extensions/
│   │   ├── plan-mode/
│   │   │   ├── index.ts       # Plan mode extension entry point
│   │   │   ├── utils.ts       # Utility functions
│   │   │   └── README.md      # Plan mode documentation
│   │   └── subagent/
│   │       ├── index.ts       # Subagent extension entry point
│   │       ├── utils.ts       # Subagent utilities
│   │       ├── process.ts     # Child process spawning
│   │       ├── workflow.ts    # Workflow engine
│   │       ├── components.ts  # TUI components
│   │       └── README.md      # Subagent documentation
│   └── session/               # Session state files
└── README.md                  # This file
```

### Agent Definitions

| File | Role | Description |
|------|------|-------------|
| `.pi/agents/planner.md` | planner | Architecture and implementation planning specialist |
| `.pi/agents/worker.md` | worker | General-purpose agent with full capabilities |

### Extension Files

| Directory | Key Files |
|-----------|-----------|
| `.pi/extensions/plan-mode/` | `index.ts`, `utils.ts`, `README.md` |
| `.pi/extensions/subagent/` | `index.ts`, `utils.ts`, `process.ts`, `workflow.ts`, `components.ts`, `README.md` |

## Extension Development Guide

### Creating a New Extension

1. **Create extension directory**:
   ```bash
   mkdir -p /home/jjk-wsl/newPI/.pi/extensions/my-extension
   ```

2. **Create `index.ts`** - Extension entry point that registers tools, commands, shortcuts, and lifecycle hooks following the patterns in existing extensions.

3. **Define utility functions** in `utils.ts`:
   - Export types: `AgentTemplate`, `SubagentDelegation`, `SubagentState`, `PlanStepInfo`, `PlanModeInfo`, `WorkflowConfig`
   - Export helpers: `getAgents()`, `cleanTaskText()`, `getNextSubagentId()`, `formatDelegationList()`, `extractPlanModeInfo()`, `makeSessionFile()`

4. **Register tools** using `pi.registerTool()` with proper parameter schemas using `TypeBox` types.

5. **Register commands** using `pi.registerCommand()` for `/` commands.

6. **Register keyboard shortcuts** using `pi.registerShortcut()` with `Key.ctrlAlt("key")` pattern.

7. **Add lifecycle hooks**:
   - `pi.on("session_start", ...)` - Restore state on session start
   - `pi.on("before_agent_start", ...)` - Inject guidance before agent turn
   - `pi.on("agent_end", ...)` - Handle plan creation/completion dialogs
   - `pi.on("tool_call", ...)` - Block/modify tool calls
   - `pi.on("context", ...)` - Clean stale context messages

8. **Persist state** using `pi.appendEntry()` for session persistence.

9. **Test your extension** by starting Pi and verifying all registered features work correctly.

### Extension Integration Points

- **plan-mode integration**: Use `extractPlanModeInfo(entries)` to read plan state, `updatePlanStepStatus(step, action, ctx)` to sync plan steps
- **subagent integration**: Use `getAgents(ctx.cwd)` to discover agent templates, `formatDelegationList(delegations)` to display delegations
- **Shared state**: Both extensions use `pi.appendEntry()` and `ctx.sessionManager.getEntries()` for state persistence

### Adding a New Specialist Agent

1. Create a markdown file in `.pi/agents/`:
   ```markdown
   ---
   name: specialist-name
   description: Brief description
   ---
   ## Role
   Your role description here.
   ## Rules
   - Rule 1
   - Rule 2
   ```

2. The agent templates are automatically discovered by `getAgents()` and listed in the `/subagent roles` command and subagent tool descriptions.

