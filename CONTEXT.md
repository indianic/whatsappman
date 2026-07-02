# whatsappman — Context

Start here. This is the condensed orientation doc — everything below is
explained in full depth in `docs/`; this file exists so a human or an AI
session picking up this repo cold doesn't have to read all four docs before
understanding what whatsappman is and why it's built the way it is.

## What it is

`whatsappman` is a standalone MCP server + CLI (its own npm package, its own
repo — not part of any other project) that lets any Claude CLI session send
WhatsApp messages (text, image, document, location, contact) through
[Baileys](https://github.com/WhiskeySockets/Baileys), with a draft/confirm
step, **multiple linked numbers**, and a send log. Registered globally, so it
works the same way from any project directory on macOS, Linux, or Windows —
not something you set up per-repo.

It runs **entirely on the local machine**: your Mac/PC becomes a WhatsApp
"linked device" (like WhatsApp Web in a browser). There is **no third-party
WhatsApp API, no API keys, no rented server, no database, and no frontend** —
the only external party is WhatsApp's own servers, which is unavoidable (that's
who delivers the message).

## Status

**Functionally complete, self-verified on macOS, committed on `dev-kalpesh`.**
See [docs/CHECKLIST.md](docs/CHECKLIST.md) for the per-phase done-vs-deferred
breakdown.

- **Built (phases 0–8 + notifications)**: two-process daemon + local-socket IPC
  (capability token, zod validation, method allowlist); Baileys link with a
  terminal QR; multi-number; draft→confirm→send across all five kinds (text,
  image, document, location, contact); bulk; daemon-held scheduling; history;
  settings; desktop notifications; `init`/`doctor`/`register`/`reset`; OS
  autostart (launchd/systemd/OpenRC). **50 tests**, lint/typecheck/build green,
  every CLI command + all 12 MCP tools smoke-tested on this machine.
- **Not done (needs hardware / external step)**: real QR-scan + delivery + a
  reconnect-after-restart sign-off (needs a phone); keytar cred encryption,
  `getpeereid()` peer-UID check, Windows named-pipe ACL (native deps / a Windows
  box — see [docs/SECURITY.md](docs/SECURITY.md)); cross-OS verification beyond
  macOS; `npm publish` (only after explicit confirmation).
- **Reuse, not from-scratch**: the Baileys session/send logic is adapted from
  IndiaNIC's `@mcphub/plugin-baileys-whatsapp` plugin's `src/standalone/`
  variant (no mcphub-core, no Redis, filesystem-auth). The daemon
  install/lifecycle is modeled on the **newra** agent daemon and mailman's
  `src/scheduler/ticker-install.ts`.
- **Deploy target**: `@indianic/whatsappman` on the IndiaNIC private registry
  (`npm.indianic.in`) — **only after explicit confirmation**, never
  automatically.

## Repo facts

| | |
|---|---|
| Location | `/Users/kalpesh/Sites/IndiaNIC/Products/WhatsAppMan/` (sibling to `mailman`) |
| Package name | `@indianic/whatsappman` (npm, unpublished) |
| Bin name | `whatsappman` (primary), `mcp-whatsappman` (alias to the same binary) |
| Registry | `npm.indianic.in` (publish pending confirmation) |
| Reference projects | `../mailman` (UX/structure), `mcphub/packages/plugins/baileys-whatsapp` (Baileys logic), newra daemon (`~/.newra`, launchd pattern) |

## The one architectural fact that shapes everything

**WhatsApp needs a persistent connection; email does not.** mailman is a pure
ephemeral stdio process because SMTP is stateless. whatsappman cannot be —
Baileys holds a live WebSocket to WhatsApp, so whatsappman is **two
processes**:

- **`whatsappmand` (daemon)** — always-on background process (installed as a
  `launchd`/`systemd`/Task-Scheduler job by `whatsappman init`, `RunAtLoad` +
  `KeepAlive`-on-crash). Owns the Baileys socket(s) + creds, auto-reconnects,
  holds **multiple numbers** at once. The only piece that touches WhatsApp.
- **MCP server + CLI (clients)** — ephemeral. Talk to the daemon over a local
  **Unix domain socket** (`~/.whatsappman/daemon.sock`; a named pipe on
  Windows). No network, no port, no IP.

## The decisions that shape everything else

- **Daemon vs. clients is a hard split.** All WhatsApp state (sockets, creds,
  scheduled queue) lives in the daemon. The MCP server and CLI are stateless
  clients that RPC into it. Kill/restart a client mid-send and nothing is
  lost; kill the daemon and `launchd`/`systemd` brings it back.
- **MCP tools vs. CLI commands is a hard split.** Anything Claude can call
  conversationally (send, status, list numbers) is an MCP tool. Anything
  interactive, destructive, or QR-dependent (`init`, `link`/`relink` QR
  scanning, `delete`, daemon `install`/`uninstall`, `reset`) is terminal-only
  CLI, never LLM-callable. See [docs/SKILLS.md](docs/SKILLS.md) vs
  [docs/CLI.md](docs/CLI.md).
- **Nothing sends without a preview first.** Every send is `draft_message`
  (builds a preview, does not send) → `confirm_send` (the only tool that
  actually dispatches). `confirm_send` is idempotent so a retried call can't
  double-send. WhatsApp sends are instant and irreversible — this matters more
  here than it did for email.
- **Config is global, never project-relative.** One directory per OS user
  (`~/.whatsappman/`), resolved via `os.homedir()`, never `cwd`. Set up once
  per machine, works from every project.
- **Multiple numbers, each a session on disk.** Each linked number is a folder
  under `~/.whatsappman/sessions/<label>/` with its own Baileys `auth/` creds
  and a `meta.json` (phone, status, lastConnected). The daemon loads every
  session on boot and reconnects each, so all numbers come back after a reboot.
- **`state.json`'s `defaultSession` is the single source of truth** for which
  number sends when a call omits `from` — sessions never carry their own
  `isDefault` flag (a lesson taken straight from mailman).
- **Every MCP response is JSON in a text block**, matching the convention used
  by mailman and this developer's other MCP servers — host-agnostic (Claude
  Code, Cursor, Windsurf all parse the same JSON). Failures are structured
  `{ code, message }`, not just prose, so Claude can branch on `code`.
- **Pre-send health check, honest errors.** Every send first checks the target
  session is `connected`. If not, it returns `DAEMON_DOWN` / `NEEDS_RELINK` /
  `SESSION_NOT_CONNECTED` with the exact command to fix it — never a false
  "sent."
- **Scheduling lives in the daemon, not an OS ticker.** Because the daemon is
  already always-on, "send this at 9am" is just a persisted queue
  (`scheduled.json`) + an in-daemon timer — no `launchd`/cron dispatch trick
  needed (that was mailman's workaround for *not* having a daemon).
- **Auth creds are on-disk, machine-local.** Baileys creds live under
  `sessions/<label>/auth/` with `0600` perms; the socket file is `0600` too —
  filesystem permissions are the daemon's access control. (Optional keychain
  encryption of creds is a possible later hardening, noted in PLAN.)

## Full docs

- [README.md](README.md) — pitch, install, usage examples
- [docs/PLAN.md](docs/PLAN.md) — the full architecture (this file's source material)
- [docs/SKILLS.md](docs/SKILLS.md) — every MCP tool, called by Claude
- [docs/CLI.md](docs/CLI.md) — every terminal command, run by you
- [docs/STANDARDS.md](docs/STANDARDS.md) — design/security/coding conventions inherited from mailman
- [docs/SECURITY.md](docs/SECURITY.md) — threat model, daemon access control, hardening (read before building the daemon)
- [docs/CROSS-OS.md](docs/CROSS-OS.md) — macOS/Windows/Linux (Ubuntu/Xubuntu/Alpine) support matrix + per-OS daemon & keychain notes
- [docs/CHECKLIST.md](docs/CHECKLIST.md) — the phased build order
