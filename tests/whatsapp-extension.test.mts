/**
 * Comprehensive verification tests for simplified WhatsApp Extension.
 */

import assert from "node:assert";
import whatsappExtension, { formatJid, WhatsAppClient } from "../.pi/extensions/whatsapp-pi/index.ts";
import { WhatsAppStatusComponent } from "../.pi/extensions/whatsapp-pi/components.ts";

console.log("Running comprehensive WhatsApp Extension tests...\n");

// 1. Test formatJid
assert.strictEqual(formatJid("me"), "me");
assert.strictEqual(formatJid("myself"), "me");
assert.strictEqual(formatJid("+1 (555) 123-4567"), "15551234567@s.whatsapp.net");
assert.strictEqual(formatJid("1234567890"), "1234567890@s.whatsapp.net");
assert.strictEqual(formatJid("1234567890@c.us"), "1234567890@s.whatsapp.net");
assert.strictEqual(formatJid("120363028392@g.us"), "120363028392@g.us");
console.log("✔ 1. formatJid unit tests passed");

// 2. Mock Extension API and registration
const registeredTools: any[] = [];
const registeredCommands: Record<string, any> = {};
const registeredFlags: Record<string, any> = {};
const registeredEvents: Record<string, any[]> = {};
const sentMessages: any[] = [];

const mockPi: any = {
	registerTool(tool: any) {
		registeredTools.push(tool);
	},
	registerCommand(name: string, config: any) {
		registeredCommands[name] = config;
	},
	registerFlag(name: string, config: any) {
		registeredFlags[name] = config;
	},
	on(event: string, handler: any) {
		if (!registeredEvents[event]) registeredEvents[event] = [];
		registeredEvents[event].push(handler);
	},
	getFlag(name: string) {
		return registeredFlags[name]?.default;
	},
	sendMessage(msg: any, options: any) {
		sentMessages.push({ msg, options });
	},
};

whatsappExtension(mockPi);

// 3. Verify single tool registration
assert.strictEqual(registeredTools.length, 1, "Only whatsapp_send tool should be registered");
const sendTool = registeredTools[0];
assert.strictEqual(sendTool.name, "whatsapp_send");
assert.strictEqual(sendTool.parameters.properties.to.type, "string");
assert.strictEqual(sendTool.parameters.properties.message.type, "string");
console.log("✔ 2. Single LLM tool 'whatsapp_send' verified");

// 4. Test tool execution when disconnected
const execResult = await sendTool.execute("tc-1", { to: "1234567890", message: "Hello" });
assert.ok(execResult.content[0].text.includes("Error: WhatsApp is not currently connected"));
console.log("✔ 3. Disconnected error handling in whatsapp_send verified");

// 5. Verify slash command registration
assert.ok(registeredCommands["whatsapp"], "/whatsapp command should be registered");
assert.strictEqual(registeredCommands["whatsapp-clear"], undefined, "/whatsapp-clear duplicate command removed");
console.log("✔ 4. Consolidated /whatsapp command verified (no redundant aliases)");

// 6. Test /whatsapp mode command
const mockUi: any = {
	notified: [] as string[],
	notify(msg: string) {
		this.notified.push(msg);
	},
	setStatus() {},
	theme: {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	},
};
const mockCtx: any = {
	ui: mockUi,
	mode: "text",
};

await registeredCommands["whatsapp"].handler("mode auto", mockCtx);
assert.ok(mockUi.notified.some((n: string) => n.includes("relay mode set to: auto")));
console.log("✔ 5. Slash command handler '/whatsapp mode auto' verified");

// 7. Verify TUI Status Component rendering
let closed = false;
const mockClientView = {
	getStatus() {
		return {
			status: "qr_ready" as const,
			userJid: null,
			userName: null,
			authDir: "/tmp/auth",
			currentQrAscii: "████\n████",
		};
	},
};
const comp = new WhatsAppStatusComponent(mockClientView, mockUi.theme, () => {
	closed = true;
});
const renderedLines = comp.render(80);
assert.ok(renderedLines.some((l) => l.includes("Awaiting QR Code Scan")));
assert.ok(renderedLines.some((l) => l.includes("Scan with WhatsApp")));

comp.handleInput("q");
assert.strictEqual(closed, true, "Pressing 'q' should close component");
console.log("✔ 6. WhatsAppStatusComponent rendering and input handling verified");

console.log("\n============================================");
console.log("All WhatsApp Extension tests passed successfully! 🎉");
console.log("============================================");
