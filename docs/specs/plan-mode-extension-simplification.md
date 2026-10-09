# Plan Mode Extension Simplification Specification

## Problem Statement

The plan-mode extension for the Pi agent currently suffers from architectural fragmentation and unnecessary complexity (~1,120 lines across `index.ts` and `utils.ts`). Specific issues include:

- **Dual-path plan approval & brittle heuristics**: Plan creation has two conflicting paths: an explicit tool call `todo(action: "set")` and an invasive `agent_end` hook that scrapes Markdown text using regex heuristics (`Implementation Plan:`, numbered list regexes, checking if the assistant is asking a question via punctuation or keywords). This required fragile synchronization state (`planPromptedInThisTurn`) and frequently caused unexpected or duplicate user prompts.
- **Inconsistent file structure**: While WhatsApp and Subagent extensions follow a clean 2-file structure (`index.ts` for core extension and `components.ts` for interactive TUI components), plan-mode placed its interactive TUI modal inline inside `index.ts` while keeping small regex lists in a separate `utils.ts`.
- **Bloated tool schema**: The `todo` tool exposed redundant actions (`toggle`), complicating LLM prompt contracts.
- **Runtime shortcut bug**: Registering `Key.ctrlAlt("p")` unconditionally crashes at runtime because `@earendil-works/pi-tui` does not implement `Key.ctrlAlt`.

The goal is to provide a lean, robust, cohesive 2-file architecture (`index.ts` and `components.ts`) that strictly enforces tool-driven plan creation, streamlines the `todo` tool interface, preserves command ergonomics, fixes shortcut registration, and ensures seamless interoperability with the subagent extension.

## Solution

Consolidate and streamline the plan-mode extension into a cohesive two-component architecture:

1. **Extension Core (`index.ts`)**: Encapsulates plan mode toggling, safe read-only bash validation, tool registration for the streamlined `todo` tool, interactive user approval dialogs, dedicated slash commands (`/plan` and `/todos`), guarded `Ctrl+Alt+P` shortcut, and session lifecycle hooks.
2. **Interactive TUI Modal (`components.ts`)**: Encapsulates the dedicated terminal modal (`TodoListComponent`) for `/todos`.

The standalone `utils.ts` is eliminated and consolidated directly into `index.ts`. Brittle regex text-scraping and heuristic question guessing in `agent_end` are removed.

## User Stories

1. As a user, I want plan mode to disable file-modifying tools (`edit`, `write`) and unsafe bash commands (`rm`, `git commit`, `chmod`, etc.) so that the agent safely explores the codebase in read-only mode.
2. As a user, I want the agent to present plan steps via the `todo` tool so that I receive an interactive approval dialog (`Execute`, `Stay in plan mode`, `Refine`) without unexpected duplicate prompts.
3. As a user, I want to track active plan progress in a live editor widget and status bar indicator.
4. As a user, I want an interactive TUI checklist accessible via `/todos` to view and review plan steps.
5. As a user, I want to manually manage plan steps using `/todos [done <n>|start <n>|add <text>|clear]`.
6. As a user, I want to toggle plan mode using `/plan [on|off|clear]` and the `Ctrl+Alt+P` keyboard shortcut.
7. As an AI agent, I want a clean, focused `todo` tool (`set`, `start`, `done`, `add`, `list`, `clear`) with explicit guidance on which tool to call next.
8. As a subagent extension, I want `todo` to accept `{ action: "start", id: <n> }` and `{ action: "done", id: <n> }` so that delegated tasks stay synchronized with the active plan.
9. As a developer, I want all logic contained in two cohesive files (`index.ts` and `components.ts`) for maximum maintainability.

## Implementation Decisions

### 1. Two-File Architecture
- **`components.ts`**: Contains `TodoListComponent` implementing the Pi TUI component lifecycle (`render`, `handleInput`, `invalidate`).
- **`index.ts`**: Contains all extension lifecycle hooks, state persistence, safe command allowlisting, slash commands, and the `todo` tool.
- Remove `utils.ts` by integrating safe command evaluation directly into `index.ts`.

### 2. Strictly Tool-Driven Plan Lifecycle
- Remove the regex-based `agent_end` text parser, question-guessing regexes, and `planPromptedInThisTurn` flags.
- The plan is established exclusively when the LLM calls `todo(action: "set", todos: [...])`.
- Calling `todo(action: "set")` validates the steps and immediately presents the user approval modal in interactive mode (`Execute`, `Stay in plan mode`, `Refine`).

### 3. Streamlined `todo` Tool Contract
- Supported actions:
  - `set`: Initializes the plan with an array of task descriptions and prompts user approval.
  - `start`: Marks a step as in-progress by `id` (advances widget to `▶`).
  - `done`: Marks a step as completed by `id` (advances widget to `☑`).
  - `add`: Appends a newly discovered task to the plan by `text`.
  - `list`: Returns the current checklist and explicit guidance on the next tool to call.
  - `clear`: Resets all active plan todos.
- Redundant action `toggle` is removed.

### 4. Robust Safe Bash Allowlist
- Fast allowlist matching safe read-only inspection commands (`cat`, `grep`, `find`, `ls`, `git status`, `git log`, `git diff`, etc.).
- Fast denylist blocking destructive commands (`rm`, `mv`, `cp`, `git commit`, `sudo`, redirects `>`, etc.).
- Unsafe commands are blocked with a clear diagnostic message explaining that plan mode is active.

### 5. Slash Commands & Shortcuts
- `/plan`:
  - `/plan`: Toggles plan mode on/off.
  - `/plan on`: Explicitly activates plan mode.
  - `/plan off`: Explicitly deactivates plan mode.
  - `/plan clear` (or `reset`): Clears todos, deactivates plan mode, and restores normal tools.
- `/todos`:
  - `/todos`: Opens interactive TUI modal (`TodoListComponent`) or prints checklist.
  - `/todos done <n>` (or `check <n>`): Marks step `<n>` done.
  - `/todos start <n>`: Marks step `<n>` in-progress.
  - `/todos add <text>`: Appends a step.
  - `/todos clear`: Clears all plan todos.
- `Ctrl+Alt+P`: Shortcut safely registered with fallback to string `"ctrl+alt+p"`.

## Testing Decisions

### Target Testing Seams
- Unit tests for `isSafeCommand` allowlist and denylist.
- Unit tests for step text cleaning (`cleanStepText`).
- Integration tests with mock `ExtensionAPI` exercising:
  - Tool blocking in plan mode (`edit`, `write`, unsafe `bash`).
  - Tool schema for `todo` (verifying `toggle` removed, `start`/`done` retained).
  - Tool execution for `set`, `start`, `done`, `add`, `list`, `clear`.
  - Slash command routing for `/plan` and `/todos`.
  - Session state persistence and restoration across session starts.
  - `TodoListComponent` rendering and keyboard input handling.

## Out of Scope
- Arbitrary bash sandbox virtualisation (we rely on regex allowlisting/denylisting).
- Modifying built-in agent prompt structures outside of `before_agent_start` context injection.
