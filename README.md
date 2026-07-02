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

**Functionally complete and self-verified on macOS; not yet real-hardware
signed-off or published.** All core phases are built and committed on the
`dev-kalpesh` branch: the two-process daemon + local-socket IPC (capability
token, zod validation), Baileys linking with a terminal QR, multi-number
support, the draft→confirm→send flow across all five message kinds (text,
image, document, location, contact), bulk send, daemon-held scheduling, send
history, settings, desktop notifications, `init`/`doctor`/`register`/`reset`,
and the OS autostart install (launchd/systemd/OpenRC). Registering the MCP
server is one command (`register --write [--tools …]`) that wires up Claude
Code, Cursor, Gemini CLI, Windsurf, and Codex. **83 unit tests pass**
(lint + typecheck + build green), and every CLI command + all 12 MCP tools have
been smoke-tested end-to-end on this machine.

What's **not** done, and honestly so — each needs hardware or an external step I
can't self-serve:

- **Real send sign-off** — an actual QR scan + message delivery + reconnect-
  after-restart needs a phone. Everything up to the scan is verified.
- **Deferred security hardening** — keytar-backed credential encryption (a
  native dep that would break the pure-Node/Alpine promise), an explicit
  `getpeereid()` peer-UID check (needs a native addon; the `0600` socket already
  enforces the same-UID boundary), and the Windows named-pipe ACL — see
  [docs/SECURITY.md](docs/SECURITY.md).
- **Cross-OS verification** — coded for macOS/Linux/Windows, only exercised on
  macOS so far (see [docs/CROSS-OS.md](docs/CROSS-OS.md)).
- **`npm publish` to `npm.indianic.in`** — pending, and only ever after
  explicit confirmation.

See [docs/CHECKLIST.md](docs/CHECKLIST.md) for the exact done-vs-deferred
breakdown per phase and [docs/PLAN.md](docs/PLAN.md) for the architecture.

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

- [docs/FEATURES.md](docs/FEATURES.md) — **features, flow & how it works** (non-technical + technical, with diagrams)
- [CONTEXT.md](CONTEXT.md) — start here: condensed overview, status, key decisions
- [docs/PLAN.md](docs/PLAN.md) — full architecture: daemon, socket IPC, sessions, tools, flows
- [docs/SKILLS.md](docs/SKILLS.md) — the MCP tools this server exposes ("skills"), called by Claude
- [docs/CLI.md](docs/CLI.md) — the terminal commands you run yourself (daemon + number management)
- [docs/STANDARDS.md](docs/STANDARDS.md) — design, security, and coding conventions (inherited from mailman)
- [docs/SECURITY.md](docs/SECURITY.md) — threat model, daemon access control, and hardening
- [docs/CROSS-OS.md](docs/CROSS-OS.md) — cross-platform support matrix (macOS, Windows, Ubuntu/Xubuntu/Alpine Linux)
- [docs/CHECKLIST.md](docs/CHECKLIST.md) — phased implementation checklist

## Quick setup

One command does the whole thing — installs the always-on daemon, links your
first number by QR, and prints the MCP registration for your AI tools:

```bash
# once published:  npx @indianic/whatsappman init
# from the repo now:  npm i && npm run build && node dist/index.js init
```

`init` runs: install the OS autostart daemon → start it → render a QR to scan
(WhatsApp → Linked Devices) → print the `claude mcp add` line. Then, from any
Claude session: *"whatsappman, send … to …"* — draft, confirm, sent.

> **Note:** `init` loads a real OS login-item (launchd/systemd) and the QR scan
> pairs your live WhatsApp account — both are deliberate, one-time actions you
> run yourself, not part of any build or test.

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

## Desktop notifications

Because the daemon runs in the background, whatsappman fires an **OS desktop
notification** for the events you'd otherwise miss — **default-on**:

- a linked number drops to `needs_relink` (you were logged out → a send will
  fail until you re-scan a QR);
- a **scheduled** send fires (sent ✓ or failed ✗).

They're **best-effort**: whatsappman never depends on a notification being
delivered, and if the OS mechanism is missing or not permitted it **silently
no-ops** — it never blocks or fails a send.

| OS | Mechanism | Needs |
|---|---|---|
| **macOS** | `osascript -e 'display notification …'` | notifications allowed for **Script Editor** — see the caveat below |
| **Linux / BSD** | `notify-send` (libnotify) | `libnotify` installed + a notification daemon running (a desktop session; headless servers have none → no-op) |
| **Windows** | PowerShell WinRT toast | PowerShell (built in); toasts enabled for the session |

**Disable them** any time:

```bash
whatsappman settings set notifications false     # persistent
# or, per-process:
WHATSAPPMAN_NOTIFICATIONS=0 whatsappman start
```

### ⚠️ macOS caveat — "notifications don't show up"

On macOS, whatsappman fires notifications via `osascript`, and macOS attributes
them to the **Script Editor** app, *not* to whatsappman. If Script Editor's
notifications are turned off, the call still succeeds but **nothing appears** —
a silent no-op that looks like a bug. To enable them:

> **System Settings → Notifications → Script Editor → Allow Notifications (on)**

This is almost always the fix when macOS notifications seem broken — it's a
one-time permission toggle, not a whatsappman problem.

## A word of caution

Baileys is an unofficial reverse-engineering of WhatsApp Web. It's well-suited
to personal and low-volume use; automated **bulk** blasting risks getting the
number banned by WhatsApp. The `defaultDelayMs` / `maxBulkRecipients` throttles
exist for exactly this reason — use them.

**Keep `~/.whatsappman` out of cloud sync and backups.** That folder holds your
live linked-device session creds — a synced or backed-up copy is a fully
portable clone of your WhatsApp connection. Exclude it from iCloud Drive, Time
Machine, Dropbox, and OneDrive; syncing it off-box defeats the machine-bound
protection. See [docs/SECURITY.md](docs/SECURITY.md) for the full rationale.

## License

MIT
