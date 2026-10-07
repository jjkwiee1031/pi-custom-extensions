# WhatsApp Pi Extension

This extension integrates WhatsApp with the Pi agent framework using the [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) library. It enables the agent to send and receive WhatsApp messages, inspect conversation histories, pair via terminal QR codes, and optionally auto-relay incoming messages to trigger agent turns.

## Features

- **Send WhatsApp Messages**: Send text and media attachments (images, documents, videos, audio notes) from the agent.
- **Read Message History**: Retrieve recent incoming and outgoing messages filtered by chat or contact.
- **Session Persistence**: Saves multi-file credentials in `.pi/whatsapp_auth/` so pairing survives across sessions.
- **Terminal QR Code Pairing**: Scan an ASCII QR code directly from the terminal or interactive TUI modal (`/whatsapp qr`).
- **Slash Commands**: Comprehensive `/whatsapp` commands for connecting, checking status, viewing QR codes, sending messages, and switching relay modes.
- **Live Status Indicator**: Real-time status in Pi footer/status bar (`🟢 WA: connected`, `🟡 WA: connecting`, `▲ WA: scan QR`, `⚪ WA: offline`).
- **Incoming Message Relaying**:
  - `notify`: Displays toast/notifications for incoming messages without interrupting.
  - `auto`: Feeds incoming WhatsApp messages directly into the Pi agent context to allow conversational agents.
  - `off`: Stores messages in history buffer silently.

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
2. A QR code will be generated and printed to the chat.
3. You can also view the full-screen interactive QR modal by running:
   ```text
   /whatsapp qr
   ```
4. Open **WhatsApp** on your phone > **Settings** (or ⋮ menu) > **Linked Devices** > **Link a Device**.
5. Scan the QR code displayed in your terminal.
6. Once connected, the status bar will show `🟢 WA: connected (+<phone>)`.

### 2. Slash Commands

| Command | Description |
|---|---|
| `/whatsapp connect` | Initialize connection and generate pairing QR code |
| `/whatsapp status` | Show connection state, logged-in user, and message count |
| `/whatsapp qr` | Open the interactive QR modal or re-display QR code |
| `/whatsapp disconnect` | Disconnect WhatsApp WebSocket session |
| `/whatsapp clear` (or `/whatsapp-clear`) | Disconnect, delete saved session credentials from disk, and clear message history |
| `/whatsapp logout` | Disconnect and clear saved session credentials |
| `/whatsapp send <phone> <message>` | Send a quick message from the terminal |
| `/whatsapp messages [limit]` | Display recent messages in chat |
| `/whatsapp mode [notify\|auto\|off]` | Change incoming message relay mode |

### 3. Agent Tools

The LLM agent has access to 4 registered WhatsApp tools:

#### `whatsapp_send`
Send a text or media message to a recipient.

```json
{
  "to": "+1234567890",
  "message": "Hello from Pi Agent!",
  "mediaPath": "/path/to/image.png",
  "caption": "Quarterly summary report"
}
```

*Recipient formats supported: phone numbers (e.g. `+1 (555) 123-4567`, `1234567890`), JIDs (`1234567890@s.whatsapp.net`), or groups (`12345-6789@g.us`).*

#### `whatsapp_read`
Retrieve recent incoming and outgoing messages:

```json
{
  "chat": "1234567890",
  "limit": 10,
  "incomingOnly": true
}
```

#### `whatsapp_status`
Inspect current connection status:

```json
{}
```

#### `whatsapp_clear`
Clear WhatsApp session credentials and message history:

```json
{}
```

## CLI Flags

- `--whatsapp`: Automatically initiates WhatsApp connection when Pi starts.
- `--whatsapp-relay <mode>`: Sets relay behavior for incoming messages (`notify`, `auto`, `off`).

## Security & Storage

- Session credentials are stored in `.pi/whatsapp_auth/`.
- Ensure `.pi/whatsapp_auth/` is included in your `.gitignore` to prevent leaking authentication secrets.
- To re-pair or revoke access, run `/whatsapp logout` or delete the `.pi/whatsapp_auth/` folder.