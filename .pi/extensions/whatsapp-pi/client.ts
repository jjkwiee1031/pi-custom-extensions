/**
 * WhatsApp Baileys Client Wrapper for Pi Agent
 *
 * Manages WebSocket connection to WhatsApp using WhiskeySockets/Baileys,
 * handles QR code authentication, session persistence, message sending/receiving,
 * and maintains recent message history.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import makeWASocket, {
	DisconnectReason,
	useMultiFileAuthState,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	generateMessageIDV2,
	jidNormalizedUser,
	type WASocket,
	type proto,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import {
	formatJid,
	isGroupJid,
	parseJid,
	MessageType,
	type MessageTypeValue,
	type WhatsAppConnectionStatus,
	type WhatsAppMessage,
} from "./utils.ts";

/**
 * Suppress noisy console.info/warn and stdout leakage from libsignal & Baileys internal ratchets.
 * libsignal hardcodes `console.info("Opening session:", session)` and `console.info("Closing session:", session)`,
 * which prints session keys and `pendingPreKey: {}` directly to process.stdout, corrupting Pi's terminal TUI.
 */
function installLibsignalLoggerSilencer(): void {
	const origLog = console.log;
	const origInfo = console.info;
	const origWarn = console.warn;
	const origError = console.error;

	function shouldSuppress(args: any[]): boolean {
		for (const arg of args) {
			if (!arg) continue;
			if (typeof arg === "string") {
				if (
					arg.includes("Opening session:") ||
					arg.includes("Closing session:") ||
					arg.includes("Session already") ||
					arg.includes("Removing old closed session:") ||
					arg.includes("Closing open session") ||
					arg.includes("Decrypted message with closed session") ||
					arg.includes("Migrating session to:") ||
					arg.includes("pendingPreKey") ||
					arg.includes("Unhandled bucket type") ||
					arg.includes("WARNING: Expected pubkey") ||
					arg.includes("Failed to decrypt message") ||
					arg.includes("Session error:")
				) {
					return true;
				}
			} else if (typeof arg === "object") {
				if ("pendingPreKey" in arg || "currentRatchet" in arg || "indexInfo" in arg) {
					return true;
				}
			}
		}
		const stack = new Error().stack || "";
		return stack.includes("node_modules/libsignal") || stack.includes("@whiskeysockets/baileys");
	}

	console.info = (...args: any[]) => {
		if (!shouldSuppress(args)) origInfo(...args);
	};
	console.warn = (...args: any[]) => {
		if (!shouldSuppress(args)) origWarn(...args);
	};
	console.log = (...args: any[]) => {
		if (!shouldSuppress(args)) origLog(...args);
	};
	console.error = (...args: any[]) => {
		if (!shouldSuppress(args)) origError(...args);
	};

	const origStdoutWrite = process.stdout.write.bind(process.stdout);
	const origStderrWrite = process.stderr.write.bind(process.stderr);

	process.stdout.write = function (chunk: any, ...args: any[]): boolean {
		if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
			const str = chunk.toString();
			if (
				str.includes("pendingPreKey") ||
				str.includes("Opening session:") ||
				str.includes("Closing session:") ||
				str.includes("Session already") ||
				str.includes("Removing old closed session:")
			) {
				return true;
			}
		}
		return (origStdoutWrite as any)(chunk, ...args);
	};

	process.stderr.write = function (chunk: any, ...args: any[]): boolean {
		if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
			const str = chunk.toString();
			if (
				str.includes("pendingPreKey") ||
				str.includes("Opening session:") ||
				str.includes("Closing session:") ||
				str.includes("Session already") ||
				str.includes("Removing old closed session:")
			) {
				return true;
			}
		}
		return (origStderrWrite as any)(chunk, ...args);
	};
}

installLibsignalLoggerSilencer();

export interface ClientEvents {
	statusChange: (status: WhatsAppConnectionStatus, detail?: string) => void;
	qr: (qr: string, ascii: string) => void;
	connected: (user: { jid: string; name?: string }) => void;
	disconnected: (reason: { statusCode?: number; isLoggedOut: boolean }) => void;
	message: (message: WhatsAppMessage) => void;
	error: (error: Error) => void;
}

export class WhatsAppClient extends EventEmitter {
	private sock: WASocket | null = null;
	private authDir: string;
	private status: WhatsAppConnectionStatus = "disconnected";
	private userJid: string | null = null;
	private userName: string | null = null;
	private currentQr: string | null = null;
	private currentQrAscii: string | null = null;
	private recentMessages: WhatsAppMessage[] = [];
	private maxHistory = 200;
	private reconnectTimeout: NodeJS.Timeout | null = null;
	private intentionalDisconnect = false;
	private autoReconnect = true;
	private outgoingMessageIds = new Set<string>();
	private messageStore = new Map<string, proto.IMessage>();

	constructor(authDir: string) {
		super();
		this.authDir = authDir;
		if (!fs.existsSync(this.authDir)) {
			fs.mkdirSync(this.authDir, { recursive: true });
		}
	}

	public getStatus(): {
		status: WhatsAppConnectionStatus;
		userJid: string | null;
		userName: string | null;
		authDir: string;
		currentQrAscii: string | null;
		messageCount: number;
	} {
		return {
			status: this.status,
			userJid: this.userJid,
			userName: this.userName,
			authDir: this.authDir,
			currentQrAscii: this.currentQrAscii,
			messageCount: this.recentMessages.length,
		};
	}

	public isConnected(): boolean {
		return this.status === "connected" && this.sock !== null;
	}

	public getQrCode(): { raw: string | null; ascii: string | null } {
		return {
			raw: this.currentQr,
			ascii: this.currentQrAscii,
		};
	}

	public async connect(): Promise<void> {
		if (this.status === "connected" || this.status === "connecting") {
			return;
		}

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
					if (key.id) {
						return this.messageStore.get(key.id) ?? undefined;
					}
					return undefined;
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
					this.emit("connected", {
						jid: this.userJid ?? "",
						name: this.userName ?? undefined,
					});
				} else if (connection === "close") {
					const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
					const isLoggedOut = statusCode === DisconnectReason.loggedOut;

					this.userJid = null;
					this.userName = null;
					this.setStatus("disconnected");
					this.emit("disconnected", { statusCode, isLoggedOut });

					if (isLoggedOut) {
						this.cleanAuthDir();
					} else if (!this.intentionalDisconnect && this.autoReconnect) {
						this.scheduleReconnect();
					}
				}
			});

			this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
				for (const msg of messages) {
					this.handleIncomingMessage(msg);
				}
			});
		} catch (err: any) {
			this.setStatus("disconnected", err?.message);
			this.emit("error", err instanceof Error ? err : new Error(String(err)));
			if (!this.intentionalDisconnect && this.autoReconnect) {
				this.scheduleReconnect();
			}
		}
	}

	private setStatus(newStatus: WhatsAppConnectionStatus, detail?: string): void {
		this.status = newStatus;
		this.emit("statusChange", newStatus, detail);
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
		}
		this.reconnectTimeout = setTimeout(() => {
			if (!this.intentionalDisconnect && this.status !== "connected") {
				this.connect().catch((err) => {
					this.emit("error", err);
				});
			}
		}, 5000);
	}

	private handleIncomingMessage(raw: proto.IWebMessageInfo): void {
		if (!raw.message || !raw.key) {
			return;
		}

		const key = raw.key;
		const id = key.id ?? "";

		// Cache message structure for signal protocol re-encryption requests
		if (id && raw.message) {
			this.messageStore.set(id, raw.message);
			if (this.messageStore.size > 500) {
				const oldest = this.messageStore.keys().next().value;
				if (oldest) this.messageStore.delete(oldest);
			}
		}

		// If this was an outgoing message sent by our agent/extension, ignore from incoming event pipeline
		if (this.outgoingMessageIds.has(id)) {
			return;
		}

		const fromMe = key.fromMe ?? false;
		const chatJid = key.remoteJid ?? "";
		const senderJid = key.participant || chatJid;
		const isGroup = isGroupJid(chatJid);

		let type: MessageTypeValue = MessageType.OTHER;
		let text = "";
		let caption: string | undefined;
		let mediaMimeType: string | undefined;
		let mediaFileName: string | undefined;

		const msg = raw.message;

		if (msg.conversation) {
			type = MessageType.TEXT;
			text = msg.conversation;
		} else if (msg.extendedTextMessage) {
			type = MessageType.TEXT;
			text = msg.extendedTextMessage.text ?? "";
		} else if (msg.imageMessage) {
			type = MessageType.IMAGE;
			caption = msg.imageMessage.caption ?? undefined;
			text = caption ?? "[Image]";
			mediaMimeType = msg.imageMessage.mimetype ?? "image/jpeg";
		} else if (msg.videoMessage) {
			type = MessageType.VIDEO;
			caption = msg.videoMessage.caption ?? undefined;
			text = caption ?? "[Video]";
			mediaMimeType = msg.videoMessage.mimetype ?? "video/mp4";
		} else if (msg.audioMessage) {
			type = MessageType.AUDIO;
			text = "[Audio Note]";
			mediaMimeType = msg.audioMessage.mimetype ?? "audio/ogg";
		} else if (msg.documentMessage) {
			type = MessageType.DOCUMENT;
			mediaFileName = msg.documentMessage.fileName ?? "document";
			caption = msg.documentMessage.caption ?? undefined;
			text = caption ? `${caption} (${mediaFileName})` : `[Document: ${mediaFileName}]`;
			mediaMimeType = msg.documentMessage.mimetype ?? "application/octet-stream";
		} else if (msg.stickerMessage) {
			type = MessageType.STICKER;
			text = "[Sticker]";
		} else if (msg.reactionMessage) {
			type = MessageType.REACTION;
			text = `[Reaction: ${msg.reactionMessage.text}]`;
		}

		const parsedSender = parseJid(senderJid);
		const normalized: WhatsAppMessage = {
			id: key.id ?? String(Date.now()),
			from: senderJid,
			senderNumber: parsedSender.id,
			senderName: raw.pushName ?? undefined,
			to: fromMe ? chatJid : (this.userJid ?? "me"),
			chatJid,
			fromMe,
			timestamp: raw.messageTimestamp ? Number(raw.messageTimestamp) * 1000 : Date.now(),
			type,
			text,
			caption,
			mediaMimeType,
			mediaFileName,
			isGroup,
		};

		this.recentMessages.unshift(normalized);
		if (this.recentMessages.length > this.maxHistory) {
			this.recentMessages.pop();
		}

		this.emit("message", normalized);
	}


	public async sendTextMessage(
		to: string,
		text: string,
	): Promise<{ success: boolean; id?: string; error?: string; toJid?: string }> {
		if (!this.isConnected() || !this.sock) {
			return { success: false, error: "WhatsApp is not connected. Use '/whatsapp connect' first." };
		}

		try {
			const jid = to.trim();

			// Pre-generate message ID and track it as outgoing so incoming listeners ignore it
			const messageId = generateMessageIDV2(this.sock.user?.id);
			this.outgoingMessageIds.add(messageId);

			const result = await this.sock.sendMessage(jid, { text }, { messageId });

			if (result?.key?.id && result?.message) {
				this.messageStore.set(result.key.id, result.message);
			}

			const outMessage: WhatsAppMessage = {
				id: result?.key?.id ?? messageId,
				from: this.userJid ?? "me",
				senderNumber: this.userJid ? parseJid(this.userJid).id : "me",
				senderName: this.userName ?? undefined,
				to: jid,
				chatJid: jid,
				fromMe: true,
				timestamp: Date.now(),
				type: MessageType.TEXT,
				text,
				isGroup: isGroupJid(jid),
			};

			this.recentMessages.unshift(outMessage);
			if (this.recentMessages.length > this.maxHistory) {
				this.recentMessages.pop();
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
			return { success: false, error: "WhatsApp is not connected. Use '/whatsapp connect' first." };
		}

		const resolvedPath = path.resolve(filePath);
		if (!fs.existsSync(resolvedPath)) {
			return { success: false, error: `File not found at path: ${resolvedPath}` };
		}

		try {
			const jid = to.trim();

			const buffer = fs.readFileSync(resolvedPath);
			const ext = path.extname(resolvedPath).toLowerCase();
			const fileName = path.basename(resolvedPath);

			let messageContent: any;
			let type: MessageTypeValue = MessageType.DOCUMENT;

			if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) {
				type = MessageType.IMAGE;
				messageContent = {
					image: buffer,
					caption: caption ?? undefined,
				};
			} else if ([".mp4", ".mov", ".mkv", ".avi"].includes(ext)) {
				type = MessageType.VIDEO;
				messageContent = {
					video: buffer,
					caption: caption ?? undefined,
				};
			} else if ([".mp3", ".ogg", ".wav", ".m4a"].includes(ext)) {
				type = MessageType.AUDIO;
				messageContent = {
					audio: buffer,
					mimetype: ext === ".mp3" ? "audio/mpeg" : ext === ".ogg" ? "audio/ogg" : "audio/mp4",
				};
			} else {
				type = MessageType.DOCUMENT;
				messageContent = {
					document: buffer,
					mimetype: "application/octet-stream",
					fileName,
					caption: caption ?? undefined,
				};
			}

			const messageId = generateMessageIDV2(this.sock.user?.id);
			this.outgoingMessageIds.add(messageId);

			const result = await this.sock.sendMessage(jid, messageContent, { messageId });

			if (result?.key?.id && result?.message) {
				this.messageStore.set(result.key.id, result.message);
			}

			const outMessage: WhatsAppMessage = {
				id: result?.key?.id ?? messageId,
				from: this.userJid ?? "me",
				senderNumber: this.userJid ? parseJid(this.userJid).id : "me",
				senderName: this.userName ?? undefined,
				to: jid,
				chatJid: jid,
				fromMe: true,
				timestamp: Date.now(),
				type,
				text: caption ?? `[Attachment: ${fileName}]`,
				caption,
				mediaFileName: fileName,
				isGroup: isGroupJid(jid),
			};

			this.recentMessages.unshift(outMessage);
			if (this.recentMessages.length > this.maxHistory) {
				this.recentMessages.pop();
			}

			return { success: true, id: result?.key?.id ?? messageId, toJid: jid };
		} catch (err: any) {
			return { success: false, error: err?.message || String(err) };
		}
	}

	public getRecentMessages(options?: {
		chat?: string;
		limit?: number;
		incomingOnly?: boolean;
	}): WhatsAppMessage[] {
		let list = [...this.recentMessages];

		if (options?.chat) {
			const targetChat = options.chat.trim();
			list = list.filter((m) => m.chatJid === targetChat || m.from === targetChat || m.to === targetChat);
		}

		if (options?.incomingOnly) {
			list = list.filter((m) => !m.fromMe);
		}

		const limit = options?.limit ?? 10;
		return list.slice(0, Math.min(limit, 50));
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

	public clearMessages(): void {
		this.recentMessages = [];
	}

	public async clearSession(): Promise<void> {
		await this.logout();
		this.clearMessages();
	}

	public async logout(): Promise<void> {
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
