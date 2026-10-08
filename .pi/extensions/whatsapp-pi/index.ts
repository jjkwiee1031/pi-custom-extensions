/**
 * WhatsApp Extension for Pi Agent
 *
 * Connects WhatsApp to Pi using Baileys. Enables the agent to send messages and media,
 * provides terminal QR code pairing, footer status indicators, and relays "Note to Self"
 * incoming WhatsApp messages to trigger agent turns remotely.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import makeWASocket, {
	DisconnectReason,
	fetchLatestBaileysVersion,
	generateMessageIDV2,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState,
	type proto,
	type WASocket,
} from "@whiskeysockets/baileys";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { Type, type Static } from "typebox";
import { WhatsAppStatusComponent, type WhatsAppClientView } from "./components.ts";

/**
 * Filter out noisy libsignal terminal leaks (Opening session, pendingPreKey) that corrupt Pi's TUI.
 */
function installLibsignalNoiseFilter(): void {
	const noisyPatterns = ["Opening session:", "Closing session:", "pendingPreKey", "Session already"];
	const wrap = (origWrite: typeof process.stdout.write) => {
		return function (chunk: any, ...args: any[]): boolean {
			const str = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : "";
			if (noisyPatterns.some((pattern) => str.includes(pattern))) {
				return true;
			}
			return (origWrite as any)(chunk, ...args);
		};
	};
	process.stdout.write = wrap(process.stdout.write.bind(process.stdout));
	process.stderr.write = wrap(process.stderr.write.bind(process.stderr));
}

installLibsignalNoiseFilter();

/**
 * Normalizes phone number or raw target into a valid WhatsApp JID.
 */
export function formatJid(target: string): string {
	const trimmed = target.trim();
	if (trimmed.toLowerCase() === "me" || trimmed.toLowerCase() === "myself") {
		return "me";
	}
	if (trimmed.includes("@")) {
		return trimmed.endsWith("@c.us") ? trimmed.replace("@c.us", "@s.whatsapp.net") : trimmed;
	}
	const digits = trimmed.replace(/\D/g, "");
	return digits ? `${digits}@s.whatsapp.net` : trimmed;
}

export type WhatsAppConnectionStatus = "disconnected" | "connecting" | "qr_ready" | "connected";
export type WhatsAppRelayMode = "notify" | "auto" | "off";

export interface IncomingSelfMessage {
	id: string;
	chatJid: string;
	text: string;
	isGroup: boolean;
	timestamp: number;
}

/**
 * Lightweight Baileys connection and socket manager.
 */
export class WhatsAppClient extends EventEmitter implements WhatsAppClientView {
	private sock: WASocket | null = null;
	private authDir: string;
	private status: WhatsAppConnectionStatus = "disconnected";
	private userJid: string | null = null;
	private userName: string | null = null;
	private currentQr: string | null = null;
	private currentQrAscii: string | null = null;
	private reconnectTimeout: NodeJS.Timeout | null = null;
	private intentionalDisconnect = false;
	private sentMessageIds = new Set<string>();
	private messageStore = new Map<string, proto.IMessage>();

	constructor(authDir: string) {
		super();
		this.authDir = authDir;
		if (!fs.existsSync(this.authDir)) {
			fs.mkdirSync(this.authDir, { recursive: true });
		}
	}

	public getStatus() {
		return {
			status: this.status,
			userJid: this.userJid,
			userName: this.userName,
			authDir: this.authDir,
			currentQrAscii: this.currentQrAscii,
		};
	}

	public isConnected(): boolean {
		return this.status === "connected" && this.sock !== null;
	}

	public getQrCode() {
		return { raw: this.currentQr, ascii: this.currentQrAscii };
	}

	public async connect(): Promise<void> {
		if (this.status === "connected" || this.status === "connecting") return;

		this.intentionalDisconnect = false;
		this.setStatus("connecting");

		try {
			const logger = pino({ level: "silent" });
			const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
			const { version } = await fetchLatestBaileysVersion();

			this.sock = makeWASocket({
				version,
				logger,
				auth: {
					creds: state.creds,
					keys: makeCacheableSignalKeyStore(state.keys, logger),
				},
				printQRInTerminal: false,
				generateHighQualityLinkPreview: true,
				syncFullHistory: false,
				getMessage: async (key) => {
					return key.id ? this.messageStore.get(key.id) : undefined;
				},
			});

			this.sock.ev.on("creds.update", saveCreds);

			this.sock.ev.on("connection.update", (update) => {
				const { connection, lastDisconnect, qr } = update;

				if (qr) {
					this.currentQr = qr;
					qrcode.generate(qr, { small: true }, (ascii) => {
						this.currentQrAscii = ascii;
						this.setStatus("qr_ready");
						this.emit("qr", qr, ascii);
					});
				}

				if (connection === "open") {
					this.currentQr = null;
					this.currentQrAscii = null;
					this.userJid = this.sock?.user?.id ?? null;
					this.userName = this.sock?.user?.name ?? null;
					this.setStatus("connected");
					this.emit("connected", { jid: this.userJid ?? "", name: this.userName ?? undefined });
				} else if (connection === "close") {
					const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
					const isLoggedOut = statusCode === DisconnectReason.loggedOut;

					this.userJid = null;
					this.userName = null;
					this.setStatus("disconnected");
					this.emit("disconnected", { statusCode, isLoggedOut });

					if (isLoggedOut) {
						this.cleanAuthDir();
					} else if (!this.intentionalDisconnect) {
						this.scheduleReconnect();
					}
				}
			});

			this.sock.ev.on("messages.upsert", ({ messages }) => {
				for (const raw of messages) {
					this.handleIncomingMessage(raw);
				}
			});
		} catch (err: any) {
			this.setStatus("disconnected");
			this.emit("error", err instanceof Error ? err : new Error(String(err)));
			if (!this.intentionalDisconnect) {
				this.scheduleReconnect();
			}
		}
	}

	private setStatus(newStatus: WhatsAppConnectionStatus): void {
		this.status = newStatus;
		this.emit("statusChange", newStatus);
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
		this.reconnectTimeout = setTimeout(() => {
			if (!this.intentionalDisconnect && this.status !== "connected") {
				this.connect().catch(() => {});
			}
		}, 5000);
	}

	private handleIncomingMessage(raw: proto.IWebMessageInfo): void {
		if (!raw.message || !raw.key) return;

		const id = raw.key.id ?? "";
		if (id && raw.message) {
			this.messageStore.set(id, raw.message);
			if (this.messageStore.size > 200) {
				const oldest = this.messageStore.keys().next().value;
				if (oldest) this.messageStore.delete(oldest);
			}
		}

		// Strictly process messages sent by myself ("Note to Self")
		if (!raw.key.fromMe) return;

		// Ignore messages generated by this agent extension to avoid loops
		if (this.sentMessageIds.has(id)) return;

		const msg = raw.message;
		let text = "";
		if (msg.conversation) {
			text = msg.conversation;
		} else if (msg.extendedTextMessage?.text) {
			text = msg.extendedTextMessage.text;
		} else if (msg.imageMessage?.caption) {
			text = msg.imageMessage.caption;
		} else if (msg.videoMessage?.caption) {
			text = msg.videoMessage.caption;
		} else if (msg.documentMessage?.caption || msg.documentMessage?.fileName) {
			text = msg.documentMessage.caption || `[Document: ${msg.documentMessage.fileName}]`;
		}

		const chatJid = raw.key.remoteJid ?? "";
		const selfMessage: IncomingSelfMessage = {
			id,
			chatJid,
			text: text.trim(),
			isGroup: chatJid.endsWith("@g.us"),
			timestamp: raw.messageTimestamp ? Number(raw.messageTimestamp) * 1000 : Date.now(),
		};

		this.emit("message", selfMessage);
	}

	public async sendTextMessage(to: string, text: string): Promise<{ success: boolean; id?: string; error?: string; toJid?: string }> {
		if (!this.isConnected() || !this.sock) {
			return { success: false, error: "WhatsApp is not connected. Run '/whatsapp connect' in the terminal first." };
		}

		try {
			const jid = formatJid(to);
			const messageId = generateMessageIDV2(this.sock.user?.id);
			this.sentMessageIds.add(messageId);

			const result = await this.sock.sendMessage(jid, { text }, { messageId });
			if (result?.key?.id && result?.message) {
				this.messageStore.set(result.key.id, result.message);
			}

			return { success: true, id: result?.key?.id ?? messageId, toJid: jid };
		} catch (err: any) {
			return { success: false, error: err?.message || String(err) };
		}
	}

	public async sendMediaMessage(
		to: string,
		filePath: string,
		caption?: string,
	): Promise<{ success: boolean; id?: string; error?: string; toJid?: string }> {
		if (!this.isConnected() || !this.sock) {
			return { success: false, error: "WhatsApp is not connected. Run '/whatsapp connect' in the terminal first." };
		}

		const resolvedPath = path.resolve(filePath);
		if (!fs.existsSync(resolvedPath)) {
			return { success: false, error: `File not found at path: ${resolvedPath}` };
		}

		try {
			const jid = formatJid(to);
			const buffer = fs.readFileSync(resolvedPath);
			const ext = path.extname(resolvedPath).toLowerCase();
			const fileName = path.basename(resolvedPath);

			let messageContent: any;
			if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) {
				messageContent = { image: buffer, caption: caption ?? undefined };
			} else if ([".mp4", ".mov", ".mkv", ".avi"].includes(ext)) {
				messageContent = { video: buffer, caption: caption ?? undefined };
			} else if ([".mp3", ".ogg", ".wav", ".m4a"].includes(ext)) {
				messageContent = {
					audio: buffer,
					mimetype: ext === ".mp3" ? "audio/mpeg" : ext === ".ogg" ? "audio/ogg" : "audio/mp4",
				};
			} else {
				messageContent = {
					document: buffer,
					mimetype: "application/octet-stream",
					fileName,
					caption: caption ?? undefined,
				};
			}

			const messageId = generateMessageIDV2(this.sock.user?.id);
			this.sentMessageIds.add(messageId);

			const result = await this.sock.sendMessage(jid, messageContent, { messageId });
			if (result?.key?.id && result?.message) {
				this.messageStore.set(result.key.id, result.message);
			}

			return { success: true, id: result?.key?.id ?? messageId, toJid: jid };
		} catch (err: any) {
			return { success: false, error: err?.message || String(err) };
		}
	}

	public async disconnect(): Promise<void> {
		this.intentionalDisconnect = true;
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}

		if (this.sock) {
			try {
				this.sock.end(undefined);
			} catch {}
			this.sock = null;
		}

		this.setStatus("disconnected");
	}

	public async clearSession(): Promise<void> {
		await this.disconnect();
		this.cleanAuthDir();
	}

	private cleanAuthDir(): void {
		if (fs.existsSync(this.authDir)) {
			try {
				fs.rmSync(this.authDir, { recursive: true, force: true });
				fs.mkdirSync(this.authDir, { recursive: true });
			} catch {}
		}
	}
}

// LLM Tool Schema
export const WhatsAppSendParamsSchema = Type.Object({
	to: Type.String({
		description: "WhatsApp Chat JID or phone number (e.g. '1234567890@s.whatsapp.net', or incoming message chatJid)",
	}),
	message: Type.String({
		description: "Text message content to send",
	}),
	mediaPath: Type.Optional(
		Type.String({
			description: "Optional local file path to an image, video, audio, or document to send as an attachment",
		}),
	),
	caption: Type.Optional(
		Type.String({
			description: "Optional caption for the media attachment",
		}),
	),
});

export type WhatsAppSendParams = Static<typeof WhatsAppSendParamsSchema>;

/**
 * Main WhatsApp Extension Entry Point
 */
export default function whatsappExtension(pi: ExtensionAPI): void {
	const authDir = path.join(process.cwd(), ".pi", "whatsapp_auth");
	const client = new WhatsAppClient(authDir);

	let currentContext: ExtensionContext | null = null;
	let relayMode: WhatsAppRelayMode = "notify";
	let lastQrShown: string | null = null;

	// CLI Flags
	pi.registerFlag("whatsapp", {
		description: "Connect to WhatsApp automatically on agent startup",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("whatsapp-relay", {
		description: "Incoming WhatsApp self-message relay behavior: notify, auto, off",
		type: "string",
		default: "notify",
	});

	function getSafeContext(): ExtensionContext | null {
		if (!currentContext) return null;
		try {
			void currentContext.cwd;
			return currentContext;
		} catch {
			currentContext = null;
			return null;
		}
	}

	function updateStatus(ctx?: ExtensionContext): void {
		const targetCtx = ctx ?? getSafeContext();
		if (!targetCtx) return;

		try {
			const status = client.getStatus();
			if (status.status === "connected") {
				const label = status.userName || (status.userJid ? status.userJid.split("@")[0] : "connected");
				targetCtx.ui.setStatus("whatsapp", targetCtx.ui.theme.fg("success", `[WA: ${label}]`));
			} else if (status.status === "connecting") {
				targetCtx.ui.setStatus("whatsapp", targetCtx.ui.theme.fg("warning", "[WA: connecting]"));
			} else if (status.status === "qr_ready") {
				targetCtx.ui.setStatus("whatsapp", targetCtx.ui.theme.fg("warning", "[WA: scan QR]"));
			} else {
				targetCtx.ui.setStatus("whatsapp", undefined);
			}
		} catch {
			currentContext = null;
		}
	}

	function safeNotify(message: string, type: "info" | "warning" | "error" = "info"): void {
		const ctx = getSafeContext();
		if (ctx) {
			try {
				ctx.ui.notify(message, type);
			} catch {
				currentContext = null;
			}
		}
	}

	function safeSendMessage(
		message: Parameters<typeof pi.sendMessage>[0],
		options?: Parameters<typeof pi.sendMessage>[1],
	): void {
		try {
			pi.sendMessage(message, options);
		} catch {}
	}

	// Client event listeners
	client.on("statusChange", () => updateStatus());

	client.on("qr", (qr) => {
		if (qr === lastQrShown) return;
		lastQrShown = qr;
		updateStatus();
		safeNotify("WhatsApp QR code generated. Run '/whatsapp qr' to scan.", "warning");
		safeSendMessage(
			{
				customType: "whatsapp-qr",
				content:
					"### WhatsApp QR Code Pairing\n" +
					"A pairing QR code was generated for your WhatsApp account.\n\n" +
					"👉 **Type `/whatsapp qr`** to open the pairing screen and scan the QR code with WhatsApp on your phone (**Settings > Linked Devices > Link a Device**).",
				display: true,
			},
			{ deliverAs: "followUp" },
		);
	});

	client.on("connected", ({ jid, name }) => {
		lastQrShown = null;
		updateStatus();
		safeNotify(`WhatsApp connected as ${name || jid}!`, "info");
		safeSendMessage(
			{
				customType: "whatsapp-status",
				content: `✅ **WhatsApp Connected Successfully!**\n- **Account:** ${name || "WhatsApp User"}\n- **JID:** \`${jid}\`\n- **Relay Mode:** \`${relayMode}\`\n\nThe agent can now send WhatsApp messages using the \`whatsapp_send\` tool.`,
				display: true,
			},
			{ deliverAs: "followUp" },
		);
	});

	client.on("disconnected", ({ isLoggedOut }) => {
		updateStatus();
		safeNotify(
			isLoggedOut ? "WhatsApp logged out. Please reconnect to pair again." : "WhatsApp disconnected.",
			isLoggedOut ? "warning" : "info",
		);
	});

	client.on("message", (msg: IncomingSelfMessage) => {
		const previewText = msg.text ? (msg.text.length > 60 ? `${msg.text.slice(0, 57)}...` : msg.text) : "[Media/Attachment]";

		if (relayMode === "notify" || relayMode === "auto") {
			safeNotify(`WA (Note to Self): ${previewText}`, "info");
		}

		if (relayMode === "auto" && msg.text) {
			const chatType = msg.isGroup ? "Group Chat" : "Self Chat";
			safeSendMessage(
				{
					customType: "whatsapp-incoming",
					content:
						`📨 **WhatsApp Note to Self (${chatType}):**\n` +
						`- **Chat:** \`${msg.chatJid}\`\n\n` +
						`> ${msg.text}\n\n` +
						`*To respond back to this chat, call \`whatsapp_send(to: "${msg.chatJid}", message: "...")\`.*`,
					display: true,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		}
	});

	// Register LLM Tool: whatsapp_send (single focused tool)
	pi.registerTool({
		name: "whatsapp_send",
		label: "WhatsApp Send",
		description:
			"Send a WhatsApp message (text or media attachment) directly to a WhatsApp chat JID (e.g. from an incoming note's chatJid, a group JID, or a phone number).",
		parameters: WhatsAppSendParamsSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params: WhatsAppSendParams) {
			if (!client.isConnected()) {
				return {
					content: [
						{
							type: "text",
							text: "Error: WhatsApp is not currently connected. Run '/whatsapp connect' in the terminal to link your device first.",
						},
					],
				};
			}

			if (params.mediaPath) {
				const result = await client.sendMediaMessage(params.to, params.mediaPath, params.caption || params.message);
				if (!result.success) {
					return {
						content: [{ type: "text", text: `Failed to send WhatsApp media message: ${result.error}` }],
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `Successfully sent media message to ${result.toJid ?? params.to}. Message ID: ${result.id}`,
						},
					],
				};
			}

			const result = await client.sendTextMessage(params.to, params.message);
			if (!result.success) {
				return {
					content: [{ type: "text", text: `Failed to send WhatsApp text message: ${result.error}` }],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Successfully sent WhatsApp message to ${result.toJid ?? params.to}. Message ID: ${result.id}`,
					},
				],
			};
		},
	});

	// Register unified /whatsapp slash command
	pi.registerCommand("whatsapp", {
		description: "Manage WhatsApp connection and pairing (usage: /whatsapp [connect|status|qr|send|disconnect|clear|mode])",
		handler: async (args, ctx) => {
			currentContext = ctx;
			const trimmed = args?.trim() ?? "";
			const parts = trimmed.split(/\s+/);
			const subcommand = parts[0]?.toLowerCase() || "";

			switch (subcommand) {
				case "connect": {
					if (client.isConnected()) {
						ctx.ui.notify("WhatsApp is already connected.", "info");
						return;
					}
					ctx.ui.notify("Connecting to WhatsApp via Baileys...", "info");
					await client.connect();
					updateStatus(ctx);
					break;
				}

				case "disconnect": {
					await client.disconnect();
					updateStatus(ctx);
					ctx.ui.notify("WhatsApp disconnected.", "info");
					break;
				}

				case "clear":
				case "logout": {
					const confirmed = await ctx.ui.confirm(
						"Confirm Clear WhatsApp Session",
						"Are you sure you want to clear the WhatsApp session? This will disconnect and delete all saved login credentials from disk.",
					);
					if (confirmed) {
						await client.clearSession();
						updateStatus(ctx);
						ctx.ui.notify("WhatsApp session and credentials cleared.", "info");
					}
					break;
				}

				case "qr": {
					const qrInfo = client.getQrCode();
					if (client.isConnected()) {
						ctx.ui.notify("Already connected to WhatsApp!", "info");
						return;
					}
					if (!qrInfo.ascii) {
						if (client.getStatus().status === "disconnected") {
							ctx.ui.notify("Connecting to generate QR code...", "info");
							await client.connect();
						} else {
							ctx.ui.notify("QR code not ready yet. Please wait a moment...", "warning");
						}
					}

					if (ctx.mode === "tui") {
						await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
							return new WhatsAppStatusComponent(client, theme, () => done());
						});
					} else {
						const ascii = client.getQrCode().ascii;
						if (ascii) {
							pi.sendMessage(
								{
									customType: "whatsapp-qr",
									content: `### WhatsApp QR Code:\n\`\`\`\n${ascii}\n\`\`\``,
									display: true,
								},
								{ deliverAs: "followUp" },
							);
						}
					}
					break;
				}

				case "send": {
					const recipient = parts[1];
					const messageText = parts.slice(2).join(" ");
					if (!recipient || !messageText) {
						ctx.ui.notify("Usage: /whatsapp send <chat_id> <message_text>", "warning");
						return;
					}

					const res = await client.sendTextMessage(recipient, messageText);
					if (res.success) {
						ctx.ui.notify(`Message sent to ${res.toJid || recipient}!`, "info");
					} else {
						ctx.ui.notify(`Failed: ${res.error}`, "error");
					}
					break;
				}

				case "mode": {
					const modeArg = parts[1]?.toLowerCase();
					if (modeArg === "notify" || modeArg === "auto" || modeArg === "off") {
						relayMode = modeArg as WhatsAppRelayMode;
						ctx.ui.notify(`WhatsApp relay mode set to: ${relayMode}`, "info");
					} else {
						ctx.ui.notify("Usage: /whatsapp mode [notify|auto|off]", "warning");
					}
					break;
				}

				case "status":
				default: {
					const status = client.getStatus();
					pi.sendMessage(
						{
							customType: "whatsapp-status",
							content:
								`**WhatsApp Status:**\n` +
								`- **Connection:** ${status.status}\n` +
								`- **User:** ${status.userName || "N/A"} (${status.userJid || "N/A"})\n` +
								`- **Relay Mode:** \`${relayMode}\`\n` +
								`- **Commands:** \`/whatsapp connect\`, \`/whatsapp qr\`, \`/whatsapp send\`, \`/whatsapp disconnect\`, \`/whatsapp clear\``,
							display: true,
						},
						{ deliverAs: "followUp" },
					);
					break;
				}
			}
		},
	});

	// Session lifecycle handlers
	pi.on("session_start", async (_event, ctx) => {
		currentContext = ctx;
		const autoConnect = pi.getFlag("whatsapp") === true;
		const relayFlag = pi.getFlag("whatsapp-relay");

		if (typeof relayFlag === "string" && ["notify", "auto", "off"].includes(relayFlag)) {
			relayMode = relayFlag as WhatsAppRelayMode;
		}

		if (autoConnect) {
			client.connect().catch((err) => {
				safeNotify(`WhatsApp auto-connect failed: ${err.message}`, "error");
			});
		}

		updateStatus(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		currentContext = ctx;
		updateStatus(ctx);
	});

	pi.on("session_before_switch", async () => {
		currentContext = null;
	});

	pi.on("session_before_fork", async () => {
		currentContext = null;
	});

	pi.on("session_before_compact", async () => {
		currentContext = null;
	});

	pi.on("session_shutdown", async () => {
		currentContext = null;
		await client.disconnect();
	});
}
