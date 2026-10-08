# Plan Mode Extension for Pi

A read-only exploration and planning extension for Pi agent with **tool-driven Todo List execution tracking**.

## Features

- **Read-Only Exploration**: Built-in file editing/writing tools (`edit`, `write`) are disabled when plan mode is active to prevent accidental changes while researching.
- **Safe Command Allowlist**: Restricts `bash` tool execution to read-only inspection commands (`cat`, `grep`, `find`, `ls`, `git status`, `git diff`, etc.) while intercepting and blocking modification commands (`rm`, `mv`, `git commit`, `npm install`, etc.).
- **Strictly Tool-Driven Execution Tracking**:
  - The agent initializes the plan by calling `todo(action: "set", todos: [...])`.
  - Prompts you interactively with approval choices: *Execute the plan*, *Stay in plan mode*, or *Refine the plan*.
  - Live checklist widget and status bar indicator (`📋 2/5 (40%)`) track active progress.
  - Interactive `/todos` TUI modal to review the checklist.
- **Session Persistence**: Saves and restores plan state across session pauses and resumes.
- **2-File Architecture**: Clean modularity between core logic (`index.ts`) and interactive TUI components (`components.ts`).

---

## Commands & Shortcuts

### User Commands

| Command | Description |
|---|---|
| `/plan` | Toggle plan mode on/off |
| `/plan on` | Explicitly enable plan mode |
| `/plan off` | Explicitly disable plan mode |
| `/plan clear` (or `reset`) | Clear all todos, restore normal mode, and reset status |
| `/todos` | Open the interactive Todo List overlay (or view list) |
| `/todos done <n>` (or `check <n>`) | Manually mark step `#<n>` as completed |
| `/todos start <n>` | Manually mark step `#<n>` as in progress |
| `/todos add <text>` | Manually append a new step to the active plan |
| `/todos clear` | Clear all active plan todos |

### Keyboard Shortcut

- `Ctrl+Alt+P` — Toggle plan mode in the interactive TUI.

### CLI Flag

- `pi --plan` — Start Pi directly in plan mode:
  ```bash
  pi --plan "Audit the repository and plan TypeScript migration"
  ```

---

## Agent `todo` Tool

When executing a plan, the agent modifies the checklist by calling the `todo` tool:

```typescript
{
  action: "list" | "add" | "start" | "done" | "set" | "clear";
  id?: number;          // step number (for start, done)
  text?: string;        // task description (for add)
  todos?: string[];     // array of step descriptions (for set)
}
```

### Lifecycle with Tool Guidance
1. **Investigation**: The agent uses `read`, `grep`, `find`, `ls`, or read-only `bash` to inspect the code safely.
2. **Establishing the Plan**: Once analysis is complete, the agent calls `todo(action: "set", todos: ["Step 1", "Step 2", ...])`. This initializes the checklist and triggers user approval.
3. **Starting a Step**: The agent calls `todo(action: "start", id: 1)`.
4. **Implementing the Step**: The agent uses `read`, `edit`, `write`, or `bash`. Subagent extension can also advance steps automatically via `subagent(task: "...", step: 1)`.
5. **Completing a Step**: The agent calls `todo(action: "done", id: 1)`.
6. **Adding Discovered Tasks**: The agent calls `todo(action: "add", text: "New task")`.
7. **Finishing All Steps**: Once all steps are marked done, the widget displays completion and prompts the agent to summarize final results.

---

## Allowed vs Blocked Commands in Plan Mode

### Safe Read-Only Commands
- **File inspection**: `cat`, `head`, `tail`, `less`, `more`, `bat`
- **Search**: `grep`, `find`, `rg`, `fd`, `awk`, `sed -n`
- **Directory**: `ls`, `pwd`, `tree`, `du`, `df`, `stat`, `file`
- **Git read**: `git status`, `git log`, `git diff`, `git branch`, `git show`, `git remote`
- **Package & System info**: `npm list`, `yarn list`, `node -v`, `uname`, `whoami`, `date`

### Blocked Operations
- **File modifications**: `rm`, `rmdir`, `mv`, `cp`, `mkdir`, `touch`, `chmod`, `chown`, redirects (`>`, `>>`)
- **Package alterations**: `npm install`, `npm uninstall`, `yarn add`, `pip install`, `brew install`
- **Git modifications**: `git add`, `git commit`, `git push`, `git checkout`, `git reset`, `git merge`
- **System changes**: `sudo`, `reboot`, `shutdown`, `systemctl`, `kill`

---

## Architecture

| File | Purpose |
|---|---|
| `index.ts` | Core extension: tool registration, plan mode tool toggle, safe bash interception, slash commands, and hooks. |
| `components.ts` | Interactive TUI modal component (`TodoListComponent`). |
