/**
 * Subprocess execution for isolated subagents in Pi.
 */

import { spawn } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentTemplate, SubagentDelegation } from "./utils.ts";

/**
 * Returns a formatted list of available agent roles.
 */
export function getAvailableRolesDescription(agentTemplates: AgentTemplate[]): string {
	if (agentTemplates.length === 0) return "No specialist agents found.";
	return agentTemplates
		.map((a) => `- ${a.name}: ${a.desc}`)
		.join("\n");
}

/**
 * Spawns a child `pi` process with the given task and optional specialist role.
 * Returns the child's final text output.
 */
export function spawnChildProcess(
	_ctx: ExtensionContext,
	delegation: SubagentDelegation,
	agentTemplates: AgentTemplate[],
): Promise<string> {
	const agent = delegation.role
		? agentTemplates.find((a) => a.name === delegation.role)
		: undefined;

	const systemPrompt = agent?.body ?? "You are a specialist agent. Complete the delegated task thoroughly.";
	const sessionFile = delegation.sessionFile ?? "";

	const childArgs = [
		"--mode", "json",
		"--system-prompt", systemPrompt,
		...(sessionFile ? ["--session", sessionFile] : []),
		"--tools", "read,bash,edit,write,grep,find,ls",
		"-p",
		delegation.instructions
			? `${delegation.task}\n\nAdditional instructions: ${delegation.instructions}`
			: delegation.task,
	];

	const child = spawn("pi", childArgs, {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env },
	});

	return new Promise((resolve, reject) => {
		let buffer = "";
		let result = "";

		child.stdout?.setEncoding("utf8");

		child.stdout?.on("data", (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line);
					if (
						event.type === "message_update" &&
						event.assistantMessageEvent?.type === "text_delta"
					) {
						result += event.assistantMessageEvent.delta;
					}
				} catch {
					// Ignore non-JSON lines
				}
			}
		});

		child.on("close", (code) => {
			const output = result.trim() || `Child process exited with code ${code ?? 0}.`;
			resolve(output);
		});

		child.on("error", (err) => {
			reject(err);
		});
	});
}
