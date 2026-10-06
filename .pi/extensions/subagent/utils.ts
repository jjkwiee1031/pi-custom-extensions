/**
 * Pure utility functions and types for subagent delegations, specialist agents, and plan-mode integration.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type SubagentStatus = "in_progress" | "completed";

export interface AgentTemplate {
	name: string;
	desc: string;
	body: string;
}

export interface SubagentDelegation {
	id: number;
	task: string;
	instructions?: string;
	role?: string;
	step?: number;
	status: SubagentStatus;
	sessionFile?: string;
	createdAt: number;
	completedAt?: number;
}

export interface SubagentState {
	delegations: SubagentDelegation[];
}

export interface PlanStepInfo {
	step: number;
	text: string;
	status?: "pending" | "in_progress" | "completed";
	completed?: boolean;
}

export interface PlanModeInfo {
	enabled: boolean;
	executing?: boolean;
	todos: PlanStepInfo[];
	activeStep?: PlanStepInfo;
}

export interface WorkflowConfig {
	agents: string[];
	workflowCurrentIndex: number;
	context?: string;
}

/**
 * Normalizes and trims task description text.
 */
export function cleanTaskText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove markdown formatting
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	return cleaned;
}

/**
 * Calculates the next available subagent ID.
 */
export function getNextSubagentId(delegations: SubagentDelegation[]): number {
	if (delegations.length === 0) return 1;
	const maxId = Math.max(...delegations.map((d) => d.id));
	return maxId + 1;
}

/**
 * Finds a delegation by ID, or returns the most recent in-progress delegation if no ID is specified.
 */
export function findDelegation(
	delegations: SubagentDelegation[],
	id?: number,
): SubagentDelegation | undefined {
	if (id !== undefined) {
		return delegations.find((d) => d.id === id);
	}
	const active = delegations.filter((d) => d.status === "in_progress");
	if (active.length > 0) {
		return active[active.length - 1];
	}
	return delegations[delegations.length - 1];
}

/**
 * Returns all currently active delegations.
 */
export function getActiveDelegations(delegations: SubagentDelegation[]): SubagentDelegation[] {
	return delegations.filter((d) => d.status === "in_progress");
}

/**
 * Formats a list of delegations for display.
 */
export function formatDelegationList(delegations: SubagentDelegation[]): string {
	if (delegations.length === 0) {
		return "No sub-agent delegations in this session.";
	}

	return delegations
		.map((d) => {
			const statusMarker = d.status === "completed" ? "[COMPLETED]" : "[IN PROGRESS]";
			const roleMarker = d.role ? ` (Role: ${d.role})` : "";
			const stepMarker = d.step !== undefined ? ` (Linked to Plan Step #${d.step})` : "";
			const instructions = d.instructions ? `\n    Instructions: ${d.instructions}` : "";
			const sessionFile = d.sessionFile ? `\n    Session: ${d.sessionFile}` : "";
			return `#${d.id} ${statusMarker}: ${d.task}${roleMarker}${stepMarker}${instructions}${sessionFile}`;
		})
		.join("\n");
}

/**
 * Inspects session custom entries to extract plan-mode state and the current active step.
 */
export function extractPlanModeInfo(
	entries: Array<{ type: string; customType?: string; data?: any }>,
): PlanModeInfo | undefined {
	const planEntry = [...entries]
		.reverse()
		.find((e) => e.type === "custom" && e.customType === "plan-mode");

	if (!planEntry || !planEntry.data) {
		return undefined;
	}

	const data = planEntry.data;
	const todos: PlanStepInfo[] = Array.isArray(data.todos) ? data.todos : [];
	const activeStep =
		todos.find((t) => t.status === "in_progress") ??
		todos.find((t) => !t.completed);

	return {
		enabled: Boolean(data.enabled),
		executing: Boolean(data.executing),
		todos,
		activeStep,
	};
}

/**
 * Discovers and parses specialist agent definition markdown files from `.pi/agents/*.md`.
 */
export function getAgents(baseDir: string = process.cwd()): AgentTemplate[] {
	const dir = path.join(baseDir, ".pi", "agents");
	try {
		if (!fs.existsSync(dir)) return [];
		const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
		const results: AgentTemplate[] = [];

		for (const f of files) {
			const raw = fs.readFileSync(path.join(dir, f), "utf8");
			const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
			if (match) {
				const front = match[1];
				const nameMatch = front.match(/name:\s*(.+)/);
				const descMatch = front.match(/description:\s*(.+)/);
				if (nameMatch) {
					results.push({
						name: nameMatch[1].trim(),
						desc: descMatch ? descMatch[1].trim() : "",
						body: match[2].trim(),
					});
				}
			}
		}
		return results;
	} catch {
		return [];
	}
}

/**
 * Creates an isolated subagent session file beside the parent session file.
 */
export function makeSessionFile(sessionFile: string, id: string | number): string {
	try {
		const sessionDir = path.dirname(sessionFile);
		const sessionName = path.basename(sessionFile, path.extname(sessionFile));
		const subagentDir = path.join(sessionDir, sessionName);

		fs.mkdirSync(subagentDir, { recursive: true });
		return path.join(subagentDir, `subagent-${id}-${Date.now()}.jsonl`);
	} catch {
		// Fallback to tmp directory if session file path cannot be resolved
		const tmpDir = path.join(process.cwd(), ".pi", "subagents");
		fs.mkdirSync(tmpDir, { recursive: true });
		return path.join(tmpDir, `subagent-${id}-${Date.now()}.jsonl`);
	}
}
