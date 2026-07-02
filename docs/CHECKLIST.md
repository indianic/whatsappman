# whatsappman — Implementation Checklist

Phased build order. Each phase should be usable/testable on its own before
moving to the next. See [docs/PLAN.md](PLAN.md) for the full rationale behind
each item and [docs/SKILLS.md](SKILLS.md) for exact tool signatures.

Nothing here is built yet — every box is unchecked. The `[reuse]` tag marks
items lifted/adapted from the `@mcphub/plugin-baileys-whatsapp` plugin's
`src/standalone/` code, newra's daemon, or mailman.

## Phase 0 — Project setup ✅ DONE

- [x] `package.json` (bin: `whatsappman` + `mcp-whatsappman`, `publishConfig.registry = https://npm.indianic.in/`), `tsconfig.json`, `.gitignore`, `eslint.config.js`
- [x] Install deps: `@whiskeysockets/baileys`, `qrcode`, `pino`, `zod`, `@modelcontextprotocol/sdk`, `mime-types`, `open`, `picocolors` (used `picocolors` for the tree instead of `@clack/prompts` — lighter, no extra dep surface)
- [x] `src/config/paths.ts` — resolve global config dir `~/.whatsappman/` via `os.homedir()`, honoring `WHATSAPPMAN_DIR` override; create with `0700` (+ long-socket-path tmpdir fallback, found via a real EINVAL on a deep test dir)
- [x] `src/index.ts` — argv dispatcher: pipes-with-no-args → MCP server; `daemon` → daemon; anything else → CLI; `--version`/`--help`
- [x] `bin/whatsappman.js` — thin shim into `dist/index.js`
- [x] `src/response.ts` — `toolResponse()` / `toolError(code, message)` JSON-in-text helpers (mailman convention)
- [x] `src/status.ts` — `buildStatus()` (daemon-side) + `offlineStatus()` (CLI fallback), placeholder sections (daemon, numbers, scheduled)
- [x] `src/cli/tree.ts` — diamond-tree renderer **[reuse: mailman]**
- [x] `src/cli/render-status.ts` + `whatsappman status` — render the status report as the tree
- [x] `whatsappman help` / `examples` / unknown-command suggestion
- [x] GitHub Actions CI skeleton — lint + typecheck + build + test on every PR

## Phase 1 — The daemon skeleton + IPC (no Baileys yet) ✅ DONE

- [x] `src/ipc/protocol.ts` — zod request/response schemas; method allowlist (`ping`, `status`); per-method params schemas
- [x] `src/ipc/transport.ts` — platform transport: Unix domain socket (posix) / named pipe (win32), `0600`; stale-socket cleanup
- [x] `src/ipc/client.ts` — connect, send one JSON-RPC request, read one response; `DAEMON_DOWN` when socket/token absent; 8s timeout
- [x] **Access control from day one** (see [SECURITY.md](SECURITY.md)): socket `0600` in `0700` dir (FS enforces same-UID connect); **capability token** minted at startup → `daemon.token` (`0600`), constant-time-verified on every request; strict zod validation + method allowlist; request size cap; single-instance pidfile lock. *(Explicit `getpeereid()`/`SO_PEERCRED` peer-UID check needs a native binding — deferred to Phase 8, noted in `ipc/access.ts`; FS perms already enforce the same-UID boundary.)*
- [x] `src/daemon/main.ts` — daemon entrypoint: acquire lock, mint token, write `daemon.pid` + `state.json` (preserving `defaultSession`), open the socket, idle
- [x] `src/ipc/server.ts` — accept connections, parse newline-delimited JSON, token-auth + validate, route to handlers; `ping`/`status` only
- [x] `whatsappman start` / `stop` / `restart` — detached spawn / SIGTERM signal, PID-file based; start confirms via `ping`
- [x] `get_status` MCP tool + `whatsappman status` both proxy to the daemon over IPC (verified via real MCP JSON-RPC handshake)
- [x] SIGTERM/SIGINT handler → clean exit 0, remove socket + token + pid file
- [x] Unit tests (10, all green): IPC ping round-trip, token verify, UNAUTHORIZED on bad token, BAD_REQUEST on malformed line, `DAEMON_DOWN` when down, atomic write + `.bak` recovery + `0600` perms

## Phase 2 — Link one number + core send (the vertical slice) ✅ DONE

- [x] `src/config/schema.ts` — zod schemas for `state.json`, `sessions/<label>/meta.json`, `settings.json` (each with a `schemaVersion`)
- [x] `src/config/sessions.ts` — label validation/normalize, enumerate/read/write session folders + `meta.json`, `hasCreds`
- [x] `src/daemon/session-manager.ts` — Baileys socket lifecycle: `makeWASocket`, `useMultiFileAuthState` under `sessions/<label>/auth/`, `connection.update` handling, QR capture, reconnect-on-transient / stop-on-`loggedOut` (→ `needs_relink`) **[reuse: plugin session-manager]**
- [x] `link` + `link_status` daemon methods — start pairing, return the current QR payload (CLI polls it — chosen over streaming to fit the one-shot IPC model)
- [x] `whatsappman link [--label]` CLI — render the QR in the terminal (`qrcode` terminal render), poll until connected; auto-starts the daemon; `meta.json` updated on `open`
- [x] `sendText` in the session manager (`sock.sendMessage(jid,{text})`) + `send_text` IPC method + `whatsappman send <to> <text> [--from]` CLI (raw send; the MCP draft/confirm wrapper is Phase 3) **[reuse: plugin message-service]**
- [x] On daemon boot: enumerate `sessions/*/` with creds and reconnect each (`reconnectAll`)
- [x] Session status values wired into `meta.json` + `list_sessions` + `whatsappman numbers`
- [x] **Baileys integration verified**: `link` reaches WhatsApp servers, emits a real QR (237-byte payload), renders a scannable terminal QR, session tracked as `qr_pending`, auth dir created. *(The final human-scan step + reconnect-after-restart + real delivery need a phone — documented as the manual sign-off below.)*
- [ ] **Manual sign-off (needs a real phone)**: scan the QR to connect, restart the daemon and confirm it reconnects from disk without a new QR, then `whatsappman send` a real text and confirm it arrives.

## Phase 3 — Draft / confirm / send flow + recipient resolution ✅ DONE

- [x] `src/daemon/draft-store.ts` — in-memory `Map<draftId, Draft>`, TTL from `settings.draftTtlMinutes`, state machine `pending → sent | cancelled` + lazy `isExpired`; `markSent` records the result for idempotent replay
- [x] `src/daemon/contact-service.ts` — resolve JID (passthrough) | phone (`onWhatsApp()` validated) | group name (`groupFetchAllParticipating`) | contact name (session contacts cache); returns candidate list **[reuse: plugin contact logic]**
- [x] Error codes — every failable method returns structured `{ code, message }` (+ `next_steps`)
- [x] `draft_message` tool — resolve recipient, build preview, store draft, return `draftId` (text kind)
- [x] `confirm_send` tool — pre-send health check, then send; **idempotent** on `draftId` (replay returns original result, no double-send)
- [x] `cancel_draft`, `resolve_recipient`, `list_groups`, `health_check` tools
- [x] MCP server exposes all 8 tools; **no raw send tool** — sending is only `draft_message` → `confirm_send` (verified via real MCP JSON-RPC: tool list, `NO_DEFAULT_SESSION`, `DRAFT_NOT_FOUND`, `health_check` all return structured payloads)
- [x] `default <label>` CLI + `set_default` IPC → `state.json.defaultSession` as the single source of truth (daemon-owned write)
- [x] Unit tests (15 total): draft TTL/state machine, `confirm_send` idempotency (markSent replay), cancel-only-pending, `get`→undefined after restart (→ `DRAFT_NOT_FOUND`)
- [ ] **Manual sign-off (needs a connected number)**: draft → confirm a real message from a Claude session; kill the daemon mid-draft and confirm `confirm_send` returns `DRAFT_NOT_FOUND` (never a half-send).

## Phase 4 — Multiple numbers + the rest of the message kinds ✅ DONE

- [x] Attachment resolution (`src/daemon/attachments.ts`): `path` → absolute + mimetype (`mime-types`) + size cap (`ATTACHMENT_TOO_LARGE` / `ATTACHMENT_NOT_FOUND`), **plus a sensitive-path denylist (`~/.ssh`, `~/.aws`, `~/.gnupg`, keychains, `*.env`/`*.pem`/`*.key`, id_rsa, the whatsappman config dir) → `ATTACHMENT_FORBIDDEN`** (exfiltration guard — pulled forward from Phase 8)
- [x] `SessionManager.sendDraft` dispatches all kinds: `image`, `document`, `location`, `contact` (vcard) **[reuse: plugin message-service]** — file bytes read at send time, not held in the draft
- [x] `draft_message` handles all five kinds (zod discriminated params + MCP schema)
- [x] Multi-session: `from` routing (explicit → default → sole-session) via `resolveLabel`; `set_default` single source of truth
- [x] `numbers` / `status <label>` / `reconnect` / `disconnect` / `relink` CLI commands (relink shares the QR-poll loop with link)
- [x] `delete <label>` CLI (closes socket, removes `sessions/<label>/`, clears default if it was this, `--yes` gated) — **not** an MCP tool
- [x] `send_bulk` — `defaultDelayMs` throttle, `maxBulkRecipients` cap (`BULK_LIMIT_EXCEEDED`), per-recipient results; CLI `send-bulk` (CLI-only, not an MCP tool)
- [x] Unit tests (24 total): attachment resolution + caps + forbidden paths (6), bulk cap/empty (3)
- [x] Verified: CLI help lists all commands; MCP surface unchanged (8 tools, still **no raw send**); `draft_message` advertises all 5 kinds
- [ ] **Manual sign-off (needs 2 phones)**: link a second number, send from each via `--from`, confirm routing + a real image/document delivery.

## Phase 5 — Daemon install & OS lifecycle (always-on)

- [ ] `src/cli/daemon.ts` install/uninstall
- [ ] macOS launchd: generate per-instance launcher `~/.whatsappman/bin/whatsappmand-<host>` + plist (`RunAtLoad`, `KeepAlive{SuccessfulExit:false, Crashed:true}`, `ThrottleInterval`) **[reuse: newra plist shape]**
- [ ] launchd/systemd PATH handling — bake `process.execPath` dir + `/opt/homebrew/bin` into the job PATH **[reuse: mailman `ticker-install.ts`]**
- [ ] Linux init-system detection (see [CROSS-OS.md](CROSS-OS.md)): systemd `--user` unit (`Restart=on-failure`, `enable-linger`) → OpenRC service (**Alpine**) → `nohup`+pidfile fallback (init-less/containers); `doctor` reports the active mechanism
- [ ] Windows Task-Scheduler at-logon task; named-pipe transport
- [ ] `whatsappman init` wires it all: `daemon install` → `start` → `link` first number → `register` MCP config
- [ ] `whatsappman doctor` — daemon reachable, socket/creds perms, Node ≥18, `node`/`npx` on job PATH, per-session connection
- [ ] **Manual test**: reboot / log out+in, confirm the daemon auto-starts and reconnects every number; `stop` stays stopped; kill -9 the daemon, confirm `KeepAlive` restarts it

## Phase 6 — Scheduling (daemon-held)

- [ ] `src/config` scheduled.json schema + atomic store
- [ ] `src/daemon/scheduler.ts` — timer loop; on boot reload `scheduled.json` and re-arm pending timers
- [ ] `schedule_send` (snapshots the draft into the schedule), `list_scheduled`, `cancel_scheduled` tools + `whatsappman scheduled list`
- [ ] Fire path reuses the pre-send health check + `message-service`; marks `sent`/`failed`; appends to `sent.jsonl`
- [ ] **Manual test**: schedule a send a few minutes out, restart the daemon before it fires, confirm it still fires

## Phase 7 — History, settings, polish

- [ ] `src/audit.ts` — append-only `sent.jsonl` (timestamp, session, recipient JID, kind, messageId), size-capped/rotated
- [ ] `list_recent` tool + `whatsappman recent`
- [ ] `src/logging.ts` — `pino`, redact bodies/creds by default
- [ ] `settings get`/`set`, `whatsappman send` quick terminal send, `update`/`upgrade` self-update, `reset` (`--yes`)
- [ ] `register` multi-tool MCP-config writer (Claude/Cursor/Gemini/Windsurf/Codex) **[reuse: mailman]**
- [ ] README / CONTEXT / docs finalized against the shipped surface

## Phase 8 — Security hardening & cross-OS (see [SECURITY.md](SECURITY.md))

Access control (peer-UID + token + validation) lands in Phase 1; this phase is
the deeper hardening.

- [ ] **Encrypt `auth/` creds** with a keytar-backed AES-256-GCM master key (mailman-style, machine-bound) so a copied `sessions/` folder is useless off-box — **High**
- [ ] **Attachment path guard**: sensitive-path denylist (`~/.ssh`, `*.env`, `~/.aws`, keychains, the config dir) → `ATTACHMENT_FORBIDDEN`; audit every attachment path + recipient; size cap enforced pre-read — **High**
- [ ] **Windows named-pipe ACL**: owner-SID-only DACL + `PIPE_REJECT_REMOTE_CLIENTS` — **High (Win)**
- [ ] **Supply chain**: commit lockfile, `npm ci`, pin Baileys/qrcode/pino, `npm audit` + Dependabot in CI — **High**
- [ ] **Daemon privilege**: confirm never root; systemd `--user` unit with `NoNewPrivileges`/`ProtectSystem=strict`/`ReadWritePaths=%h/.whatsappman`/`PrivateTmp`; launchd user-agent domain
- [ ] Rate limiting + `defaultDelayMs`/`maxBulkRecipients` enforced **in the daemon**, not just clients; `RATE_LIMITED`
- [ ] `pino` redaction verified (no creds/bodies in logs); QR never written to `daemon.*.log`; `sent.jsonl` `0600` + rotation
- [ ] Doc: exclude `~/.whatsappman` from iCloud/Time Machine/Dropbox/OneDrive sync
- [ ] Reconnect backoff tuned; confirm no infinite reconnect loop on `loggedOut`
- [ ] Confirm socket + `daemon.token` + `auth/` perms are `0600`/`0700` on a fresh install; stale-socket unlink only after pid liveness check
- [ ] Optional opt-in OS sandbox (macOS codesign/notarize + App Sandbox; Linux seccomp/AppArmor) — documented, not default
- [ ] Cross-OS smoke test per [CROSS-OS.md](CROSS-OS.md): macOS launchd, Windows named pipe + Task Scheduler, Ubuntu/Xubuntu systemd-user, **Alpine OpenRC/nohup + send without keytar (musl, no keyring)**, headless SSH QR pairing — needs those machines
- [ ] Ban-safety review: default throttles, prominent caution in README

## Pending, deliberately not automatic

- [ ] **`npm publish` to `npm.indianic.in`** — a real, hard-to-reverse action; done **only after explicit confirmation**, matching mailman's stance.
- [ ] **Registering the real OS daemon job on this machine** — mutates system state (a login item that persists across reboots); `whatsappman init` / `daemon install` does it when the user actually runs it, not as part of any build/test.
- [ ] **A real long-lived link test** — leaving a number paired for >2 weeks to observe WhatsApp's linked-device expiry and confirm the `NEEDS_RELINK` path triggers cleanly.
