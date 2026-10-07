/**
 * WhatsApp Utils for Pi Extension
 *
 * Utility functions for Baileys integration, type definitions,
 * JID parsing, and TypeBox schemas for LLM tools.
 */

import { Type, type Static } from "typebox";

/**
 * Format a phone number or target into a valid WhatsApp JID.
 * Examples:
 * - "+1 (555) 123-4567" -> "15551234567@s.whatsapp.net"
 * - "1234567890" -> "1234567890@s.whatsapp.net"
 * - "1234567890@c.us" -> "1234567890@s.whatsapp.net"
 * - "12345-6789@g.us" -> "12345-6789@g.us" (group)
 */
export function formatJid(target: string): string {
	const trimmed = target.trim();
	const lower = trimmed.toLowerCase();
	if (lower === "me" || lower === "myself") {
		return "me";
	}
	if (trimmed.includes("@")) {
		if (trimmed.endsWith("@c.us")) {
			return trimmed.replace("@c.us", "@s.whatsapp.net");
		}
		return trimmed;
	}
	const digits = trimmed.replace(/[^0-9]/g, "");
	if (!digits) {
		return trimmed;
	}
	return `${digits}@s.whatsapp.net`;
}

/**
 * Legacy jid function for backwards compatibility
 */
export function jid(phone: string, domain: "@c.us" | "@g.us" | "@s.whatsapp.net" = "@s.whatsapp.net"): string {
	const digits = phone.replace(/[^0-9]/g, "");
	return `${digits}${domain === "@c.us" ? "@s.whatsapp.net" : domain}`;
}

/**
 * Parse a WhatsApp JID into phone number / id and domain type
 */
export function parseJid(rawJid: string): { id: string; domain: string; isGroup: boolean } {
	const parts = rawJid.split("@");
	if (parts.length !== 2) {
		return { id: rawJid, domain: "unknown", isGroup: false };
	}
	return {
		id: parts[0]!,
		domain: parts[1]!,
		isGroup: parts[1] === "g.us",
	};
}

/**
 * Check if a JID is a group chat
 */
export function isGroupJid(jid: string): boolean {
	return jid.endsWith("@g.us");
}

/**
 * Clean a phone number for display
 */
export function formatPhoneNumber(jidOrNumber: string): string {
	const parsed = parseJid(jidOrNumber);
	return parsed.id;
}

/**
 * WhatsApp message types
 */
export const MessageType = {
	TEXT: "text",
	IMAGE: "image",
	VIDEO: "video",
	AUDIO: "audio",
	DOCUMENT: "document",
	STICKER: "sticker",
	LOCATION: "location",
	CONTACT: "contact",
	REACTION: "reaction",
	OTHER: "other",
} as const;

export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];

/**
 * Normalized WhatsApp message structure
 */
export interface WhatsAppMessage {
	id: string;
	from: string; // JID of sender
	senderNumber: string; // Phone number or participant ID
	senderName?: string; // Push name / profile name if known
	to: string; // JID of recipient
	chatJid: string; // Conversation JID (group or peer)
	fromMe: boolean; // Sent by logged-in user
	timestamp: number; // Unix timestamp in milliseconds
	type: MessageTypeValue;
	text?: string;
	caption?: string;
	mediaMimeType?: string;
	mediaFileName?: string;
	isGroup: boolean;
}

/**
 * Connection states for WhatsApp client
 */
export type WhatsAppConnectionStatus =
	| "disconnected"
	| "connecting"
	| "qr_ready"
	| "connected";

/**
 * Relay mode for incoming WhatsApp messages
 */
export type WhatsAppRelayMode = "notify" | "auto" | "off";

/**
 * Tool Parameter Schemas using TypeBox
 */

export const WhatsAppSendParamsSchema = Type.Object({
	to: Type.String({
		description: "WhatsApp Chat JID (e.g. '1234567890@s.whatsapp.net', '120363028392@g.us' for group chat, or the chatJid from incoming messages)",
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

export const WhatsAppReadParamsSchema = Type.Object({
	chat: Type.Optional(
		Type.String({
			description: "Optional phone number or chat JID to filter messages from",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Maximum number of recent messages to return (default: 10, max: 50)",
			minimum: 1,
			maximum: 50,
		}),
	),
	incomingOnly: Type.Optional(
		Type.Boolean({
			description: "If true, only return incoming messages received from others",
		}),
	),
});

export type WhatsAppReadParams = Static<typeof WhatsAppReadParamsSchema>;

export const WhatsAppStatusParamsSchema = Type.Object({});
export type WhatsAppStatusParams = Static<typeof WhatsAppStatusParamsSchema>;