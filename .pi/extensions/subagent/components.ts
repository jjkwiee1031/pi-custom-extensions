/**
 * TUI components for subagent extension.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { SubagentDelegation } from "./index.ts";

/**
 * Interactive TUI component to view subagent delegations.
 */
export class SubagentListComponent {
	private delegations: SubagentDelegation[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(delegations: SubagentDelegation[], theme: Theme, onClose: () => void) {
		this.delegations = delegations;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, "escape") ||
			matchesKey(data, "ctrl+c") ||
			matchesKey(data, "enter") ||
			data === "q"
		) {
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
		const title = th.fg("accent", " 🤖 Subagent Delegations ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) +
			title +
			th.fg("borderMuted", "─".repeat(Math.max(0, width - 28)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.delegations.length === 0) {
			lines.push(
				truncateToWidth(
					`  ${th.fg("dim", "No active subagent delegations. Spawn one with /subagent")}`,
					width,
				),
			);
		} else {
			const activeCount = this.delegations.filter((d) => d.status === "in_progress").length;
			const doneCount = this.delegations.filter((d) => d.status === "completed").length;
			const total = this.delegations.length;

			lines.push(
				truncateToWidth(
					`  ${th.fg("muted", `Total: ${total} • `)}${th.fg("warning", `${activeCount} in progress`)}${th.fg("muted", ` • `)}${th.fg("success", `${doneCount} completed`)}`,
					width,
				),
			);
			lines.push("");

			for (const d of this.delegations) {
				let icon = th.fg("dim", "○");
				let taskText = th.fg("text", d.task);

				if (d.status === "completed") {
					icon = th.fg("success", "✓");
					taskText = th.fg("dim", th.strikethrough(d.task));
				} else if (d.status === "in_progress") {
					icon = th.fg("warning", "▶");
					taskText = th.bold(th.fg("accent", d.task));
				}

				const idTag = th.fg("dim", `#${d.id}`);
				const roleTag = d.role ? th.fg("dim", ` [${d.role}]`) : "";
				const stepTag = d.step !== undefined ? th.fg("dim", ` (Step #${d.step})`) : "";
				lines.push(truncateToWidth(`  ${icon} ${idTag}${roleTag} ${taskText}${stepTag}`, width));

				if (d.instructions) {
					lines.push(
						truncateToWidth(`      ${th.fg("dim", `↳ ${d.instructions}`)}`, width),
					);
				}
			}
		}

		lines.push("");
		lines.push(
			truncateToWidth(`  ${th.fg("dim", "Press Escape, Enter, or 'q' to close")}`, width),
		);
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
