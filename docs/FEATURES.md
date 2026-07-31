# WhatsAppMan — Features, Flow & How It Works

> **Package:** `@integratex/whatsappman` · **Version:** see [npm](https://www.npmjs.com/package/@integratex/whatsappman) · **Author:** kalpesh · **License:** MIT
> **Registry:** [npmjs.com](https://www.npmjs.com/package/@integratex/whatsappman) (public) · **Status:** published & working (macOS verified live)

This document explains WhatsAppMan for **everyone** — a plain-English part for
anyone, and a deeper technical part for developers. Read the section that fits
you; they cover the same product at different depths.

---

# Part 1 — For Everyone (non-technical)

## What is it?

WhatsAppMan lets you **send WhatsApp messages by just asking your AI assistant**
(like Claude), or by typing a short command in your terminal. You can send:

- 💬 text messages
- 🖼️ images
- 📄 documents / files
- 📍 locations
- 👤 contact cards
- 📢 the same message to many people (bulk)
- ⏰ a message scheduled for later ("send this at 9am")

You link your WhatsApp number **once** (by scanning a QR code, just like
WhatsApp Web), and after that it "just works" — even after you restart your
computer.

## What makes it different / safe?

- **Runs entirely on your own computer.** There is no outside company, no paid
  "WhatsApp API", no server you rent, and no database. Your machine talks
  directly to WhatsApp, exactly like WhatsApp Web in a browser.
- **Nothing is sent by surprise.** The AI always shows you a **preview** and
  waits for your **"yes"** before a message actually goes out.
- **It tells you the truth.** If something is wrong (your number got logged out,
  no internet, etc.), it says so clearly — it never pretends a message was sent
  when it wasn't.
- **It warns you on your Mac** when something needs attention (e.g. "your number
  needs re-linking") with a desktop notification.

## A picture of how it works

```
   You (or Claude)                Your computer                     WhatsApp
   "send hi to Kalpesh"   ───►   WhatsAppMan  ─── keeps a ───►   WhatsApp servers
                                  (runs quietly    live link       (deliver message)
                                   in background)
```

Think of it as a small helper that stays logged into WhatsApp for you, so
whenever you (or your AI) want to send something, it's ready instantly.

## Getting started (one time)

1. Install & set up with a single command:
   ```
   npx @integratex/whatsappman init
   ```
2. A **QR code** appears in your terminal → open **WhatsApp → Settings →
   Linked Devices → Link a Device** → scan it.
3. Done. Now just tell Claude: *"whatsappman, send 'running late' to Kalpesh."*

## The everyday flow

```
You ask  →  AI writes the message  →  AI shows you a PREVIEW  →  You say "yes"  →  Sent ✓
```

## Good to know

- The number you link is a **linked device** (like WhatsApp Web). WhatsApp may
  ask you to re-scan the QR occasionally (e.g. if your phone is offline for ~2
  weeks) — WhatsAppMan will notify you when that happens.
- Please **don't blast marketing spam** — WhatsApp can ban a number that sends
  bulk automated messages. WhatsAppMan has built-in slow-downs and limits to
  keep you safe, but the caution is real.

---

# Part 2 — For Developers (technical)

## One-line description

A standalone **MCP server + CLI** that sends WhatsApp messages through
[Baileys](https://github.com/WhiskeySockets/Baileys), backed by an **always-on
local daemon**. Pure Node.js (≥18). No third-party API, no server, no database,
no web UI. macOS / Linux / Windows.

## Why two processes (the core design decision)

Email is stateless (SMTP connects on demand), but **WhatsApp needs a persistent
connection** — Baileys holds a live WebSocket, and that connection *is* the
login. So WhatsAppMan splits into two pieces:

```
┌─────────────────────────────┐        Unix domain socket             ┌────────────────────────────┐
│  MCP server (stdio)          │   ~/.whatsappman/daemon.sock          │  whatsappmand (daemon)      │
│  — Claude spawns per session │  ───────────────────────────────►    │  • holds Baileys WS socket  │
│    (ephemeral)               │      newline-delimited JSON-RPC        │    (1 per linked number)    │
├─────────────────────────────┤  ◄───────────────────────────────    │  • auth creds on disk       │
│  CLI (whatsappman <cmd>)     │       (capability-token auth)          │  • auto-reconnect + backoff │
│  — you, in a terminal        │                                        │  • scheduled-send queue     │
└─────────────────────────────┘                                        │  • launchd/systemd autostart│
                                                                        └──────────────┬───────────────┘
                                                                                       ▼
                                                                              WhatsApp servers
                                                                        (this machine = linked device)
```

- **The daemon** is the only piece that imports Baileys and touches WhatsApp. It
  owns all live state (sockets, drafts, timers).
- **The MCP server and CLI are thin clients** — connect, send one request, read
  one response, close. They hold no WhatsApp state, so they can be killed/started
  freely.
- **Transport:** a Unix-domain socket (named pipe on Windows) — local-only, no
  network surface.

## Component map

| Layer | Files | Responsibility |
|---|---|---|
| Entry | `src/index.ts`, `bin/whatsappman.js` | argv dispatch: daemon \| MCP-when-piped \| CLI; Node≥18 gate |
| Daemon | `src/daemon/main.ts`, `lock.ts` | single-instance lock, token, IPC server, boot/shutdown |
| WhatsApp | `daemon/session-manager.ts`, `contact-service.ts`, `attachments.ts`, `markup.ts`, `bulk.ts`, `rate-limit.ts`, `draft-store.ts`, `scheduler.ts`, `notify.ts` | sessions, sending, resolution, formatting, scheduling, notifications |
| IPC | `src/ipc/protocol.ts`, `transport.ts`, `access.ts`, `server.ts`, `client.ts` | token-authed JSON-RPC over the local socket |
| MCP | `src/mcp/server.ts` | 12 tools proxying to the daemon |
| CLI | `src/cli/*.ts` | commands, diamond-tree renderer, update-notifier |
| Config | `src/config/*.ts` | `~/.whatsappman/` state, atomic writes, zod schemas |

## What's stored, and where

```
~/.whatsappman/                 (0700 — per-user, never project-relative)
├── daemon.sock                 IPC socket (0600)
├── daemon.pid / daemon.token   single-instance lock + capability token (0600)
├── state.json                  daemonId, hostname, defaultSession
├── settings.json               tunables (see below)
├── scheduled.json              future sends (survive restarts)
├── sent.jsonl                  append-only send log (metadata only, rotates at 5MB)
├── update-check.json           cached "latest version" for the notifier
├── logs/daemon.{out,err}.log
└── sessions/<label>/
    ├── auth/                    Baileys creds (0700) — survive reboot
    └── meta.json                phone, status, timestamps
```

## Feature list (all built & working)

### Messaging
- **5 message kinds** — text, image, document, location, contact (vcard).
- **Markdown → WhatsApp formatting** — `**bold**`→`*bold*`, `~~strike~~`→`~strike~`,
  `# heading`→bold line, `[text](url)`→`text (url)`; single `*_~`/backticks/lists/
  quotes/newlines pass through. `--raw` / `raw:true` to send verbatim.
- **Smart recipient resolution** — accepts a JID, a phone number, a saved-contact
  name, or a group name; validated against WhatsApp (`onWhatsApp`).
- **Default country code** — a bare number gets `+91` (India) by default;
  `+<cc>` numbers keep their own code; configurable via settings.
- **Bulk send** — one message to many, throttled + capped.

### Safety
- **Draft → confirm → send** — the only way to dispatch; `confirm_send` is
  idempotent (a retry never double-sends).
- **Pre-send health check** — refuses to "send" if the number isn't connected,
  with an actionable error. Never a false "sent."
- **Attachment path guard** — refuses `~/.ssh`, `*.env`, `~/.aws`, keychains, the
  config dir → `ATTACHMENT_FORBIDDEN`; size cap; MIME inference.
- **Rate limiter** — per-session token bucket (anti-ban / anti-runaway).

### Numbers (sessions)
- **Multiple numbers**, each linked by QR, each with independent status.
- Lifecycle: `link` · `relink` · `reconnect` · `disconnect` · `delete` · `default`.
- **Auto-reconnect** with bounded exponential backoff; logged-out → `needs_relink`
  (no infinite loop).
- On daemon boot, every linked number is reconnected automatically.

### Scheduling
- **Daemon-held scheduled sends** — persisted to disk, re-armed on restart, fired
  via the same health-check + send path. One-time schedules.

### Operations & UX
- **One-command setup** (`init`), `doctor`, `register` (MCP config), `reset`.
- **OS autostart** — launchd (macOS) / systemd-user (Linux) / OpenRC (Alpine) /
  nohup fallback; runs at login, restarts on crash.
- **Self-update** (`update`/`upgrade`) + a passive "update available" notifier.
- **Desktop notifications** — macOS (`osascript`), Linux (`notify-send`), Windows
  (PowerShell toast); fired on `needs_relink` and scheduled sends. Best-effort.
- **Send history** (`recent`), **settings** (`settings get/set`).
- **TTY guard** — interactive commands refuse to run (with a clear message) in a
  non-terminal shell instead of hanging.
- **Every command asks** — `default`, `delete`, `rename`, `relink`, `reconnect`,
  `disconnect`, `scheduled cancel`, `settings set` and `presence` run without a
  value show an ↑/↓ menu instead of a `usage:` line. One layer
  (`src/cli/prompts.ts`) guarantees Esc always cancels, that **cancel never
  counts as consent** on destructive prompts, and that a non-TTY fails fast
  rather than blocking on a menu nobody can answer.

### Daily drivers (0.4.x)
- **`run -- <command>`** — run anything, then get told on WhatsApp how it went:
  ✅/❌, duration, exit code, and on failure the tail of the output. The exit
  code is propagated, so it drops into an existing script or CI step. `--on-fail`
  notifies only on breakage. This covers the highest-traffic patterns in
  USE-CASES.md *including the failure branch* that hand-wired
  `&& whatsappman send …` always misses.
- **`summary`** — a digest of your AI coding sessions: what you worked on, for
  how long, across which projects. Built from local Claude Code transcripts with
  **no model call**, carrying titles, counts and durations only — never message
  content. `--to` sends it (the daily standup, written for you).
- **`me <text>`** — message yourself; resolves the sending number's own phone.
- **`rename`** — rename a number keeping creds + history, carrying the default
  pointer over and reconnecting without a QR.
- **`presence`** — a typing/online indicator. A status signal, not a message: no
  content is delivered and nothing is written to the audit log.
- **`doctor --fix`** — reports Node, **git**, npm, daemon, perms and connections,
  and prints the platform-correct install command for anything missing.

## The MCP tools (what Claude can call)

12 tools, all returning JSON. **There is no raw "send" tool** — sending is only
`draft_message` → `confirm_send`, so an AI can never dispatch an unpreviewed
message. Anything destructive (delete, disconnect, relink) or mass (bulk) is
**CLI-only**, never LLM-callable.

| Tool | Purpose |
|---|---|
| `get_status` | daemon + all numbers + pending-scheduled count |
| `list_sessions` | linked numbers with status |
| `health_check` | can a number send right now? |
| `resolve_recipient` | name/phone/group → JID (validated) |
| `list_groups` | groups a number belongs to |
| `draft_message` | build a preview (does NOT send) |
| `confirm_send` | the only dispatcher; idempotent |
| `cancel_draft` | discard a pending draft |
| `schedule_send` | send a draft at a future time |
| `list_scheduled` / `cancel_scheduled` | manage scheduled sends |
| `list_recent` | send history (metadata only) |

## The CLI commands (what you type)

```
Setup:    init · doctor [--fix] · register · daemon install|uninstall
Daemon:   start · stop · restart · status
Numbers:  link · relink · reconnect · disconnect · rename · delete · numbers
          status [<label>] · default
Send:     send · send-bulk · presence · me
Daily:    run -- <command> · summary
Later:    scheduled [cancel] · recent
Config:   settings get|set · update (upgrade) · reset
Help:     help · examples · version
```

Commands taking a `<label>` also accept it as a menu: omit the value and they
list your numbers to pick from. See [CLI.md](CLI.md) for every flag.

## Key flows (step by step)

### 1) First-time setup (`init`)
```
whatsappman init
  → require a real terminal (TTY guard)
  → daemon install  (write launchd/systemd job)
  → daemon start    (detached; confirmed via ping)
  → link first number → render QR → you scan on your phone
  → register        (print `claude mcp add …`)
```

### 2) Sending (draft → confirm)
```
Claude: draft_message { to:"Kalpesh", text:"**on my way**" }
  daemon: resolve recipient (onWhatsApp, +91 default)
        → Markdown→WhatsApp markup
        → store draft (in-memory, TTL)
        → return { draftId, preview }
Claude shows preview → user says "yes"
Claude: confirm_send { draftId }
  daemon: pre-send health check (connected?)
        → send via Baileys → { messageId }   (idempotent)
        → append to sent.jsonl
```

### 3) Scheduling
```
draft_message → schedule_send { draftId, fireAt }
  daemon: snapshot the draft into scheduled.json, arm a timer
  (daemon restart? → reload scheduled.json, re-arm)
  at fireAt: health check → send → mark sent/failed → notify + log
```

### 4) Connection resilience
```
socket drops (network / sleep)
  → transient?  auto-reconnect with backoff (3s → … → 60s cap), reset on connect
  → logged out? status = needs_relink (stop retrying) → desktop notification
                → user runs `whatsappman relink <label>` → scan a fresh QR
```

### 5) Desktop notification (verified live on macOS)
```
event (needs_relink | scheduled sent/failed)
  → notify(title, body)  [best-effort, never blocks]
  → macOS: osascript 'display notification'  → banner (shown as "Script Editor")
  → Linux: notify-send   Windows: PowerShell toast
```
> macOS caveat: allow **System Settings → Notifications → Script Editor**, or the
> banner silently no-ops.

### 6) Self-update
```
whatsappman update
  → npm view @integratex/whatsappman version   (registry)
  → strictly newer? → npm install -g @latest → restart daemon (loads new code)
  → else "already up to date"
Passive notifier: a cached, TTY-only "update available" line before commands.
```

## Security model (summary)

- **Local-only IPC** — 0600 socket in a 0700 dir; the OS user is the trust
  boundary (same as your SSH keys / keychain). Honest statement: this is not
  isolation from *same-user* code — only OS sandboxing gives that.
- **Capability token** — 256-bit, per-startup, required on every IPC request.
- **Validation** — every request is zod-checked against a method allowlist,
  size-capped.
- **No secrets leak** — creds never logged; `sent.jsonl` is metadata only; the
  pairing QR is terminal-only.
- **Deferred (honest)** — keytar-backed at-rest cred encryption, an explicit
  peer-UID check, and the Windows named-pipe ACL are documented but not yet
  built (native-dep / hardware constraints). See `docs/SECURITY.md`.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `draftTtlMinutes` | 10 | how long a draft stays valid |
| `defaultDelayMs` | 2000 | delay between bulk messages (ban-safety) |
| `maxBulkRecipients` | 100 | bulk cap |
| `alwaysConfirm` | true | require preview/confirm |
| `notifications` | true | desktop notifications on/off |
| `defaultCountryCode` | 91 | prepended to bare numbers (India) |

## Quality & status

- **67 unit tests** pass; lint + typecheck + build clean.
- **Verified live on macOS**: link/QR, real send + delivery, Markdown formatting,
  scheduled send, desktop notification banner, self-update.
- **Published** as `@integratex/whatsappman` on the public npm registry.
- **Remaining** (needs other hardware, not code): Linux/Windows banner sign-off,
  cross-OS smoke tests, and the deferred native-dep security hardening.

## Related docs

- [`../README.md`](../README.md) — pitch + install
- [`../CONTEXT.md`](../CONTEXT.md) — condensed orientation + key decisions
- [`PLAN.md`](PLAN.md) — full architecture · [`SKILLS.md`](SKILLS.md) — MCP tools · [`CLI.md`](CLI.md) — commands
- [`SECURITY.md`](SECURITY.md) — threat model · [`CROSS-OS.md`](CROSS-OS.md) — platform matrix
- [`STANDARDS.md`](STANDARDS.md) — conventions · [`CHECKLIST.md`](CHECKLIST.md) — build log · [`../CHANGELOG.md`](../CHANGELOG.md) — release notes
