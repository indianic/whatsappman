# @indianic/whatsappman

[![npm](https://img.shields.io/badge/npm-%40indianic%2Fwhatsappman-cb3837?style=flat-square&logo=npm)](https://npm.indianic.in/-/web/detail/@indianic/whatsappman)
[![license](https://img.shields.io/badge/license-MIT-green?style=flat-square)](https://opensource.org/licenses/MIT)
[![node](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-12%20tools-orange?style=flat-square)
![platform](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-informational?style=flat-square)

WhatsAppMan CLI — send WhatsApp just by asking your AI assistant, built for IndiaNIC infrastructure.

> 🌐 **Live tour & docs:** [whatsappman.indianic.dev](https://whatsappman.indianic.dev)
> 📦 **Package:** [`@indianic/whatsappman`](https://npm.indianic.in/-/web/detail/@indianic/whatsappman) — `npm i -g @indianic/whatsappman` (point the `@indianic` scope at `https://npm.indianic.in` first)

## See it in action

Ask your AI in plain English. WhatsAppMan **drafts, previews, and only sends on your OK** — never the moment you ask.

![How WhatsAppMan works — ask, preview, your computer sends, delivered from your number](https://whatsappman.indianic.dev/readme/how-it-works.png)

**Twelve plain-English tools** your AI can call — no raw "send", so nothing goes out unpreviewed:

![What your AI can do — 12 MCP tools, plain-English first](https://whatsappman.indianic.dev/readme/mcp-tools.png)

**Real scenarios**, triggered by your AI, a cron, a webhook or a script — always sent from your own number:

![Use cases — client updates, documents, scheduled reminders, deploy & on-call alerts, list messages, locations, status](https://whatsappman.indianic.dev/readme/use-cases.png)

## Features

- Send **text, images, documents, locations & contact cards** from your AI in plain English — "send 'running late' to Kalpesh"
- **Draft → preview → confirm** safety — nothing sends until you approve (`confirm_send` won't dispatch without an explicit confirmation); there's **no raw "send" tool**, so an AI can never send an unpreviewed message
- **Multiple linked numbers**, each paired by QR, with per-send `--from` routing
- **Scheduled sends** held by an always-on local daemon — they fire even if your editor is closed and survive restarts
- Markdown → WhatsApp formatting, smart recipient resolution (name / phone / group, validated against WhatsApp), bulk send (throttled + capped), local send log
- **No third-party API, no server, no database** — your machine becomes a WhatsApp "linked device" via [Baileys](https://github.com/WhiskeySockets/Baileys)
- Machine-bound credentials, desktop notifications, pre-send health check (never a false "sent")
- Installs into **Claude Code, Cursor, Gemini CLI, Windsurf, Codex** (`whatsappman register`) — cross-platform Win/Mac/Linux
- 12 MCP tools, exposed to your AI over MCP

![Everything WhatsApp, hands-free — send anything, multiple numbers, scheduled sends, smart recipient resolution, send history, stays connected](https://whatsappman.indianic.dev/readme/features.png)

## Installation

```
npm config set @indianic:registry https://npm.indianic.in
npm install -g @indianic/whatsappman
```

(The `@indianic` scope routes to the private registry via your `~/.npmrc`, so no `--registry` flag is needed and public dependencies still resolve from npm.)

## Usage

```
# First-run setup — installs the always-on daemon, links your first number
# by QR, and registers your AI tools (Claude Code, Cursor, Gemini CLI, Windsurf, Codex)
whatsappman init

# Register with AI editors later
whatsappman register --write --tools claude,cursor,gemini,windsurf,codex

# Link & manage numbers
whatsappman link --label work        # add another number (scan a QR)
whatsappman numbers                  # list linked numbers + status
whatsappman default work             # pick the default number for sends
whatsappman relink work              # re-pair an expired number

# Diagnostics & current state
whatsappman doctor
whatsappman status

# Send from the terminal (the AI path is draft → confirm)
whatsappman send "+91 99•••• 3349" "Build passed ✅"

# Scheduled sends & history
whatsappman scheduled
whatsappman recent

# Settings & self-update
whatsappman settings set alwaysConfirm false
whatsappman update

# Help & version
whatsappman help
whatsappman --version
```

Once installed and registered, you talk to your AI — not the CLI — for everyday sending:

```
You: whatsappman, send "running 10 min late" to Kalpesh
AI:  [resolves the contact, drafts the message] Ready to send — confirm?
You: yes
AI:  Sent. ✓ delivered

You: whatsappman, send plan.pdf to the "Project Falcon" group
You: which numbers are connected?
You: schedule "standup in 5" for 9am tomorrow   # fires even if the tool is closed
```

> **Package vs. command names.** The npm package is **`@indianic/whatsappman`**; it installs a CLI you run as **`whatsappman`**. A second alias, **`mcp-whatsappman`**, points at the same binary — use it only on a host that also has another `whatsappman` on `PATH`.

## How it works

WhatsApp needs a **persistent connection** — Baileys holds a live WebSocket, and that connection *is* the login. So whatsappman splits into two pieces:

- **`whatsappmand` — the daemon.** Always running (installed as a `launchd` / `systemd` / Task-Scheduler job by `whatsappman init`). Holds the Baileys socket(s) + credentials, auto-reconnects, and is the *only* piece that talks to WhatsApp. One per machine; it can hold **several numbers at once**.
- **The MCP server + CLI — thin clients.** Ephemeral. Your AI spawns the MCP server per session; you run the CLI in a terminal. Both just talk to the daemon over a local **Unix domain socket** (`~/.whatsappman/daemon.sock`, `0600`) — no network, no port, no IP.

You scan a QR **once** per number; credentials persist to disk and survive reboots, so you never re-pair unless WhatsApp itself expires the link. Daemon crash → `KeepAlive`/`Restart` brings it back; reboot → `RunAtLoad` auto-starts it; sleep/wake → Baileys reconnects. If WhatsApp invalidates a pairing, the number flips to `needs_relink` and every send returns a **clear, actionable error — never a false "sent."**

## Desktop notifications

Default-on, best-effort OS notifications for events a background daemon would otherwise hide — a number dropping to `needs_relink`, and scheduled sends firing (✓/✗). macOS `osascript`, Linux `notify-send`, Windows PowerShell toast; a missing/denied mechanism silently no-ops. Disable with `whatsappman settings set notifications false`.

> **macOS caveat:** notifications are attributed to **Script Editor**. If they don't appear, enable **System Settings → Notifications → Script Editor → Allow Notifications**.

## A word of caution

Baileys is an unofficial reverse-engineering of WhatsApp Web — great for personal / low-volume use; automated **bulk** blasting risks a ban. The `defaultDelayMs` / `maxBulkRecipients` throttles exist for that reason.

**Keep `~/.whatsappman` out of cloud sync and backups** — it holds your live linked-device credentials; a synced copy is a portable clone of your WhatsApp connection. Exclude it from iCloud Drive, Time Machine, Dropbox, OneDrive.

## Docs

- [docs/FEATURES.md](docs/FEATURES.md) — features, flow & how it works (non-technical + technical)
- [CONTEXT.md](CONTEXT.md) — condensed overview, status, key decisions
- [docs/PLAN.md](docs/PLAN.md) — full architecture · [docs/SKILLS.md](docs/SKILLS.md) — MCP tools · [docs/CLI.md](docs/CLI.md) — CLI commands
- [docs/SECURITY.md](docs/SECURITY.md) — threat model & hardening · [docs/CROSS-OS.md](docs/CROSS-OS.md) — platform matrix
- [docs/STANDARDS.md](docs/STANDARDS.md) — conventions · [docs/CHECKLIST.md](docs/CHECKLIST.md) — build log · [CHANGELOG.md](CHANGELOG.md) — releases

## Acknowledgements

whatsappman stands on [**Baileys**](https://github.com/WhiskeySockets/Baileys) — the WebSocket WhatsApp Web library that does the genuinely hard part: the protocol, the pairing, the encryption, the reconnects. Everything here is a daemon, an MCP server, and a CLI wrapped around it. Thank you to [Adhiraj Singh](https://github.com/adiwajshing), who wrote the original, and to Rajeh Taher and the [WhiskeySockets](https://github.com/WhiskeySockets) maintainers who carry it forward. MIT-licensed, and used as such.

Thanks also to:

- [**@modelcontextprotocol/sdk**](https://github.com/modelcontextprotocol/typescript-sdk) — Anthropic's TypeScript SDK for the Model Context Protocol, which is what lets your AI talk to this thing at all.
- [**pino**](https://github.com/pinojs/pino), [**qrcode**](https://github.com/soldair/node-qrcode), [**zod**](https://github.com/colinhacks/zod), [**open**](https://github.com/sindresorhus/open), [**picocolors**](https://github.com/alexeyraspopov/picocolors), and [**mime-types**](https://github.com/jshttp/mime-types) — small, sharp dependencies that each do one job well.

Not affiliated with, endorsed by, or connected to WhatsApp or Meta.

## License

MIT
