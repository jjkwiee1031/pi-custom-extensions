# WhatsApp Extension Simplification Specification

## Problem Statement

The WhatsApp extension for the Pi agent currently suffers from architectural bloat and accidental complexity (~1,400 lines across 4 loosely decoupled files). It includes:
- Overly broad LLM tool exposure (`whatsapp_read`, `whatsapp_status`, `whatsapp_clear`) that clutters the agent's context and introduces risks (such as an LLM accidentally resetting sessions).
- Redundant in-memory message history buffering and message browsing commands that duplicate the chat history already tracked by the agent conversation context.
- Duplicate state management across modules (such as tracking outgoing message IDs in multiple places and exposing duplicate slash commands).
- An 85-line invasive monkeypatch of multiple global `console` and process stream methods to silence Baileys/libsignal terminal log leaks.
- Diffuse logic spread across four files when a clean two-file structure (one extension core and one interactive terminal UI component) provides higher cohesion, lower maintenance overhead, and clear mental clarity.

The user needs a lean, simplified, robust implementation that retains core remote-assistant capabilities (sending text and media, QR pairing, and auto-relaying user notes) while eliminating unnecessary layers and boilerplate.

## Solution

Consolidate and streamline the WhatsApp extension into a cohesive two-component architecture:
1. **Core Extension Module**: Encapsulates the Baileys connection manager, incoming message event handling (strictly scoped to self-originating "Note to Self" messages), a single dedicated LLM tool (`whatsapp_send`), unified `/whatsapp` slash commands, and a lightweight stdout/stderr noise filter.
2. **Interactive TUI Modal**: Preserves the dedicated terminal QR scanner and connection status card component for comfortable interactive pairing.

All redundant tools (`whatsapp_read`, `whatsapp_status`, `whatsapp_clear`), in-memory message buffering, duplicate command aliases, and verbose console monkeypatching are eliminated.

## User Stories

1. As a user, I want to pair my WhatsApp account with Pi via terminal QR code so that the agent can interact with WhatsApp on my behalf.
2. As a user, I want an interactive terminal UI modal accessible via `/whatsapp qr` so that I can scan the QR code without terminal line wrapping or distortion.
3. As a user, I want to see the real-time WhatsApp connection status in the status bar/footer so that I know immediately if the connection is active, connecting, waiting for QR, or offline.
4. As a user, I want the extension to automatically reconnect after unexpected network interruptions so that I do not need to manually reconnect every time my connection drops.
5. As a user, I want the extension to persist authentication credentials in the project storage directory so that I do not have to scan the QR code every time Pi starts.
6. As a user, I want to start Pi with `--whatsapp` and `--whatsapp-relay` command-line flags so that WhatsApp auto-connects on launch.
7. As a user, I want to send messages from my phone to myself ("Note to Self") so that I can trigger the Pi agent remotely while away from my computer.
8. As a user, I want incoming messages from myself to automatically trigger an agent turn when relay mode is set to `auto` so that the agent immediately processes my remote instructions.
9. As a user, I want messages sent by the agent itself to be excluded from incoming message handling so that the agent never enters an infinite self-trigger loop.
10. As a user, I want messages from external contacts and group chats to be ignored for automated agent triggers so that third parties cannot execute arbitrary agent tasks on my machine.
11. As a user, I want to change the incoming message relay behavior via `/whatsapp mode [notify|auto|off]` so that I can control whether incoming notes trigger the agent, display toasts, or stay silent.
12. As a user, I want to send quick WhatsApp messages manually from the CLI using `/whatsapp send <phone> <message>` without needing the LLM.
13. As a user, I want to safely clear credentials and logout via `/whatsapp clear` with a confirmation dialog so that I can reset or unlink my WhatsApp account cleanly.
14. As an AI agent, I want access to a single, focused tool `whatsapp_send` so that I can reliably message the user or authorized chats with text or media attachments.
15. As an AI agent, I want `whatsapp_send` to support sending local media files (images, documents, videos, audio) with optional captions so that I can share generated reports and artifacts.
16. As an AI agent, I want `whatsapp_send` to return descriptive error messages if the WhatsApp client is disconnected or file attachments do not exist so that I can inform the user accurately.
17. As an AI agent, I want unnecessary administrative tools (`whatsapp_clear`, `whatsapp_status`, `whatsapp_read`) removed from my tool definition list so that my context window is not wasted and destructive tools cannot be triggered accidentally.
18. As a developer, I want the extension logic contained in two cohesive files so that the codebase is easy to navigate, understand, and maintain.
19. As a developer, I want noisy libsignal terminal logs (`Opening session:`, `Closing session:`, `pendingPreKey`) filtered out using a concise stream write filter so that the terminal UI is not corrupted without resorting to fragile 85-line monkeypatches.

## Implementation Decisions

### 1. Two-Module Architecture
- Consolidate the extension into:
  - **Extension Core**: Coordinates the Baileys socket connection, credentials management, event emission, LLM tool registration, slash command handling, and session lifecycle hooks.
  - **TUI QR Modal Component**: Retains the full-screen terminal modal rendering the ASCII QR code and connection state for `/whatsapp qr`.
- Drop the separate client wrapper and utility modules by embedding necessary helpers (such as JID phone number formatting) directly into the core module.

### 2. LLM Tool Surface Area
- Expose **only** `whatsapp_send` to the LLM agent.
- Schema parameter contract:
  - `to` (string, required): WhatsApp Chat JID or phone number.
  - `message` (string, required): Text message body or fallback text.
  - `mediaPath` (string, optional): Local file path to an attachment.
  - `caption` (string, optional): Caption for media attachments.
- Deprecate and remove `whatsapp_read`, `whatsapp_status`, and `whatsapp_clear` from the tool registry.

### 3. Strictly Self-Originating Message Relaying
- Filter incoming messages strictly:
  - Only process messages where `fromMe` is true.
  - Filter out outgoing messages generated by the extension (matched via generated message IDs).
  - Messages from third parties, unknown contacts, or external group participants are ignored.
- In `auto` relay mode, deliver messages into Pi's session using `sendMessage` with `triggerTurn: true` and `deliverAs: "followUp"`.
- In `notify` relay mode, trigger `ui.notify` without initiating an agent turn.
- In `off` relay mode, incoming messages are ignored.

### 4. Elimination of In-Memory Message Buffering
- Remove internal message history arrays, pruning routines, and capacity caps.
- Remove the `/whatsapp messages` slash command and message counters in status reporting.
- Rely on Pi's native conversation transcript and session storage for conversational continuity.

### 5. Slash Command Consolidation
- Provide a single unified command: `/whatsapp [subcommand]`:
  - `connect`: Initiates connection and pairing.
  - `disconnect`: Closes the active session.
  - `qr`: Displays the interactive TUI QR modal (or ASCII in non-TUI contexts).
  - `send <recipient> <message>`: Sends a manual message.
  - `clear`: Prompts for confirmation, disconnects, and wipes credentials from disk.
  - `mode <notify|auto|off>`: Updates the active relay mode.
  - `status`: Displays connection state, connected user name, JID, and relay mode.
- Remove the duplicate top-level `/whatsapp-clear` command.

### 6. Streamlined Noise Suppression
- Replace global console method overrides with a concise write interceptor on `process.stdout.write` and `process.stderr.write`.
- Match only known libsignal internal session leak signatures (`Opening session:`, `Closing session:`, `pendingPreKey`, `Session already`) and drop matching chunks before writing to terminal descriptors.

## Testing Decisions

### What Makes a Good Test
Tests should verify external observable behavior at the boundaries rather than private internal implementation details:
- Correct tool schema definition and execution behavior under connected vs disconnected states.
- Correct routing and handling of `/whatsapp` slash commands.
- Verification that `whatsapp_send` dispatches messages with correct recipients, text, and media structures.
- Verification that incoming self-messages trigger `pi.sendMessage` with `triggerTurn: true`, while extension-generated message IDs and non-self messages are filtered out.
- Verification that credentials directories are cleared upon confirmed `/whatsapp clear` execution.
- Verification that libsignal stdout/stderr filter suppresses known log fragments while preserving standard application output.

### Target Testing Seam
The primary test seam is the **Extension API & Socket Boundary**:
- An integration seam wrapping the extension registration function with a mock ExtensionAPI and mock Baileys socket.
- This single seam exercises the entire lifecycle: command dispatch, tool execution, message relaying, and lifecycle events.

### Prior Art
- Existing extension structures in `.pi/extensions/plan-mode` and `.pi/extensions/subagent` demonstrate command dispatch, tool schema registration, and UI notification patterns.

## Out of Scope
- Multi-user chat routing or listening to group conversations for public bot interactions.
- In-memory historical message indexing or message search tooling.
- Multi-device simultaneous credential switching (single session auth directory is used).
- WhatsApp VoIP audio/video call handling.

## Further Notes
- Session credentials reside in `.pi/whatsapp_auth/`, which must remain ignored in `.gitignore`.
- All operations are compatible with Baileys v7.x-rc and Node.js LTS environments.
