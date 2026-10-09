# Subagent Extension Simplification Specification

## Problem Statement

The subagent extension for the Pi agent currently suffers from architectural fragmentation and unnecessary complexity (~1,300 lines across 5 files: `index.ts`, `utils.ts`, `process.ts`, `workflow.ts`, and `components.ts`). Specific issues include:

- **Complex multi-action tool schema**: The LLM `subagent` tool uses an action-dispatch pattern (`start`, `done`, `list`, `delegate`) that clutters system prompts and confuses the LLM. In practice, `start` runs to completion and marks the task done, making `done` redundant, `list` unnecessary for an LLM turn, and `delegate` merely an alias for `start` with auto-plan detection.
- **Scattered logic across multiple files**: Execution, process spawning, workflow definitions, utility functions, and command dispatch are spread across separate files, adding boilerplate and cross-import overhead.
- **Unmanaged child processes**: Child `pi` processes ignore `AbortSignal`, leaving orphan subagent processes running in the background if the user cancels or the agent aborts.
- **Silent failure on process exit**: Process error streams (`stderr`) are discarded, making debugging of failed subagent turns difficult.
- **Inconsistent plan-mode synchronization**: Plan-mode todo updates were split across different branches with implicit assumptions.

The goal is to provide a lean, robust, cohesive 2-file architecture (`index.ts` and `components.ts`) that simplifies the LLM tool surface area, ensures robust process lifecycle and cancellation management, preserves multi-agent workflow and session-switching commands, and seamlessly adapts to the `plan-mode` todo list extension.

## Solution

Consolidate and streamline the subagent extension into a focused two-component architecture:

1. **Extension Core (`index.ts`)**: Encapsulates subagent state management, specialist role discovery (`.pi/agents/*.md`), process execution with `AbortSignal` cancellation and `stderr` capture, multi-agent workflow execution, dedicated slash commands (`/subagent`, `/sub-switch`, `/sub-return`, `/workflow`), `Ctrl+Alt+S` shortcut, session lifecycle hooks, and a single, direct LLM tool `subagent`.
2. **Interactive TUI Modal (`components.ts`)**: Retains the dedicated terminal modal (`SubagentListComponent`) for `/subagent list`.

All helper files (`process.ts`, `workflow.ts`, `utils.ts`) are eliminated and consolidated into `index.ts`.

## User Stories

1. As an AI agent, I want a single, direct tool `subagent` with `{ task, role?, instructions?, step? }` so that I can delegate sub-tasks without managing `action: "start" | "done" | "delegate" | "list"` state verbs.
2. As an AI agent, I want to explicitly link a delegation to a plan-mode step via the `step` parameter so that the linked todo item automatically advances from `start` to `done`.
3. As a user, I want cancelling an agent turn to terminate any running child subagent processes immediately so that resources are not leaked.
4. As a user, I want clear error feedback when a child process exits with an error so that I know why a subagent failed.
5. As a user, I want to manage subagent delegations via `/subagent [task|list|clear|roles]` so that I can run or inspect subagent tasks from the terminal.
6. As a user, I want to view active and completed delegations in an interactive TUI modal via `/subagent list`.
7. As a user, I want to inspect a subagent's session transcript using `/sub-switch <agent-name or #id>` and return with `/sub-return`.
8. As a user, I want to execute sequential multi-agent pipelines using `/workflow load <file>` and `/workflow run <task>`.
9. As a user, I want to press `Ctrl+Alt+S` to quickly launch a subagent task.
10. As a developer, I want all extension logic contained within 2 cohesive files (`index.ts` and `components.ts`) for maximum clarity and maintainability.

## Implementation Decisions

### 1. Two-File Architecture
- Consolidate all core logic (`process.ts`, `workflow.ts`, `utils.ts`) into `index.ts`.
- Retain `components.ts` exclusively for the `SubagentListComponent` TUI modal.
- Eliminate circular and cross-file dependencies.

### 2. Streamlined LLM Tool Interface
- The LLM tool `subagent` accepts:
  - `task` (string, required): Sub-agent task description.
  - `role` (string, optional): Specialist agent role parsed from `.pi/agents/*.md`.
  - `instructions` (string, optional): Extra guidance or constraints.
  - `step` (number, optional): Explicit plan-mode todo step number to link.
- Action boilerplate (`action: "start" | "done" | "list" | "delegate"`) is removed.
- Synchronously executes the subagent, updates plan status (if `step` is provided), records delegation lifecycle, and returns the subagent's final response text.

### 3. Plan-Mode Todo List Extension Adaptation
- When `step` is provided:
  - Before child execution: calls `ctx.executeTool("todo", { action: "start", id: step })`.
  - After child completion: calls `ctx.executeTool("todo", { action: "done", id: step })`.
  - Calls degrade gracefully if `plan-mode` is not installed or `executeTool` is unavailable.
- Interactive `/subagent <task>` command detects the current active step in `plan-mode` custom session entries and auto-links it for user convenience.
- UI status bar and widget display linked plan step numbers (`(Plan #X)`).

### 4. Child Process Management & Resilience
- Spawns child `pi` processes with `--mode json`, `--system-prompt`, and `-p <task>`.
- Supports `AbortSignal`: binds abort listener to call `child.kill("SIGTERM")` immediately.
- Collects `stderr` and incorporates it into error responses if the process exits with a non-zero code.
- Captures streaming JSON `message_update` events for assistant text deltas.

### 5. Slash Commands & Shortcuts Retained
- `/subagent`:
  - `/subagent` (without args): prompts interactively.
  - `/subagent <task>`: runs subagent.
  - `/subagent <role> <task>`: runs subagent with specialist role.
  - `/subagent list`: opens TUI modal in TUI mode or displays formatted list.
  - `/subagent clear`: clears delegations and updates widgets.
  - `/subagent roles`: displays discovered agent roles from `.pi/agents/*.md`.
- `/sub-switch <query>`: switches session to child session file.
- `/sub-return`: returns to parent session.
- `/workflow load <file>` and `/workflow run <task>`: multi-agent sequence pipeline.
- `Ctrl+Alt+S`: interactive shortcut.

## Testing Decisions

### What Makes a Good Test
- Tests should verify real behavior at public boundaries:
  - Tool execution runs tasks, parses streamed outputs, and handles errors.
  - Tool execution links to plan-mode step when `step` is provided.
  - Abort signals correctly terminate spawned processes.
  - Commands (`/subagent`, `/sub-switch`, `/sub-return`, `/workflow`) execute and update state properly.
  - Session lifecycle hooks (`session_start`, `before_agent_start`, `context`) restore state and prune context appropriately.

### Target Testing Seam
- Mock `ExtensionAPI` and mock child process spawner / EventEmitter to exercise the extension lifecycle end-to-end without needing real external `pi` binaries or terminal sessions.

## Out of Scope
- Dynamic branching parallel trees (subagents run isolated child turns).
- Modifying underlying `pi` binary CLI options outside existing flags.
