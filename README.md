# whatsappman — `@indianic/whatsappman`

An MCP server + CLI that lets any Claude CLI session send WhatsApp messages —
text, images, documents, locations, contacts — with a preview/confirmation
step before anything actually goes out, **multiple linked numbers**, and a
send log. Pure Node.js, so it runs the same way on macOS, Linux, and Windows.
Configured once, globally, and available from any project you run Claude in —
not tied to a single repo.

Under the hood it pairs [Baileys](https://github.com/WhiskeySockets/Baileys)
(the WhatsApp Web protocol client) with a small **always-on local daemon**.
There is **no third-party WhatsApp API, no API keys, no server you rent, no
database, and no web dashboard** — your own machine becomes a WhatsApp
"linked device" (exactly like scanning the QR for WhatsApp Web in a browser),
and the daemon holds that connection open so a send from Claude just works.

> **Package vs. command names.** The npm package is
> **`@indianic/whatsappman`** (that's what you `npx` / `npm install` /
> register with Claude). It installs a CLI you run as **`whatsappman`**
> (`whatsappman init`, `whatsappman status`, …). A second alias,
> **`mcp-whatsappman`**, points at the same binary.

## Why a daemon (and why that's unavoidable)

Email is stateless — SMTP connects on demand, sends, and disconnects, so
[mailman](../mailman) needs no background process. WhatsApp is the opposite:
Baileys holds a **persistent WebSocket** to WhatsApp's servers, and if that
socket dies you can't send until something reconnects it. So whatsappman
splits into two pieces:

- **`whatsappmand` — the daemon.** Always running (installed as a
  `launchd`/`systemd`/Task-Scheduler job by `whatsappman init`). Holds the
  Baileys socket(s) + credentials, auto-reconnects, and is the *only* piece
  that talks to WhatsApp. One per machine; it can hold **several numbers at
  once**.
- **The MCP server + CLI — thin clients.** Ephemeral. Claude spawns the MCP
  server per session; you run the CLI in a terminal. Both just talk to the
  daemon over a local **Unix domain socket** (`~/.whatsappman/daemon.sock`) —
  no network, no port, no IP.

You scan a QR **once** per number; the credentials persist to disk and
survive reboots, so you never re-pair unless WhatsApp itself expires the link.

## Examples

```
You: whatsappman, send "running 10 min late" to Kalpesh
Claude: [resolves the contact, drafts the message]
        Ready to send via "work" (+91 98xxxxxxx0)?
          To: Kalpesh Gamit
          Text: running 10 min late
        Confirm?
You: yes
Claude: Sent. ✓ delivered
```

```
You: whatsappman, send plan.pdf to the "Project Falcon" group
Claude: [resolves the group JID, resolves the attachment]
        Ready to send via "work"?
          To: Project Falcon (group)
          Document: plan.pdf (240 KB)
        Confirm?
You: yes
Claude: Sent.
```

```
You: whatsappman, which numbers are connected?
Claude: [1] work      +91 98xxxxxxx0   connected
        [2] personal   +91 99xxxxxxx1   needs_relink  (run: whatsappman relink personal)
```

## Status

**Planning stage — nothing built yet.** This repo currently holds the design
docs. See [docs/CHECKLIST.md](docs/CHECKLIST.md) for the phased build order
and [docs/PLAN.md](docs/PLAN.md) for the full architecture.

The Baileys session/send logic is not written from scratch: it is adapted
from IndiaNIC's existing **`@mcphub/plugin-baileys-whatsapp`** plugin
(specifically its `src/standalone/` variant — the "no mcphub-core, no Redis,
filesystem-auth" build), and the daemon install/lifecycle is modeled on the
**newra** agent daemon (`launchd` `RunAtLoad` + `KeepAlive`) and mailman's
`ticker-install.ts` (the launchd/cron/Task-Scheduler PATH handling).

Deliberately **out of scope** (keeping this a pure send tool): inbound message
handling/replies, webhooks, a web dashboard, a database, multi-tenant/customer
scoping, group administration.

## Docs

- [CONTEXT.md](CONTEXT.md) — start here: condensed overview, status, key decisions
- [docs/PLAN.md](docs/PLAN.md) — full architecture: daemon, socket IPC, sessions, tools, flows
- [docs/SKILLS.md](docs/SKILLS.md) — the MCP tools this server exposes ("skills"), called by Claude
- [docs/CLI.md](docs/CLI.md) — the terminal commands you run yourself (daemon + number management)
- [docs/STANDARDS.md](docs/STANDARDS.md) — design, security, and coding conventions (inherited from mailman)
- [docs/SECURITY.md](docs/SECURITY.md) — threat model, daemon access control, and hardening
- [docs/CROSS-OS.md](docs/CROSS-OS.md) — cross-platform support matrix (macOS, Windows, Ubuntu/Xubuntu/Alpine Linux)
- [docs/CHECKLIST.md](docs/CHECKLIST.md) — phased implementation checklist

## Quick setup (planned)

One command does the whole thing — installs the always-on daemon, links your
first number by QR, and **writes the MCP config into whichever AI tools you
pick** (Claude Code, Cursor, Gemini CLI, Windsurf, Codex):

```bash
npx @indianic/whatsappman init
```

Then, from any Claude session: *"whatsappman, send … to …"* — draft, confirm,
sent.

## The reliability promise

Everything that can be engineered for reliability is:

- Daemon crashes → `launchd`/`systemd` `KeepAlive` restarts it in seconds.
- Machine reboots / you log in → `RunAtLoad` auto-starts it.
- Machine wakes from sleep → Baileys auto-reconnects each session.

The one thing no local code can prevent is **WhatsApp itself invalidating a
pairing** (you log the device out, your phone stays offline for ~14 days, or
the number gets flagged). When that happens whatsappman marks the session
`needs_relink` and **every send returns a clear, actionable error rather than
silently failing** — you never get a false "sent." That's the honest
guarantee: *100% reliable feedback, ~99% availability while your machine is
awake and online.*

## A word of caution

Baileys is an unofficial reverse-engineering of WhatsApp Web. It's well-suited
to personal and low-volume use; automated **bulk** blasting risks getting the
number banned by WhatsApp. The `defaultDelayMs` / `maxBulkRecipients` throttles
exist for exactly this reason — use them.

## License

MIT
