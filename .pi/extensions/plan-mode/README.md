# Plan Mode Extension for Pi

A read-only exploration and planning extension for Pi agent with **tool-driven Todo List execution tracking**.

## Features

- **Read-Only Exploration**: Built-in file editing/writing tools (`edit`, `write`) are disabled when plan mode is active to prevent accidental changes while researching.
- **Safe Command Allowlist**: Restricts `bash` tool execution to read-only inspection commands (`cat`, `grep`, `find`, `ls`, `git status`, `git diff`, etc.) while intercepting and blocking modification commands (`rm`, `mv`, `git commit`, `npm install`, etc.).
- **Plan Extraction**: Intelligently parses numbered steps from markdown `Plan:` sections produced by the agent.
- **Interactive Plan Transition**: Prompts you with actions when a plan is ready:
  - *Execute the plan (track progress)*
  - *Stay in plan mode*
  - *Refine the plan*
- **Strictly Tool-Driven Execution Tracking**:
  - **Tool-Only Modifications**: The agent must call the registered `todo` tool to modify the checklist (`start`, `done`, `add`, `set`, etc.). Text tag markers in replies are disabled.
  - **Explicit Next-Tool Guidance**: Every prompt and `todo` tool result provides clear instructions advising the agent on exactly which tool to call next at each phase of execution.
  - **Live Checklist Widget**: Positioned above the prompt editor, displaying live progress:
    - `☑ 1. Step text` (completed, strikethrough)
    - `▶ 2. Step text` (in progress, highlighted)
    - `☐ 3. Step text` (pending)
  - **Status Bar Indicator**: Real-time ratio and percentage (e.g., `📋 2/5 (40%)`).
  - **Interactive `/todos` Modal**: Full TUI overlay to inspect plan progress.
- **Session Persistence**: Saves and restores plan state across session pauses and resumes.

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

```json
{
  "action": "list" | "add" | "start" | "done" | "toggle" | "set" | "clear",
  "id": 1,
  "text": "Task description"
}
```

### Planning Lifecycle with Tool Guidance
1. **Investigation**: The agent uses `read`, `grep`, `find`, `ls`, or read-only `bash` to inspect the code.
2. **Clarification**: If questions arise, the agent uses `ask_questions` or asks in chat.
3. **Establishing the Plan**: Once analysis is complete, the agent calls `todo(action: "set", todos: ["Step 1", "Step 2", ...])`. This initializes the checklist and triggers the user approval prompt.

### Execution Lifecycle with Tool Guidance
1. **Starting a Step**: The agent calls `todo(action: "start", id: 1)`.
   * Return message: Confirms step is in-progress and instructs the agent to call implementation tools (`read`, `edit`, `write`, `bash`).
2. **Implementing the Step**: The agent calls `read`, `edit`, `write`, or `bash`.
3. **Completing a Step**: The agent calls `todo(action: "done", id: 1)`.
   * Return message: Confirms completion and instructs the agent to call `todo(action: "start", id: 2)` for the next pending step.
4. **Adding Discovered Tasks**: The agent calls `todo(action: "add", text: "New task")`.
5. **Finishing All Steps**: Once all steps are marked done, the widget displays completion and prompts the agent to summarize final results.

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
