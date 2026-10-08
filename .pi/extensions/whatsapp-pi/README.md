# WhatsApp Pi Extension

This extension integrates WhatsApp with the Pi agent framework using the [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) library. It enables the agent to send WhatsApp messages and media, pair via an interactive terminal QR modal, and auto-relay incoming "Note to Self" messages to trigger agent turns remotely.

## Features

- **Send WhatsApp Messages**: Send text messages and media attachments (images, documents, videos, audio notes) from the agent.
- **Terminal QR Code Pairing**: Scan an ASCII QR code directly from the interactive TUI modal (`/whatsapp qr`).
- **Session Persistence**: Saves multi-file credentials in `.pi/whatsapp_auth/` so pairing survives across sessions.
- **Slash Commands**: Consolidated `/whatsapp` commands for connecting, checking status, viewing QR codes, sending messages, clearing sessions, and switching relay modes.
- **Live Status Indicator**: Real-time status in Pi footer/status bar (`[WA: connected]`, `[WA: connecting]`, `[WA: scan QR]`).
- **Incoming Note to Self Relaying**:
  - `notify`: Displays toast/notifications for incoming self-notes without interrupting.
  - `auto`: Feeds incoming "Note to Self" messages directly into the Pi agent context to execute tasks remotely.
  - `off`: Ignores incoming messages silently.

## Installation & Setup

1. Install required dependencies in the project root:

```bash
npm install @whiskeysockets/baileys pino qrcode-terminal typebox
```

2. Start Pi agent:

```bash
pi
```

Or start with auto-connect enabled:

```bash
pi --whatsapp --whatsapp-relay auto
```

## Usage

### 1. Pairing with WhatsApp

To link your phone to the Pi agent:

1. Inside the Pi session, run:
   ```text
   /whatsapp connect
   ```
2. Open the pairing modal:
   ```text
   /whatsapp qr
   ```
3. Open **WhatsApp** on your phone > **Settings** (or ⋮ menu) > **Linked Devices** > **Link a Device**.
4. Scan the QR code displayed in your terminal.
5. Once connected, the status bar will show `[WA: <username>]`.

### 2. Slash Commands

| Command | Description |
|---|---|
| `/whatsapp connect` | Initialize connection and generate pairing QR code |
| `/whatsapp status` | Show connection state, logged-in user, and relay mode |
| `/whatsapp qr` | Open the interactive QR modal or re-display QR code |
| `/whatsapp send <phone> <message>` | Send a quick message manually from the terminal |
| `/whatsapp mode [notify\|auto\|off]` | Change incoming message relay mode |
| `/whatsapp disconnect` | Disconnect WhatsApp WebSocket session |
| `/whatsapp clear` | Disconnect and delete saved session credentials from disk |

### 3. Agent Tool

The LLM agent has access to 1 focused WhatsApp tool:

#### `whatsapp_send`
Send a text or media message to a recipient:

```json
{
  "to": "+1234567890",
  "message": "Hello from Pi Agent!",
  "mediaPath": "/path/to/image.png",
  "caption": "Quarterly summary report"
}
```

*Recipient formats supported: phone numbers (e.g. `+1 (555) 123-4567`, `1234567890`), JIDs (`1234567890@s.whatsapp.net`), or groups (`12345-6789@g.us`).*

## CLI Flags

- `--whatsapp`: Automatically initiates WhatsApp connection when Pi starts.
- `--whatsapp-relay <mode>`: Sets relay behavior for incoming messages (`notify`, `auto`, `off`).

## Security & Storage

- Session credentials are stored in `.pi/whatsapp_auth/`.
- Ensure `.pi/whatsapp_auth/` is included in your `.gitignore` to prevent leaking authentication secrets.
- To re-pair or revoke access, run `/whatsapp clear` or delete the `.pi/whatsapp_auth/` folder.