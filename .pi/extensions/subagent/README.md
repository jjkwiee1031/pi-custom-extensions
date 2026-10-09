# Subagent Extension for Pi

A standalone extension that lets the agent **delegate sub-tasks to a sub-agent turn** in isolated child `pi` processes, seamlessly adapting to the `plan-mode` todo list extension.

## Features

- **Lean `subagent` tool**: Direct, actionless tool invocation `{ task, role?, instructions?, step? }`.
- **Todo List Adaptation**: Link a subagent call to a `plan-mode` todo step (`step`) to automatically advance step status from `start` to `done`.
- **Process Management & Cancellation**: Spawns isolated child `pi` processes with `AbortSignal` cancellation support and `stderr` diagnostics.
- **Dedicated Commands**: Full terminal control with `/subagent`, `/sub-switch`, `/sub-return`, and `/workflow`.
- **State persistence**: Delegations persist across session restarts and branch switches.
- **2-File Architecture**: Clean separation between core logic (`index.ts`) and terminal UI modal (`components.ts`).

---

## Tool: `subagent`

```typescript
{
  task: string;           // sub-agent task description (required)
  role?: string;          // specialist agent role from .pi/agents/*.md
  instructions?: string;  // optional extra guidance
  step?: number;          // optional plan-mode todo step number to link
}
```

### Usage

The agent delegates a sub-task directly:

```json
{
  "task": "Write the user-facing greeting component",
  "role": "worker",
  "instructions": "Use Tailwind CSS and keep it under 200 lines."
}
```

When linked to a plan-mode step:

```json
{
  "task": "Write unit tests for authentication service",
  "step": 3
}
```

The extension automatically calls `todo(action: "start", id: 3)` before execution and `todo(action: "done", id: 3)` upon completion.

---

## Commands

| Command | Description |
|---|---|
| `/subagent` | Prompt interactively for a task. |
| `/subagent <task>` | Start a sub-agent turn with the given task. |
| `/subagent <role> <task>` | Start a sub-agent turn using a specialist role (e.g., `planner`, `worker`). |
| `/subagent list` | View sub-agent delegations (interactive TUI card or text). |
| `/subagent clear` | Clear all sub-agent delegation state. |
| `/subagent roles` | List available specialist roles from `.pi/agents/*.md`. |
| `/sub-switch <role or #id>` | Switch to a sub-agent's session transcript. |
| `/sub-return` | Return to the parent session transcript. |
| `/workflow load <file>` | Load a multi-agent workflow pipeline (e.g. `workflow.json`). |
| `/workflow run <task>` | Sequentially execute the loaded multi-agent pipeline. |

## Keyboard Shortcut

- `Ctrl+Alt+S` — Start a sub-agent turn interactively.

## Architecture

| File | Purpose |
|---|---|
| `index.ts` | Core extension: tool registration, child process spawning, workflow engine, commands, and hooks. |
| `components.ts` | Interactive TUI modal component (`SubagentListComponent`). |
