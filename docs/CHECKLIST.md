# whatsappman — Implementation Checklist

Phased build order. Each phase should be usable/testable on its own before
moving to the next. See [docs/PLAN.md](PLAN.md) for the full rationale behind
each item and [docs/SKILLS.md](SKILLS.md) for exact tool signatures.

Nothing here is built yet — every box is unchecked. The `[reuse]` tag marks
items lifted/adapted from the `@mcphub/plugin-baileys-whatsapp` plugin's
`src/standalone/` code, newra's daemon, or mailman.

## Phase 0 — Project setup ✅ DONE

- [x] `package.json` (bin: `whatsappman` + `mcp-whatsappman`, `publishConfig.access = public`), `tsconfig.json`, `.gitignore`, `eslint.config.js`
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
- [x] **Manual sign-off DONE (2026-07-02)**: `whatsappman restart` → daemon reconnected from disk in ~3s **without a new QR**, then a real text was drafted+sent and delivered (`messageId 3EB006A019CD1F789BE1C2`). Live-verified against the connected default number.

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
- [x] **Manual sign-off DONE (2026-07-02)**: drafted + confirmed a real message from a Claude session (delivered). Then created a draft, `kill -9`'d the daemon mid-draft, and after restart `confirm_send` on that draftId returned `DRAFT_NOT_FOUND` — the orphaned message never sent (verified absent from `recent`). No half-send.

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
- [x] **Multi-number linking verified (2026-07-02)**: with `default` connected, `whatsappman link --label <name>` emits a fresh scannable QR for a *second* number (proved live with a throwaway `test` label; sessions are keyed independently, so a connected number never blocks adding another). Fixed a discoverability dead-end: a bare `whatsappman link` on an already-connected default now guides the user to `link --label <name>` + `default <name>` instead of stopping at "already connected" (`shouldSuggestAdditionalNumber`, unit-tested).
- [ ] **Manual sign-off (needs 2 phones)**: scan the 2nd QR, send from each via `--from`, confirm routing + a real image/document delivery. *(linking half verified above; only the real 2-phone delivery remains)*

## Phase 5 — Daemon install & OS lifecycle (always-on) ✅ DONE

- [x] `src/daemon/install.ts` + CLI `daemon install [--print] / uninstall` (generation separated from load, so `--print` is a mutation-free dry run)
- [x] macOS launchd: per-instance launcher `~/.whatsappman/bin/whatsappmand-<host>` + plist (`RunAtLoad`, `KeepAlive{SuccessfulExit:false, Crashed:true}`, `ThrottleInterval`, log paths) **[reuse: newra plist shape]**
- [x] launchd/systemd PATH handling — bake `process.execPath` dir + `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` into the job PATH **[reuse: mailman `ticker-install.ts`]**
- [x] Linux init-system detection (see [CROSS-OS.md](CROSS-OS.md)): systemd `--user` unit (`Restart=on-failure`, `enable-linger`, `NoNewPrivileges`/`PrivateTmp`) → OpenRC service (**Alpine**) → `nohup`+pidfile fallback (init-less/containers); `doctor` reports the active mechanism
- [x] Windows `schtasks` at-logon task writer (2026-07-02): `buildSchtasksXml` generates a Task Scheduler XML task that starts the daemon at logon with **restart-on-failure** (the Windows parity for launchd `KeepAlive` / systemd `Restart=on-failure`), runs `node <launcher>` at `LeastPrivilege`, never times out (`PT0S`); `install`/`uninstall`/`isInstalled` wired via `schtasks /Create /XML|/Delete|/Query` (XML staged as UTF-16LE+BOM, which schtasks requires). 4 unit tests + generated XML validated well-formed (xmllint). *(Actual execution on a Windows box is the only remaining sign-off — see below.)*
- [x] `whatsappman init` wires it all: `daemon install` → `start` → `link` first number (QR) → `register` MCP config
- [x] `whatsappman doctor` — Node ≥18, `node`/`npx` on PATH, config-dir + socket + token perms, daemon reachable, mechanism + installed?, per-session connection (pre-init state shown as advisories, not errors)
- [x] `register` — prints `claude mcp add whatsappman -- npx -y @integratex/whatsappman` + a generic MCP JSON snippet; `--write` runs `claude mcp add` when the CLI is present (safe: no blind config-file mutation)
- [x] Unit tests (30 total): hostname slug, baked PATH, plist (RunAtLoad/KeepAlive/throttle/PATH), systemd unit (Restart=on-failure), launcher script, `planInstall` writes nothing
- [x] Verified without mutating the system: `daemon install --print` shows the exact plist + launcher; confirmed nothing written to `~/Library/LaunchAgents`; `doctor` runs read-only
- [~] **Manual sign-off (2026-07-02)**: launchd autostart is installed + running (`doctor`). `kill -9` on the **launchd-supervised** daemon → `KeepAlive` restarted it in ~3s (10322→10473); `stop`'s clean SIGTERM stays stopped (KeepAlive `SuccessfulExit:false`). Literal reboot auto-start still unverified (needs a reboot).
  - ✅ **FOUND + FIXED (2026-07-02) — KeepAlive gap**: `startDaemon()` was a plain detached `spawn`, so `whatsappman restart` / `update` left the daemon running **outside launchd** and a crash was NOT auto-recovered until next login (the first `kill -9` this session didn't recover for exactly this reason). Fix: `startDaemon()` now prefers the installed supervisor (`supervisorStartPlan` → `launchctl kickstart` / `systemctl --user start` / `rc-service start` / `schtasks /Run`), falling back to detached spawn only when no autostart job exists. **Live-proven on launchd**: after a `restart` the running daemon IS the launchd job (pids match), and a subsequent `kill -9` auto-recovered in ~3s (15534→15704). Unit-tested per platform (systemd/openrc/schtasks command shapes; real run on those OSes still pending).

## Phase 6 — Scheduling (daemon-held) ✅ DONE

- [x] `scheduled.json` schema (`config/schema.ts`, snapshots the full per-kind payload) + atomic store (`config/scheduled.ts`)
- [x] `src/daemon/scheduler.ts` — per-entry timers with capped delay (setTimeout 24.8-day cap → re-arm); on boot `load()` re-arms every pending entry; `computeDelayMs` pure/testable
- [x] `schedule_send` (snapshots the in-memory draft into the schedule, then consumes the draft so it can't also be confirmed), `list_scheduled`, `cancel_scheduled` — IPC + MCP tools + `whatsappman scheduled [cancel <id>]`
- [x] Fire path reuses the pre-send health check + `sendDraft`; marks `sent`/`failed`; appends to `sent.jsonl` (`src/audit.ts`); `confirm_send` also logs to `sent.jsonl` now
- [x] Verified end-to-end (no phone needed): seeded a past-due + a future entry, started the daemon → past-due fired → health check (no session) → `failed` + logged to `sent.jsonl` with reason; future stayed `pending`; `status` shows the count; **after a restart the pending entry survived** (re-armed from disk)
- [x] **Manual sign-off DONE (2026-07-02)**: scheduled a real send ~2.5 min out, restarted the daemon before it fired, confirmed the entry **survived** (still `pending`, re-armed from disk via `list_scheduled`), then it fired at the target time and delivered (`recent` shows it `✓ … (schedule)`).

## Phase 7 — History, settings, polish ✅ MOSTLY DONE

- [x] `src/audit.ts` — append-only `sent.jsonl` (timestamp, session, recipient JID, kind, messageId, status, via), rotates to `.jsonl.1` at 5 MB
- [x] `list_recent` MCP tool + `whatsappman recent [--limit N] [--from label]` (reads the file directly when the daemon is down)
- [x] `src/logging.ts` — `pino` with credential/body redaction (`text`/`body`/`caption`/`creds`/`token`/`auth`)
- [x] `settings get`/`set <key> <value>` (validated + coerced; `get_settings`/`update_settings` IPC — CLI-only, not MCP), `whatsappman send` quick terminal send (Phase 2/4), `reset` (`--yes`: stop daemon → uninstall autostart → wipe config dir)
- [x] Unit tests (38 total): `sent.jsonl` rotation, `readRecent` newest-first + limit + `from` filter + corrupt-line skip
- [x] Verified: settings round-trip to disk (with `schemaVersion`), reset wipes cleanly, MCP surface now 12 tools (list_recent added), still **no raw send**
- [x] `update`/`upgrade` self-update — `whatsappman update` checks npm for whatever name package.json publishes under (`getPackageName()`, no hardcoded literal, no `--registry` flag), `npm install -g @latest` if newer, then restarts the daemon so it loads the new build; no-op "already up to date" when current. Verified live against the published 0.1.0.
- [x] `register` multi-tool config writer (2026-07-02) — `register --write [--tools …] [--project]` writes/merges the `whatsappman` MCP entry into Claude Code (via official `claude mcp add`), Cursor, Gemini CLI, Windsurf, and Codex (idempotent JSON merge / TOML block replace, preserves unrelated servers). Ported the pure writer from mailman's `editor-config.ts` (no `@clack` dep — non-interactive). 12 unit tests + verified end-to-end against a temp HOME.
- [x] README / CONTEXT / docs final pass against the shipped surface (commit 505a104)

## Phase 8 — Security hardening & cross-OS (see [SECURITY.md](SECURITY.md))

Access control (token + zod validation + method allowlist + 0600 socket) landed
in Phase 1; the attachment path guard landed in Phase 4. This phase is the
remaining hardening. Split into **done here** vs. **honestly deferred** (needs
real hardware or a native dependency that would break the pure-Node/Alpine
promise — see the rationale on each).

**Done + verified this phase:**

- [x] **Anti-abuse rate limiter** (`src/daemon/rate-limit.ts`): per-session token bucket (30 burst, 1/sec refill), enforced **in the daemon** on every send path (`sendText`/`sendDraft`/`sendBulk`) → `RATE_LIMITED`. Stops a rogue same-user caller or runaway loop from blasting the number into a ban. Sized so normal interactive/bulk use never trips it. (4 unit tests.)
- [x] **Reconnect backoff**: bounded exponential (`computeBackoff`, 3s → cap 60s, doubling), resets on a successful connect; **no infinite loop on `loggedOut`** (terminal → `needs_relink`, no timer armed). (Unit-tested incl. no-overflow at high attempts.)
- [x] **Perms verified on a real fresh daemon start** (test/perms.test.ts): config dir `0700`, socket/`daemon.token`/`daemon.pid` `0600`, `sessions/` `0700`.
- [x] **Stale-socket safety documented + correct**: unlink is gated by `acquireLock()` (no *other* live daemon) — and we deliberately do NOT re-check `isDaemonAlive()` at unlink time (acquireLock just wrote our own pid, which would falsely read "alive" and skip cleaning a real stale socket). Comment in `ipc/transport.ts` records why.
- [x] **Daemon privilege** (from Phase 5): never root; systemd `--user` unit with `NoNewPrivileges`/`PrivateTmp`; launchd user-agent domain.
- [x] **`pino` redaction** (`src/logging.ts`, Phase 7): bodies/creds/token redacted; `sent.jsonl` `0600` + 5 MB rotation; QR rendered only to the interactive terminal, never the daemon log.
- [x] **Attachment path guard** (Phase 4): `~/.ssh`/`*.env`/`~/.aws`/keychains/config-dir → `ATTACHMENT_FORBIDDEN`; size cap pre-read. (6 unit tests.)
- [x] **Supply chain baseline**: `package-lock.json` committed; CI uses `npm ci`; Baileys/qrcode/pino pinned. (Dependabot/`npm audit` in CI = a repo-settings follow-up.)
- [x] **Ban-safety**: prominent caution in README + daemon-side throttles (`defaultDelayMs`, `maxBulkRecipients`, rate limiter).

**Honestly deferred — needs hardware or a native dep (not built to avoid faking it):**

- [ ] **Encrypt `auth/` creds** with a keytar-backed AES-256-GCM key — **High, but deliberately not added yet.** `keytar` is a native module that undermines the pure-Node/Alpine-musl promise, and wrapping Baileys' `useMultiFileAuthState` I/O risks corrupting a working, verified session. Interim mitigation is real: creds are `0700`, and the docs tell users to exclude `~/.whatsappman` from cloud sync. Revisit as an **opt-in** with a clean fallback.
- [ ] **Explicit `getpeereid()` / `SO_PEERCRED` peer-UID check** — Node exposes no built-in for this; a correct implementation needs a native addon. The `0600` socket in a `0700` dir already enforces the same-UID boundary (the token is the second gate), so this is defense-in-depth, not the boundary itself. Documented in `ipc/access.ts`.
- [~] **Windows named-pipe ACL** (owner-SID DACL + `PIPE_REJECT_REMOTE_CLIENTS`) — still needs a Windows box (can't be faked from macOS). *(The schtasks at-logon task-writer that used to be bundled here is now done + unit-tested — see Phase 5.)*
- [ ] **Cross-OS smoke test** per [CROSS-OS.md](CROSS-OS.md): Windows, Ubuntu/Xubuntu systemd-user, Alpine OpenRC/nohup + send without keytar, headless SSH QR — needs those machines.
- [ ] **Opt-in OS sandbox** (macOS codesign/notarize + App Sandbox; Linux seccomp/AppArmor) — the only thing that truly isolates the daemon from *same-user* code; documented as advanced opt-in, not default.
- [x] Doc note to exclude `~/.whatsappman` from iCloud/Time Machine/Dropbox/OneDrive — in SECURITY.md; **now surfaced in README's "A word of caution" too (2026-07-02)**.

## Post-launch addition — Desktop notifications ✅ DONE

Default-on OS notifications for the events a background daemon would otherwise
hide. Best-effort: a missing mechanism / denied permission silently no-ops,
never blocking a send.

- [x] `src/daemon/notify.ts` — `notificationsEnabled()` (settings `notifications` default true + `WHATSAPPMAN_NOTIFICATIONS` env override), `buildNotifyCommand()` pure per-OS (macOS `osascript`, Linux/BSD `notify-send`, Windows PowerShell WinRT toast; per-platform quote escaping), `notify()` best-effort `execFile` (never throws/blocks)
- [x] Wired: session → `needs_relink` (actionable: re-scan a QR); scheduler fire → sent ✓ / failed ✗
- [x] `notifications` setting (schema + `update_settings` + `settings get/set` CLI, in `BOOL_KEYS`)
- [x] Unit tests (6): per-OS command shape + escaping (AppleScript `"`/`\`, PowerShell `'`), `notificationsEnabled` env/settings precedence
- [x] Docs: README *Desktop notifications* section (default-on, per-OS mechanism table, how to disable, best-effort/no-op, **macOS Script Editor caveat → System Settings → Notifications → Script Editor**); CROSS-OS matrix row; CLI settings note
- [x] Verified on macOS: `osascript` command well-formed, `notify()` runs without throwing, setting toggles + persists
- [x] **macOS sign-off DONE** (2026-07-02): a real scheduled-send fire produced a visible macOS banner ("WhatsApp scheduled message sent → …") via the daemon → osascript path, confirmed by screenshot. Script Editor notifications were allowed.
- [ ] **Manual sign-off (remaining)**: confirm a banner on Linux (`notify-send`) and Windows (toast) — needs those desktops

## Pending, deliberately not automatic

- [x] **`npm publish`** — first published 2026-07-02 as `@indianic/whatsappman@0.1.0` on the then-private `npm.indianic.in` (author kalpesh, MIT). That registry is now **retired**: the package ships as `@integratex/whatsappman` on the public npm registry via `./scripts/release-public.sh`. Install: `npx @integratex/whatsappman init`.
- [x] **Registering the real OS daemon job on this machine (2026-07-02)** — done: `doctor` confirms `mechanism: launchd`, `OS autostart installed`, daemon `running + reachable`, `default — connected`. Survives reboot (auto-start + reconnect verified today via crash simulation).
- [ ] **A real long-lived link test** — leaving a number paired for >2 weeks to observe WhatsApp's linked-device expiry and confirm the `NEEDS_RELINK` path triggers cleanly.
