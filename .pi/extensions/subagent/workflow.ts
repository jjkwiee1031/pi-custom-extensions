/**
 * Workflow pipeline execution for multi-agent sequences.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawnChildProcess } from "./process.ts";
import {
	getNextSubagentId,
	makeSessionFile,
	type AgentTemplate,
	type SubagentDelegation,
	type WorkflowConfig,
} from "./utils.ts";

/**
 * Loads a workflow definition from a JSON file.
 */
export function loadWorkflowFile(filePath: string): WorkflowConfig {
	const resolved = path.resolve(filePath);
	const raw = fs.readFileSync(resolved, "utf8");
	const data = JSON.parse(raw);
	return {
		agents: Array.isArray(data.agents) ? data.agents : [],
		workflowCurrentIndex: 0,
		context: undefined,
	};
}

export interface WorkflowRunOptions {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	task: string;
	workflow: WorkflowConfig;
	delegations: SubagentDelegation[];
	agentTemplates: AgentTemplate[];
	onUpdate: () => void;
}

/**
 * Runs a multi-agent workflow sequentially through its defined agents.
 */
export async function executeWorkflow(options: WorkflowRunOptions): Promise<string> {
	const { pi, ctx, task, workflow, delegations, agentTemplates, onUpdate } = options;

	if (workflow.agents.length === 0) {
		throw new Error("No workflow loaded. Load a workflow definition first.");
	}

	workflow.workflowCurrentIndex = 0;
	workflow.context = "";

	for (let i = 0; i < workflow.agents.length; i++) {
		const agentRole = workflow.agents[i];
		workflow.workflowCurrentIndex = i;

		ctx.ui.notify(
			`🤖 Workflow step ${i + 1}/${workflow.agents.length}: Running ${agentRole}...`,
			"info",
		);

		const id = getNextSubagentId(delegations);
		const parentSession = ctx.sessionManager.getSessionFile();
		const sessionFile = makeSessionFile(parentSession, id);
		const fullTask = workflow.context
			? `Previous agent output:\n${workflow.context}\n\nTask:\n${task}`
			: task;

		const delegation: SubagentDelegation = {
			id,
			task: `Workflow step ${i + 1}: ${agentRole} — ${task}`,
			role: agentRole,
			status: "in_progress",
			sessionFile,
			createdAt: Date.now(),
		};

		delegations.push(delegation);
		onUpdate();

		let childResult: string;
		try {
			childResult = await spawnChildProcess(ctx, { ...delegation, task: fullTask }, agentTemplates);
		} catch (err) {
			childResult = `Error: ${err}`;
			ctx.ui.notify(`Workflow failed at step ${i + 1} (${agentRole}): ${err}`, "error");
			delegation.status = "completed";
			delegation.completedAt = Date.now();
			onUpdate();
			break;
		}

		delegation.status = "completed";
		delegation.completedAt = Date.now();
		workflow.context = childResult;
		onUpdate();
	}

	pi.sendMessage(
		{
			customType: "workflow-result",
			content: `Workflow complete (${workflow.agents.length} agents).\n\nFinal result:\n${workflow.context}`,
			display: true,
		},
		{ triggerTurn: true, deliverAs: "followUp" },
	);

	ctx.ui.notify("🤖 Workflow complete!", "info");
	return workflow.context ?? "";
}
