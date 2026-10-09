/**
 * Interactive TUI component for WhatsApp QR code pairing and status display.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export interface WhatsAppClientView {
	getStatus(): {
		status: "disconnected" | "connecting" | "qr_ready" | "connected";
		userJid: string | null;
		userName: string | null;
		authDir: string;
		currentQrAscii: string | null;
	};
}

export class WhatsAppStatusComponent {
	private client: WhatsAppClientView;
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(client: WhatsAppClientView, theme: Theme, onClose: () => void) {
		this.client = client;
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
		const statusInfo = this.client.getStatus();

		lines.push("");
		const title = th.fg("accent", " [ WhatsApp Connection ] ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) +
			title +
			th.fg("borderMuted", "─".repeat(Math.max(0, width - 27)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		// Connection status badge
		let statusBadge = "";
		if (statusInfo.status === "connected") {
			statusBadge = th.fg("success", "● Connected");
			if (statusInfo.userJid) {
				const displayName = statusInfo.userName ?? statusInfo.userJid;
				statusBadge += ` as ${th.bold(displayName)}`;
			}
		} else if (statusInfo.status === "connecting") {
			statusBadge = th.fg("warning", "◌ Connecting to WhatsApp...");
		} else if (statusInfo.status === "qr_ready") {
			statusBadge = th.fg("warning", "▲ Awaiting QR Code Scan");
		} else {
			statusBadge = th.fg("dim", "○ Disconnected (run /whatsapp connect)");
		}

		lines.push(truncateToWidth(`  Status: ${statusBadge}`, width));
		lines.push(truncateToWidth(`  Auth Directory: ${th.fg("dim", statusInfo.authDir)}`, width));
		lines.push("");

		// If QR code is ready, display it
		if (statusInfo.status === "qr_ready" && statusInfo.currentQrAscii) {
			lines.push(truncateToWidth(`  ${th.bold(th.fg("accent", "Scan with WhatsApp on your phone:"))}`, width));
			lines.push(truncateToWidth(`  ${th.fg("dim", "1. Open WhatsApp > Settings > Linked Devices")}`, width));
			lines.push(truncateToWidth(`  ${th.fg("dim", "2. Tap 'Link a Device' and point camera at screen")}`, width));
			lines.push("");

			const qrLines = statusInfo.currentQrAscii.split("\n");
			for (const qrl of qrLines) {
				lines.push(truncateToWidth(`  ${qrl}`, width));
			}
			lines.push("");
		}

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
