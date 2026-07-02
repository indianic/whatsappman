# whatsappman — Architecture Plan

`whatsappman` is a standalone, publishable npm package (not part of any other
repo) that runs an MCP server + CLI for sending WhatsApp messages. It is
registered globally with any Claude CLI installation and works on macOS,
Linux, and Windows. It is pure Node.js
([`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys),
`qrcode`, `pino`, `zod`, `@modelcontextprotocol/sdk`) plus one always-on
background process.

## Goals

- Send WhatsApp messages (text, image, document, location, contact) from a
  natural-language request in any Claude CLI session.
- Attach a document or image by explicit path — resolved by the calling Claude
  session from conversation context.
- Never send silently: every send is a **draft → preview → explicit
  confirmation → send** flow. (WhatsApp is instant and irreversible; this is
  even more important than it was for email.)
- Support **multiple linked numbers**, each with its own status, with a
  configurable default so the common case needs zero extra arguments.
- Send to individuals *and* groups; resolve recipients by saved contact name,
  not just raw JID.
- Support scheduling a send for a future time ("send this at 9am") that fires
  reliably from the always-on daemon.
- Store all state in one **global, per-OS-user** location — never
  project-relative — so it's configured once per machine and available from
  every project/terminal/Claude session.
- Run **entirely locally**: no third-party WhatsApp API, no API keys, no rented
  server, no database, no frontend.

## Non-goals (deliberately out of scope)

- **Inbound handling / auto-reply / webhooks.** whatsappman is a *send* tool.
  The daemon subscribes to connection events (for status) but does not process
  or expose incoming message content.
- **Web dashboard / frontend.** The plugin whatsappman borrows from ships 7
  frontends; whatsappman ships none. The CLI's terminal output is the only UI.
- **Database.** All state is flat files under `~/.whatsappman/`.
- **Multi-tenant / per-customer scoping.** Single-owner (the machine's user).
- **Group administration** (create/add/remove/promote). Sending *to* a known
  group is supported; managing groups is not.

## The two-process model — why a daemon exists

mailman (the sibling email tool) is a single ephemeral stdio process because
SMTP is stateless: connect, send, disconnect. WhatsApp is stateful — Baileys
maintains a persistent WebSocket to WhatsApp's servers, and the connection *is*
the login. So whatsappman is split:

```
┌──────────────────────────┐        Unix domain socket            ┌────────────────────────────┐
│  MCP server (stdio)       │   ~/.whatsappman/daemon.sock          │  whatsappmand (daemon)      │
│  — Claude spawns per      │  ───────────────────────────────►    │  • holds Baileys WS         │
│    session, ephemeral     │       newline-delimited JSON-RPC       │    socket(s), 1 per number  │
├──────────────────────────┤  ◄───────────────────────────────    │  • auth creds on disk       │
│  CLI (whatsappman <cmd>)  │                                        │  • auto-reconnect           │
│  — you, in a terminal     │                                        │  • scheduled-send queue     │
└──────────────────────────┘                                        │  • launchd/systemd RunAtLoad│
                                                                     └──────────────────────────────┘
                                                                                 │
                                                                                 ▼
                                                                        WhatsApp servers
                                                                     (this machine = linked device)
```

- **The daemon** (`whatsappmand`) is the only piece that imports Baileys and
  the only piece that talks to WhatsApp. It owns all live state: the socket per
  session, the in-memory draft store, the scheduled-send timers.
- **The MCP server and CLI are thin RPC clients.** They open the Unix socket,
  send one request, read one response, close. They hold no WhatsApp state, so
  they can be started/killed freely and there's never anything to lose.
- **Why a Unix domain socket, not TCP**: the daemon is local-only, so a socket
  file with `0600` perms needs no port, no IP, no bind-address config, and no
  token — the OS filesystem is the access control. On Windows there is no Unix
  socket, so the daemon listens on a **named pipe** (`\\.\pipe\whatsappman`)
  instead; the client picks transport by `process.platform`. (A future opt-in
  TCP-loopback+bearer-token mode, for reaching the daemon from another machine,
  is possible but explicitly not built — the product is local-only.)

### Daemon naming (modeled on newra)

newra names each daemon instance after the device (`deviceName:
"kalpesh.local"` in its `state.json`) and generates a per-instance launcher so
macOS's "Background Activity" list shows a meaningful name. whatsappman does
the same:

| Thing | Value (example on host `kalpesh.local`) |
|---|---|
| Instance id | `whatsappman-kalpesh-local` (derived from `os.hostname()`, slugified) |
| launchd label | `com.indianic.whatsappman.kalpesh-local` |
| systemd unit | `whatsappman.service` (user unit; `--user`) |
| Launcher script | `~/.whatsappman/bin/whatsappmand-kalpesh-local` |
| Socket | `~/.whatsappman/daemon.sock` |
| PID / state | `~/.whatsappman/daemon.pid`, `~/.whatsappman/state.json` |

One daemon per machine. A second number is a second **session inside the same
daemon**, never a second daemon.

## Package layout

```
whatsappman/
├── package.json          bin: "whatsappman" + "mcp-whatsappman", published to npm.indianic.in
├── src/
│   ├── index.ts            entrypoint — dispatches by argv: MCP server (stdio) | daemon | CLI
│   ├── mcp/
│   │   ├── server.ts        MCP stdio server; registers tools, each proxies to the daemon
│   │   └── tools/           one file per MCP tool — see docs/SKILLS.md
│   ├── cli/
│   │   ├── init.ts          first-run wizard: install daemon, link first number, write MCP config
│   │   ├── daemon.ts        install / uninstall / start / stop / restart / status / logs
│   │   ├── link.ts          link/relink a number — renders QR in the terminal (interactive → CLI only)
│   │   ├── numbers.ts        list / status / disconnect / delete / set-default
│   │   ├── register.ts      write whatsappman MCP config into Claude/Cursor/etc.
│   │   ├── doctor.ts        pre-flight: daemon reachable, socket perms, node PATH, each session's state
│   │   ├── status.ts        renders collectStatus() via @clack/prompts tree
│   │   └── reset.ts         wipe ~/.whatsappman (destructive, --yes required)
│   ├── daemon/
│   │   ├── main.ts          daemon entrypoint: open socket, load sessions, start scheduler loop
│   │   ├── ipc-server.ts    Unix-socket / named-pipe JSON-RPC listener + request router
│   │   ├── session-manager.ts   Baileys socket lifecycle per number — ADAPTED from the plugin's
│   │   │                        src/standalone/session-manager.standalone.ts
│   │   ├── message-service.ts   send text/image/document/location/contact — ADAPTED from the
│   │   │                        plugin's src/standalone/message-service.standalone.ts
│   │   ├── contact-service.ts   resolve saved-name → JID, list groups, onWhatsApp() check
│   │   ├── draft-store.ts    in-memory Map<draftId, Draft>, TTL, pending→sent|expired|cancelled
│   │   └── scheduler.ts      persisted queue + in-daemon timers; fires due sends via message-service
│   ├── ipc/
│   │   ├── client.ts         thin client the MCP server + CLI use to RPC the daemon (auto-spawns it if down, per policy below)
│   │   ├── protocol.ts       request/response types shared by client + server
│   │   └── transport.ts      platform transport: Unix socket (posix) | named pipe (win32)
│   ├── config/
│   │   ├── paths.ts          global config dir resolution (~/.whatsappman), honoring WHATSAPPMAN_DIR override
│   │   ├── state.ts          read/write state.json (defaultSession, hostname, daemon pid)
│   │   ├── sessions.ts       enumerate/read/write sessions/<label>/meta.json
│   │   └── schema.ts         zod schemas for state.json, meta.json, scheduled.json, settings.json
│   ├── status.ts             collectStatus() — shared by `whatsappman status` CLI + get_status tool
│   ├── response.ts           toolResponse()/toolError(code,message) — JSON-in-text helpers
│   ├── audit.ts              append-only sent.jsonl + activity.log writer
│   └── logging.ts            pino; redacts message bodies/creds by default
├── bin/whatsappman.js      thin shim — dispatches into dist/index.js by argv
└── README.md
```

## Config directory — global, per-OS-user

Everything lives under one directory resolved from `os.homedir()`, overridable
with `WHATSAPPMAN_DIR` (for tests / isolated setups):

```
~/.whatsappman/
├── daemon.sock                Unix socket (0600); named pipe on Windows (not a file)
├── daemon.pid                 running daemon PID
├── state.json                 { defaultSession, hostname, daemonId, startedAt }
├── settings.json              { draftTtlMinutes, defaultDelayMs, maxBulkRecipients, alwaysConfirm }
├── scheduled.json             pending/sent/failed scheduled sends
├── sent.jsonl                 append-only send log (one JSON object per send)
├── logs/
│   └── daemon.{out,err}.log   daemon stdout/stderr (what `whatsappman logs` tails)
├── bin/
│   └── whatsappmand-<host>    generated per-instance launcher (named delegate)
└── sessions/
    ├── work/                  a linked number labelled "work"
    │   ├── auth/             Baileys multi-file auth state (creds.json + keys) — survives reboot
    │   └── meta.json         { label, phone, status, lastConnectedAt, linkedAt }
    └── personal/
        ├── auth/
        └── meta.json
```

`0600`/`0700` perms on the socket, `daemon.pid`, and every `auth/` directory.
Config is **never** read from or written to the current working directory.

## Output format — JSON text responses, host-agnostic

Every MCP tool result is a JSON payload serialized into the MCP `content`
array's `text` block — the same convention mailman and this developer's other
MCP servers use, so no response bakes in formatting for one specific host:

```ts
// src/response.ts
function toolResponse(value: unknown): ToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}
function toolError(code: string, message: string): ToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify({ code, message }) }], isError: true };
}
```

- **Success**: the per-tool `Output` shape documented in docs/SKILLS.md,
  JSON-stringified.
- **Failure**: `{ code, message }` (see the error-code table below) — a code
  Claude can branch on, not just prose to pattern-match.
- Select tools may include a `next_steps: string[]` hint array (e.g. an
  ambiguous-recipient result nudging Claude to ask the user which number).
- The one exception is `whatsappman status`, the **CLI** command (not the MCP
  tool) — a human looking at a terminal, so it renders a `@clack/prompts`
  diamond tree, matching mailman's `src/cli/tree.ts` convention. `get_status`
  (the MCP tool) returns the same underlying `collectStatus()` data as plain
  JSON.

## The IPC protocol — MCP/CLI ↔ daemon

One newline-delimited JSON-RPC request per line over the socket. The client
(`src/ipc/client.ts`) is used identically by the MCP server and the CLI:

```jsonc
// request
{ "id": "uuid", "method": "send", "params": { "from": "work", "to": "<jid|name>", "kind": "text", "text": "hi" } }
// response
{ "id": "uuid", "ok": true, "result": { "messageId": "3EB0…", "status": "sent" } }
// or
{ "id": "uuid", "ok": false, "error": { "code": "NEEDS_RELINK", "message": "session 'work' expired — run: whatsappman relink work" } }
```

Daemon methods (the full surface the clients call): `status`, `list_sessions`,
`send`, `draft`, `confirm`, `cancel_draft`, `resolve_recipient`, `list_groups`,
`schedule`, `list_scheduled`, `cancel_scheduled`, `link` (start pairing, stream
QR), `relink`, `reconnect`, `disconnect`, `delete_session`, `set_default`,
`reload`.

**Access control (enforced on every connection — see [SECURITY.md](SECURITY.md)).**
The socket is local-only (no TCP, ever), but a `0600` socket restricts by *OS
user*, not by *application* — so the daemon layers real controls rather than
trusting file perms alone:
1. **Peer-UID check** — read peer creds (`getpeereid()` / `SO_PEERCRED`), drop
   any peer whose UID ≠ the daemon's.
2. **Capability token** — a 256-bit token minted at startup, written to
   `~/.whatsappman/daemon.token` (`0600`, rotated per restart), required on
   every request.
3. **Strict zod validation + method allowlist** — unknown/malformed → rejected
   and audited; sizes bounded.
4. **Best-effort peer-exe allowlist** (`strictPeer`, off by default) —
   documented as a speed-bump, not a boundary (PID-reuse races).
Windows named pipes get an owner-SID-only DACL + `PIPE_REJECT_REMOTE_CLIENTS`.

**Auto-spawn policy.** If a client finds the socket absent/unresponsive:
- The **CLI** may auto-start the daemon (it's an interactive context and can
  surface a QR / errors) unless `--no-spawn` is passed.
- The **MCP server** never silently spawns a long-lived daemon from inside a
  Claude session; it returns `DAEMON_DOWN` with `next_steps:
  ["run: whatsappman start"]`. (A daemon should already be installed by
  `init`; a missing one is a setup problem the user should see, not something
  papered over mid-conversation.)

## Sessions & Baileys lifecycle — adapted from the plugin

The plugin's `src/standalone/session-manager.standalone.ts` already implements
exactly the shape whatsappman needs (single-owner, no Redis, no mcphub-core,
filesystem auth via `useMultiFileAuthState`, QR rendering, auto-reconnect).
whatsappman lifts that logic, drops the ORM/DB pieces, and keys sessions by the
`sessions/<label>/` folder instead of a DB row.

- **Link a number** (`link`): `makeWASocket` with a fresh auth dir under
  `sessions/<label>/auth/`. On the `connection.update` event that carries a
  `qr`, the daemon renders it (`qrcode` → terminal ASCII for the CLI, or a data
  string streamed back over IPC) and the CLI prints it. On successful
  `open`, `meta.json` is written with the resolved phone number and
  `status: connected`.
- **Persistence**: `useMultiFileAuthState` writes creds after every auth event,
  so the QR is a one-time step — restarts reconnect from disk.
- **Reconnect logic**: on `connection: close`, inspect
  `DisconnectReason`. `restartRequired`/transient → auto-reconnect with
  backoff. `loggedOut` → mark `status: logged_out` / `needs_relink`, stop
  retrying, surface it (no silent infinite reconnect loop).
- **On daemon boot**: enumerate `sessions/*/`, spin up a socket for each, and
  reconnect. All numbers come back online without user action.

### Session status values

`connected` · `connecting` · `qr_pending` · `disconnected` · `needs_relink`
(creds present but WhatsApp rejected them / device expired) · `logged_out`
(explicitly logged out). Stored in `meta.json`, surfaced by `status` /
`list_sessions` / `whatsappman numbers`.

## Sending — one service, five message kinds

All sends go through `message-service.ts` (adapted from the plugin's
`message-service.standalone.ts`), which the daemon calls after `confirm`:

| Kind | Baileys call (essence) | Notes |
|---|---|---|
| text | `sock.sendMessage(jid, { text })` | |
| image | `sock.sendMessage(jid, { image, caption })` | image read from local path → buffer |
| document | `sock.sendMessage(jid, { document, fileName, mimetype })` | mimetype inferred if omitted |
| location | `sock.sendMessage(jid, { location: { degreesLatitude, degreesLongitude } })` | |
| contact | `sock.sendMessage(jid, { contacts: { … vcard } })` | |

- **Recipient resolution** (`contact-service.ts`): a `to` that looks like a JID
  (`…@s.whatsapp.net` / `…@g.us`) is used as-is; a phone number is normalized to
  a JID and validated with `sock.onWhatsApp()`; a plain name is matched against
  saved contacts/known groups and returns `AMBIGUOUS_RECIPIENT` (with
  candidates in `next_steps`) if more than one matches. A number that isn't on
  WhatsApp → `RECIPIENT_NOT_ON_WHATSAPP`.
- **Bulk** (`send_bulk`): iterates recipients with `settings.defaultDelayMs`
  between sends; rejects if count > `settings.maxBulkRecipients`
  (`BULK_LIMIT_EXCEEDED`). Per-recipient results (`sent`/`failed`) returned;
  one failure does not abort the batch.

## Draft → confirm → send

Identical in spirit to mailman, because WhatsApp is instant and irreversible:

1. `draft_message` — resolves recipient + attachment, builds a preview, stores
   a `Draft` in the daemon's in-memory `Map<draftId, Draft>` with a TTL
   (`settings.draftTtlMinutes`, default 10), returns `{ draftId, preview }`.
   **Does not send.**
2. `confirm_send` — the *only* method that dispatches. State machine
   `pending → sent | expired | cancelled`. **Idempotent**: replaying a
   `draftId` that already sent returns the original `{ messageId }` instead of
   re-sending. Runs the pre-send health check first (below).
3. `cancel_draft` — drops a pending draft.

Drafts live in the daemon's memory, never on disk — kill the daemon mid-draft
and a later `confirm_send` returns `DRAFT_NOT_FOUND` cleanly (never a
half-send).

## Pre-send health check — the reliability promise

Before any dispatch (`confirm_send`, `send_bulk`, a scheduled fire), the daemon
checks the target session is `connected`:

- `connected` → send, wait for the ack, return `{ messageId, status }`.
- daemon not running → client returns `DAEMON_DOWN` (`next_steps: run
  whatsappman start`).
- session `needs_relink` / `logged_out` → `NEEDS_RELINK` (`next_steps: run
  whatsappman relink <label>`).
- session `connecting`/`disconnected` → `SESSION_NOT_CONNECTED`, after a short
  bounded wait for an in-flight reconnect.

The point: a send either succeeds with a real message id, or returns a
machine-branchable error with the exact fix — **never a false "sent."**

## Scheduling — in the daemon, no OS ticker

mailman couldn't rely on its process being alive, so it registered an OS-level
`launchd`/cron/Task-Scheduler ticker to fire scheduled sends. whatsappman's
daemon **is** always alive, so scheduling is simpler:

- `schedule_send` persists an entry to `scheduled.json` (id, from, to, kind,
  payload, `fireAt`, status).
- The daemon runs one timer loop; on boot it reloads `scheduled.json` and
  re-arms timers for anything still pending, so a reboot doesn't drop
  schedules.
- At fire time it runs the same pre-send health check + `message-service`
  path, marks the entry `sent`/`failed`, and appends to `sent.jsonl`.
- One-time schedules only (no recurring), matching mailman.

## Daemon install & lifecycle — modeled on newra + mailman's ticker-install

`whatsappman daemon install` (run by `init`) writes a platform startup job so
the daemon runs at login and restarts on crash. The launchd/PATH handling is
lifted from mailman's `src/scheduler/ticker-install.ts` (which already solved
the "launchd/cron don't inherit the shell PATH, so `node`/`npx` aren't found"
gotcha by baking `process.execPath`'s dir + `/opt/homebrew/bin` into the job's
PATH).

**macOS — launchd** (mirrors newra's installed plist exactly):
```xml
<key>ProgramArguments</key>
<array>
  <string>~/.whatsappman/bin/whatsappmand-<host></string>
  <string>daemon</string><string>start</string>
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key>
<dict>
  <key>SuccessfulExit</key><false/>   <!-- don't restart a clean `stop` -->
  <key>Crashed</key><true/>            <!-- do restart a crash -->
</dict>
<key>ThrottleInterval</key><integer>10</integer>
```
Clean `whatsappman stop` sends SIGTERM → exits 0 → `KeepAlive` leaves it
stopped. A crash → non-zero exit → restarted.

**Linux — init-system detection** (see [CROSS-OS.md](CROSS-OS.md)). The
installer probes, in order: systemd-user present → **systemd `--user` unit**
(`~/.config/systemd/user/whatsappman.service`, `Restart=on-failure`, `loginctl
enable-linger` so it survives logout / runs headless); else OpenRC present
(**Alpine**) → an **OpenRC service**; else → a **`nohup` + pidfile launcher**
(the universal fallback for init-less containers/minimal hosts). `whatsappman
doctor` reports which mechanism is active.

**Windows — Task Scheduler** (`schtasks` at-logon trigger) or a Startup-folder
launcher; named pipe transport instead of a socket.

**Cross-platform reality**: core send is identical on macOS/Windows/Linux
(incl. Ubuntu/Xubuntu/Alpine); only this daemon-start layer and the optional
keytar cred-encryption layer differ per OS. Alpine's two caveats — OpenRC not
systemd, and keytar/musl having no keyring — are why cred encryption is optional
and the init layer is detected, not assumed. Full matrix in
[CROSS-OS.md](CROSS-OS.md).

`whatsappman daemon uninstall` unloads the job and removes the plist/unit/task
+ launcher (keeps `sessions/` unless `--purge`).

## Error codes

Every failable tool/method returns `{ code, message }`:

| Code | Meaning |
|---|---|
| `DAEMON_DOWN` | The daemon isn't running / socket unreachable. |
| `SESSION_NOT_FOUND` | No session with that label. |
| `SESSION_NOT_CONNECTED` | Session exists but isn't `connected` right now. |
| `NEEDS_RELINK` | Creds present but WhatsApp rejected them / device expired — re-scan QR. |
| `LOGGED_OUT` | Session was explicitly logged out. |
| `NO_DEFAULT_SESSION` | Call omitted `from` and no default is set. |
| `AMBIGUOUS_RECIPIENT` | A name matched more than one contact/group (candidates in `next_steps`). |
| `RECIPIENT_NOT_ON_WHATSAPP` | The number isn't a WhatsApp user. |
| `INVALID_JID` | Malformed recipient JID. |
| `DRAFT_NOT_FOUND` / `DRAFT_EXPIRED` | Bad or stale `draftId`. |
| `ATTACHMENT_NOT_FOUND` / `ATTACHMENT_TOO_LARGE` | Path missing / over WhatsApp's ~size cap. |
| `BULK_LIMIT_EXCEEDED` | Recipient count over `maxBulkRecipients`. |
| `RATE_LIMITED` | Backoff signal (self-imposed throttle or WhatsApp pushback). |
| `SCHEDULED_NOT_FOUND` | Bad scheduled-send id. |

## Concurrency, resilience & idempotency

- **Single writer per file.** `state.json`, `meta.json`, `scheduled.json`,
  `settings.json` are written by the daemon only (clients mutate via IPC), with
  atomic temp-file + `fs.rename()` and a `.bak` copy — mailman's `store.ts`
  pattern.
- **`confirm_send` idempotent** — a replayed `draftId` never double-sends.
- **Graceful shutdown** — on SIGTERM the daemon flushes `sent.jsonl`/state,
  closes each Baileys socket cleanly, and exits 0 (so launchd doesn't restart
  it).
- **Reconnect backoff** — bounded exponential backoff on transient
  disconnects; hard stop on `loggedOut`.
- **No silent send failures** — the pre-send health check guarantees a send is
  either acked or an actionable error.

## Security model

- **Local-only transport.** Unix socket / named pipe with `0600` perms — no
  network surface. Access = "can this OS user read the socket file," which is
  the same trust boundary as the config itself.
- **Creds on disk, machine-local.** Baileys creds under `sessions/<label>/auth/`
  (`0700`). They are WhatsApp linked-device keys, not passwords — but they are
  sensitive (they *are* the session), so they're never logged and never leave
  the machine. **Optional later hardening**: encrypt the `auth/` payloads with
  a keytar-backed master key, exactly as mailman does for `accounts.json`
  (noted, not in the initial build).
- **Redacted logs.** `pino` (as the plugin uses) at the daemon; message bodies
  and creds are never written to `daemon.*.log` by default.
- **Audit trail.** `sent.jsonl` records timestamp, session label, recipient
  JID, kind, and message id — metadata for "what did I send," never full
  content of inbound messages (there is no inbound handling).

## What is reused vs. written fresh

| Concern | Source |
|---|---|
| Baileys socket lifecycle, QR, auto-reconnect | **adapt** `plugin/src/standalone/session-manager.standalone.ts` |
| Send text/image/document/location/contact | **adapt** `plugin/src/standalone/message-service.standalone.ts` |
| Daemon launchd plist + `RunAtLoad`/`KeepAlive` shape | **model on** newra's installed plist |
| launchd/cron/Task-Scheduler PATH handling | **lift** mailman's `src/scheduler/ticker-install.ts` |
| draft/confirm flow, `store.ts` atomic writes, `response.ts`, `collectStatus()` tree, `register` multi-tool config, `doctor` | **mirror** mailman |
| IPC layer (Unix socket / named pipe JSON-RPC), daemon main loop, session-by-folder store | **new** — the two-process model is whatsappman's own |

## Deployment

Published to the IndiaNIC private registry `npm.indianic.in` as
`@indianic/whatsappman` (same `publishConfig.registry` as mailman) — **only
after explicit confirmation**, never as part of the build. Public
`registry.npmjs.org` is not a target.
