# whatsappman — Skills (MCP Tools)

The tools this server exposes to a Claude session. Each tool is a thin MCP
call that proxies to the always-on daemon over the local socket (see
[docs/PLAN.md](PLAN.md)); the intelligence of interpreting "send those docs to
Kalpesh" or composing the message text lives in the calling Claude session,
not here.

**Every response is JSON in a text block, host-agnostic.** No tool returns
host-specific formatted output — the `Output` shapes below are JSON-serialized
into the MCP `content` array's `text` field, the same convention mailman and
this developer's other MCP servers use. Any MCP host — Claude Code, Cursor,
Windsurf, etc. — parses the same JSON and renders it however it wants.

**Errors are structured, not just prose.** Any tool that can fail returns
`{ code, message }` (JSON-in-text + `isError: true`) — see the error-code
table in [docs/PLAN.md](PLAN.md#error-codes) — so Claude can branch on `code`
(re-ask the user on `AMBIGUOUS_RECIPIENT`, tell them to relink on
`NEEDS_RELINK`, back off on `RATE_LIMITED`) instead of pattern-matching the
message text. Many failures also carry a `next_steps: string[]` array with the
exact CLI command that fixes the problem.

**Not exposed as MCP tools, deliberately** — anything interactive,
QR-dependent, or destructive is CLI-only (see [docs/CLI.md](CLI.md)): linking /
relinking a number (`whatsappman link` / `relink` — needs a QR scanned at a
terminal), deleting a session (`whatsappman delete`), daemon
install/uninstall/start/stop, and `reset`. An LLM session should never be able
to unpair a number, delete credentials, or tear down the daemon.

## The send flow, in tools

Nothing sends without a preview. The path is always:

```
draft_message  →  (Claude shows the preview, user says yes)  →  confirm_send
```

`confirm_send` is the *only* tool that dispatches a message, and it's
idempotent — replaying the same `draftId` returns the original result rather
than sending twice.

---

## Sessions / status

### `get_status`
Daemon + all-numbers snapshot. Same underlying data as the `whatsappman
status` CLI, as plain JSON.
- **Input**: none.
- **Output**: `{ daemon: { running, pid, uptimeSec, hostname }, defaultSession, sessions: [{ label, phone, status, lastConnectedAt }], pendingScheduled }`.
- **Errors**: `DAEMON_DOWN`.

### `list_sessions`
Just the linked numbers and their live state.
- **Input**: none.
- **Output**: `{ sessions: [{ label, phone, status, lastConnectedAt, isDefault }] }`.
- **Errors**: `DAEMON_DOWN`.

### `health_check`
One-line "can I send right now?" for a given number (or the default).
- **Input**: `{ from?: string }` — session label; default if omitted.
- **Output**: `{ ok: boolean, status, canSend: boolean, reason?: string }`.
- **Errors**: `DAEMON_DOWN`, `SESSION_NOT_FOUND`, `NO_DEFAULT_SESSION`.

---

## Recipient resolution

### `resolve_recipient`
Turn a human reference ("Kalpesh", a phone number, a group name) into a WhatsApp
JID before drafting — lets Claude confirm *who* it'll message.
- **Input**: `{ from?: string, query: string }`.
- **Output** (unique match): `{ jid, name, kind: "individual" | "group" }`.
- **Output** (ambiguous): `{ candidates: [{ jid, name, kind }], next_steps }`.
- **Errors**: `AMBIGUOUS_RECIPIENT`, `RECIPIENT_NOT_ON_WHATSAPP`, `INVALID_JID`, `SESSION_NOT_CONNECTED`, `DAEMON_DOWN`.

### `list_groups`
The groups a number belongs to (so "send to the Falcon group" resolves).
- **Input**: `{ from?: string }`.
- **Output**: `{ groups: [{ jid, subject, participantsCount }] }`.
- **Errors**: `SESSION_NOT_CONNECTED`, `DAEMON_DOWN`.

---

## Drafting & sending

### `draft_message`
Builds a preview and stores a draft in the daemon. **Does not send.**
- **Input**:
  ```jsonc
  {
    "from": "work",              // optional — session label; default if omitted
    "to": "Kalpesh",            // JID, phone number, or saved contact/group name
    "kind": "text",             // "text" | "image" | "document" | "location" | "contact"
    "text": "running late",      // text body / caption
    "path": "/abs/plan.pdf",     // for image/document — resolved from conversation context
    "latitude": 23.03, "longitude": 72.58,   // for location
    "contact": { "name": "...", "phone": "..." }  // for contact
  }
  ```
- **Output**: `{ draftId, preview: { from, toJid, toName, kind, summary, attachment?: { name, sizeBytes } }, expiresInSec }`.
- **Errors**: `SESSION_NOT_FOUND`, `NO_DEFAULT_SESSION`, `AMBIGUOUS_RECIPIENT`, `RECIPIENT_NOT_ON_WHATSAPP`, `ATTACHMENT_NOT_FOUND`, `ATTACHMENT_TOO_LARGE`, `DAEMON_DOWN`.

### `confirm_send`
The only tool that dispatches. Runs the pre-send health check first, then sends.
Idempotent on `draftId`.
- **Input**: `{ draftId: string }`.
- **Output**: `{ messageId, status: "sent", to, sentAt }`.
- **Errors**: `DRAFT_NOT_FOUND`, `DRAFT_EXPIRED`, `SESSION_NOT_CONNECTED`, `NEEDS_RELINK`, `LOGGED_OUT`, `DAEMON_DOWN`, `RATE_LIMITED`.

### `cancel_draft`
- **Input**: `{ draftId: string }`.
- **Output**: `{ cancelled: true }`.
- **Errors**: `DRAFT_NOT_FOUND`.

### `send_bulk`
Send one message to many recipients, throttled. Still preview-gated: this
drafts a *bulk* draft that `confirm_send` dispatches. One failure doesn't abort
the batch.
- **Input**: `{ from?: string, to: string[], kind, text?, path?, delayMs? }`.
- **Output** (after confirm): `{ sent, failed, results: [{ to, status, error? }] }`.
- **Errors**: `BULK_LIMIT_EXCEEDED`, plus the `draft_message`/`confirm_send` set.

---

## Scheduling

### `schedule_send`
Draft as usual, but dispatch at a future time from the always-on daemon (fires
even if this Claude session is long closed).
- **Input**: `{ draftId: string, fireAt: string }` — `fireAt` ISO-8601, local or with offset.
- **Output**: `{ scheduledId, fireAt }`.
- **Errors**: `DRAFT_NOT_FOUND`, `DRAFT_EXPIRED`, `DAEMON_DOWN`.
- **Note**: one-time only, no recurring. The draft is snapshotted into the
  schedule at call time, so it's fine for the in-memory draft to expire after.

### `list_scheduled`
- **Input**: `{ status?: "pending" | "sent" | "failed" }`.
- **Output**: `{ scheduled: [{ scheduledId, from, toName, kind, fireAt, status }] }`.

### `cancel_scheduled`
- **Input**: `{ scheduledId: string }`.
- **Output**: `{ cancelled: true }`.
- **Errors**: `SCHEDULED_NOT_FOUND`.

---

## Send history

### `list_recent`
Reads the append-only `sent.jsonl`.
- **Input**: `{ limit?: number, from?: string }`.
- **Output**: `{ sent: [{ messageId, from, toName, kind, sentAt, status }] }`.

---

## Terminal output convention

The tools above return plain JSON — this section is about the *other* half of
whatsappman, the human-facing `whatsappman <command>` CLI (full list in
[docs/CLI.md](CLI.md)). Every one of those commands renders through the same
shared diamond-tree vocabulary mailman established (`src/cli/tree.ts`), so
`status`, `numbers`, `doctor`, `daemon status`, `help`, etc. all look like one
tool: a title, a two-tier diamond hierarchy with plain data lines underneath,
closed by an outro line.

```
┌  whatsappman — status
│
◆  daemon
◇  running (pid 51234) · up 3h 12m · host kalpesh.local
│
◆  numbers
│  work       +91 98xxxxxxx0   connected      default
│  personal   +91 99xxxxxxx1   needs_relink
│
◆  scheduled
◇  1 pending
│
└  status
```

- **`◆` (filled diamond)** — a section header (carries the one leading blank rail line).
- **`◇` (hollow diamond)** — a single confirmatory fact under a section; turns red `■` automatically when false (e.g. daemon not running).
- **`■` (red square)** — an error/failure line.
- **`▲` (triangle)** — worth flagging (e.g. a `needs_relink` number), not a hard failure.

`get_status` (the MCP tool) returns the same `collectStatus()` data as JSON;
the diamond tree is only for the CLI, where a human is looking at a terminal.
