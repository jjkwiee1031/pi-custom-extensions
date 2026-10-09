---
name: subagent-delegation
description: Guidelines on when and how to delegate complex, multi-step, research, or isolated tasks to specialist subagents to protect context window size.
---

# Subagent Delegation Skill

## Core Principles
1. **Context Window Preservation**: Do not perform long exploratory searches, verbose test executions, or large multi-step plans directly in the primary conversation context when they can be delegated.
2. **Specialist Execution**: Use the `subagent` tool to run tasks in isolated child processes with their own clean context windows and session files.
3. **Concise Context Handoff**: If necessary, provide the subagent with the current big picture (e.g., what previous subagents accomplished or relevant prior findings). Keep this summary concise to ensure clear alignment without bloating the subagent's context.

## When to Delegate
Delegate using `subagent(task: "...", role?: "...", step?: ...)` whenever you encounter:
- **Multi-step implementations or plans**: Delegate distinct steps or components to subagents sequentially or by topic.
- **Deep codebase research / wide searches**: Large file scans or greps that generate high token output.
- **Running test suites or debugging logs**: Isolate verbose test outputs and build logs.
- **Independent sub-tasks**: Self-contained tasks like writing documentation, unit tests, or refactoring a single file.

## Available Specialist Roles
- **planner**: High-level task breakdown, architectural planning, dependency mapping.
- **worker**: Focused code implementation, refactoring, and bug fixes.
