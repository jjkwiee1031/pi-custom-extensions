# Subagent Extension for Pi

A standalone extension that lets the agent **delegate sub-tasks to a sub-agent turn**, optionally linking the delegation to an active `plan-mode` todo step so progress stays in sync.

## Features

- **`subagent` tool**: The LLM calls `subagent` to hand a sub-task to a sub-agent turn.
- **Plan-mode integration**: Link a subagent call to a `plan-mode` todo step (`step`), so the step is auto-marked in-progress/completed as the sub-agent work proceeds.
- **`/subagent` command**: Manually spawn a sub-agent turn for a step without an LLM tool call.
- **State tracking**: Each sub-agent delegation is stored in the session so delegations survive pauses/resumes and branch correctly.
- **Independent of plan mode**: Works without `plan-mode` installed; when both are installed, the two track each other's state.

---

## Tool: `subagent`

```typescript
{
  "action": "start" | "done",
  "subagentId": number,
  "step": number,        // optional: plan-mode step to link
  "task": string,        // sub-agent task description
  "instructions": string // optional extra guidance
}
```

Actions:

| Action | Description |
|---|---|
| `start` | Spawn a sub-agent turn for `task`. If `step` is provided, the plan-mode step is marked in-progress. |
| `done` | Report sub-agent completion. If `step` is provided, the linked plan-mode step is marked completed. |
| `list` | List all sub-agent delegations for the current session. |
| `delegate` | (Convenience) Start a sub-agent turn **and** link it to the currently active plan-mode step. |

### Usage

The agent calls the tool when it wants a sub-agent to work on a piece of the task:

```json
{
  "action": "start",
  "subagentId": 1,
  "task": "Write the user-facing greeting component",
  "instructions": "Use Tailwind CSS and keep it under 200 lines."
}
```

When a plan is active in `plan-mode`, link the delegation to the step being executed:

```json
{
  "action": "start",
  "subagentId": 1,
  "step": 3,
  "task": "Write the user-facing greeting component",
  "instructions": "Use Tailwind CSS and keep it under 200 lines."
}
```

Then, when the sub-agent is finished:

```json
{
  "action": "done",
  "subagentId": 1
}
```

Calling `subagent(action: "delegate")` while a plan step is in-progress spawns the turn and attaches it to that step automatically.

## Commands

| Command | Description |
|---|---|
| `/subagent` | Start a sub-agent turn (prompt for the task). |
| `/subagent <task>` | Start a sub-agent turn with the given task. |
| `/subagent [role] <task>` | Start a sub-agent turn using a specialist role (e.g., `planner`, `worker`). |
| `/subagent list` | List active sub-agent delegations. |
| `/subagent clear` | Clear all sub-agent delegation state. |
| `/subagent roles` | List available specialist roles from `.pi/agents/*.md`. |
| `/sub-switch <role or #id>` | Switch to a sub-agent's session transcript. |
| `/sub-return` | Return to the parent session. |
| `/workflow load <file>` | Load a multi-agent workflow pipeline (e.g. `workflow.json`). |
| `/workflow run <task>` | Sequentially execute the loaded multi-agent pipeline. |

## Keyboard shortcut

- `Ctrl+Alt+S` — Start a sub-agent turn (prompt for the task).

## Dependencies

No npm dependencies required. Reads plan-mode's in-memory state when `plan-mode` is installed; if `plan-mode` is absent, `subagent` degrades gracefully and still functions.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Extension entry point: registrations for tool, commands, shortcut, and lifecycle hooks. |
| `utils.ts` | State helpers, agent discovery (`.pi/agents/*.md`), session file paths, and plan-mode extraction. |
| `process.ts` | Child process spawning (`pi --mode json`) and live stream capture. |
| `workflow.ts` | Sequential multi-agent workflow loading and pipeline runner. |
| `components.ts` | TUI interactive delegation modal (`SubagentListComponent`). |
| `README.md` | This documentation. |
