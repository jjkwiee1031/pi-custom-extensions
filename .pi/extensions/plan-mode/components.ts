/**
 * TUI components for plan-mode extension.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { TodoItem } from "./index.ts";

/**
 * Interactive TUI component for /todos
 */
export class TodoListComponent {
	private todos: TodoItem[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: TodoItem[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter") || data === "q") {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Plan Execution Todos ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 26)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No active plan todos. Create a plan with /plan")}`, width));
		} else {
			const done = this.todos.filter((t) => t.completed).length;
			const inProg = this.todos.filter((t) => t.status === "in_progress").length;
			const total = this.todos.length;
			const percent = Math.round((done / total) * 100);

			let summary = `  ${th.fg("muted", `${done}/${total} completed (${percent}%)`)}`;
			if (inProg > 0) {
				summary += th.fg("warning", ` • ${inProg} in progress`);
			}
			lines.push(truncateToWidth(summary, width));
			lines.push("");

			for (const todo of this.todos) {
				let icon = th.fg("dim", "○");
				let itemText = th.fg("text", todo.text);

				if (todo.completed) {
					icon = th.fg("success", "✓");
					itemText = th.fg("dim", th.strikethrough(todo.text));
				} else if (todo.status === "in_progress") {
					icon = th.fg("warning", "▶");
					itemText = th.bold(th.fg("accent", todo.text));
				}

				const id = th.fg("dim", `#${todo.step}`);
				lines.push(truncateToWidth(`  ${icon} ${id} ${itemText}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape, Enter, or 'q' to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
