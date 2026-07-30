# whatsappman — Security Model & Threat Analysis

whatsappman runs an always-on local daemon that holds live WhatsApp
linked-device credentials and can send messages as you. That makes it a more
sensitive target than the sibling email tool (mailman), which has no daemon and
no persistent socket. This document is the threat model, the controls, and —
importantly — an honest statement of what is and isn't enforceable.

Read [STANDARDS.md](STANDARDS.md) for the baseline conventions; this file is
the security deep-dive behind them.

## Assets we're protecting

1. **Baileys credentials** (`sessions/<label>/auth/`) — these *are* the WhatsApp
   session. Whoever copies them can impersonate the number from another machine.
2. **The ability to send** — even without stealing creds, anything that can talk
   to the daemon can send messages as you.
3. **Message + recipient metadata** (`sent.jsonl`) — PII.

## The honest boundary — read this first

> **The security boundary is your OS user account, not the whatsappman
> application.** A Unix-domain socket with `0600` permissions restricts access
> to your *UID* — not to a specific binary. Unix permissions are user-based, not
> application-based. So any process running as you *can* connect to the socket.
> This is not a defect we can code away: any code running as your user already
> has your SSH keys, your OS keychain, your browser cookies, and mailman's
> credentials. whatsappman adds **no attack surface beyond what same-user code
> already has.**

What we therefore promise, precisely:

- ✅ **No network surface** — unreachable from any other machine.
- ✅ **No other OS user** can reach the daemon (peer-UID enforced).
- ✅ **No blind/accidental** same-user connection succeeds (capability token).
- ✅ **Every request is validated + audited.**
- ⚠️ **Dedicated same-user malware is not stopped** by the above — only OS-level
  sandboxing does that (see "Going further"). We say so plainly rather than
  overclaiming "no other app can access it."

## Daemon access control (defense in depth)

Five layers; the first four are enforced, the fifth is best-effort.

### 1. No network, ever
The daemon listens only on a **Unix domain socket** (`~/.whatsappman/daemon.sock`,
`0600`) inside a `0700` config dir. On Windows, a **named pipe**
(`\\.\pipe\whatsappman`). **There is no TCP listener and no loopback fallback in
the shipped product** — this removes the entire remote-attacker class. (A future
opt-in remote mode would require TLS + bearer token + explicit config and is
out of scope.)

### 2. Peer-UID check
On every accepted connection the daemon reads the peer's credentials
(`getpeereid()` on macOS/BSD, `SO_PEERCRED` on Linux) and **drops any peer whose
UID ≠ the daemon's own UID.** This makes cross-user access impossible on a
shared machine even if socket permissions were somehow loosened.

### 3. Capability token
On startup the daemon generates a 256-bit random token, writes it to
`~/.whatsappman/daemon.token` (`0600`), and **requires it on every IPC request.**
The token rotates on each daemon restart. Clients (the MCP server + CLI) read it
from the file. This blocks any connector that hasn't read your `0600` files —
port-scanners, accidental connections, processes probing the socket blindly.

### 4. Strict validation + method allowlist
Every request is parsed against a **zod schema**; unknown methods and malformed
payloads are rejected and audited. Sizes are bounded (text length, attachment
count, bulk recipient count). Request IDs are unguessable UUIDs.

### 5. Peer-executable allowlist (best-effort, NOT a hard boundary)
Optionally, the daemon resolves the peer PID → executable path
(`proc_pidpath` / `/proc/<pid>/exe`) and warns (or, if `strictPeer` is enabled,
denies) when the caller is not the whatsappman binary. **Documented explicitly
as a speed-bump, not a security boundary** — PID reuse is racy and the path is
spoofable. It exists to catch honest mistakes, not determined attackers.

### Windows named-pipe specifics
Named pipes are **not** restricted to the owner by default. The daemon must
create the pipe with:
- an explicit **DACL granting access only to the current user's SID**, and
- **`PIPE_REJECT_REMOTE_CLIENTS`** so no remote SMB client can connect.
This is a known Windows gotcha and a required Phase-5 checklist item.

## Credential protection at rest

- **`sessions/<label>/auth/` is `0700`; the config dir is `0700`; the socket,
  `daemon.token`, `daemon.pid`, and logs are `0600`.**
- **Encrypt the creds.** Baileys writes `auth/` as plaintext JSON by default. A
  copied folder (backup, cloud sync, USB) is a fully portable, cloneable
  session. Mitigation, mirroring mailman's `accounts.json` model: encrypt the
  `auth/` payloads with an **AES-256-GCM key held in the OS keychain via
  keytar** — the key never touches the config dir, so a copied folder yields
  useless ciphertext on any other machine. (Phase-8 hardening; flagged High.)
- **Keep `~/.whatsappman` out of cloud sync / backups.** Document that users
  should exclude it from iCloud Drive / Time Machine / Dropbox / OneDrive —
  syncing live session creds off-box defeats the machine-bound protection.
- `.gitignore` already excludes any local `.whatsappman/`.

## Attachment path handling — an exfiltration vector

The daemon reads arbitrary local files by absolute path to attach them. A caller
could try to "send" `~/.ssh/id_rsa`, a `.env`, or a keychain export to an
attacker-controlled number. Controls:

- **Human-visible preview** — the normal `draft_message → confirm_send` flow
  surfaces the filename **and** recipient to the human before dispatch.
- **Audit every attachment** — absolute path + recipient JID logged to
  `activity.log` on every send.
- **Sensitive-path denylist** — refuse paths under `~/.ssh`, `*.env`,
  `~/.aws`, keychain/keyring files, and the whatsappman config dir itself;
  return `ATTACHMENT_FORBIDDEN`.
- **Size cap** — enforced before read (`ATTACHMENT_TOO_LARGE`), never truncated
  silently.

> **Caveat, stated honestly:** the human preview is a UX-layer guard (Claude
> shows it, the user says yes). The daemon cannot *prove* a human approved a
> given `confirm_send` — a same-user caller holding the token could script
> `draft`+`confirm`. So the enforced guards against silent exfil are the
> denylist, the audit log, and the token — not the preview.

## Send-abuse / WhatsApp-ban risk

Baileys is unofficial; automated bulk sending risks the number being banned, and
a rogue local caller could weaponize your number for spam (reputational/legal
exposure). Controls, all enforced **in the daemon** (not just the client):
- the capability token gates who can send at all;
- a **per-session token-bucket rate limiter** (`src/daemon/rate-limit.ts`, 30
  burst / ~1 per second) on every send path (`sendText`/`sendDraft`/`sendBulk`)
  → `RATE_LIMITED`, so a runaway loop or rogue caller can't blast the number
  into a ban. Sized so normal interactive/bulk use never trips it;
- `settings.defaultDelayMs` between bulk messages + `settings.maxBulkRecipients`
  cap → `BULK_LIMIT_EXCEEDED`. The cap **refuses the whole send** rather than
  trimming to the first N, so a 1000-number list fails loudly instead of
  half-succeeding;
- the inter-send delay is **jittered ±25%** (`withJitter`). A batch firing at
  exactly 2000ms is machine-obvious, and mechanical regularity is precisely what
  automated-behaviour detection looks for;
- a **circuit breaker** (`BulkGuard`, 3 consecutive failures). This is the one
  that matters most. The send loop used to catch every error and carry on, so if
  WhatsApp began rejecting sends — which is exactly what throttling and an early
  block look like from inside — it would keep hammering through all 100
  recipients. That is the behaviour most likely to turn a warning into a ban. It
  now stops, reports the remainder as `skipped` (never contacted, so the result
  cannot imply otherwise), and raises a desktop notification. Isolated failures
  reset the counter: one dead number in a list must not stop a batch.

The breaker lives in a small class rather than inline in the loop specifically
so the decision protecting the number is unit-testable, instead of only
reachable through a live socket.

The README carries a prominent caution. **None of this makes WhatsApp a
bulk-marketing channel** — the guards keep ordinary multi-recipient use (an
on-call page, a team broadcast) from *looking* automated. Sending unsolicited
messages at volume will get the number banned regardless.

## Process & DevOps hardening

- **Never runs as root.** The launchd job runs in the user's GUI/Aqua domain;
  the systemd unit is a `--user` unit. No step uses `sudo`.
- **systemd unit sandboxing** (Linux): `NoNewPrivileges=true`,
  `ProtectSystem=strict`, `ReadWritePaths=%h/.whatsappman`, `PrivateTmp=true`,
  `ProtectControlGroups=true`, `RestrictSUIDSGID=true`, `LockPersonality=true`.
  Note: `RestrictAddressFamilies` **cannot** drop `AF_INET` — Baileys needs
  outbound TLS to WhatsApp — but `AF_UNIX`+`AF_INET`+`AF_INET6` only, no others.
- **launchd** (macOS): user agent, `RunAtLoad` + `KeepAlive{Crashed:true,
  SuccessfulExit:false}`, `ThrottleInterval` ≥10s to avoid crash-loops, logs to
  `~/.whatsappman/logs/` at `0600`.
- **Single-instance lock** — pidfile + `flock`; a stale socket is unlinked only
  after confirming no live process holds the pid (no blind unlink race).
- **Graceful shutdown** — SIGTERM flushes state, closes each Baileys socket,
  exits 0 so the OS supervisor doesn't restart a clean stop.
- **Least dependency privilege** — the launcher needs no elevated permissions;
  install writes only to `~/.whatsappman`, `~/Library/LaunchAgents` (mac) or
  `~/.config/systemd/user` (linux).

## Supply chain

Baileys carries a large transitive dependency tree, and the daemon is
long-lived **with your creds in memory** — a compromised dep has persistent
access. Controls:
- Commit `package-lock.json`; install with `npm ci` (no drift).
- Pin `@whiskeysockets/baileys` / `qrcode` / `pino` to exact-ish ranges.
- `npm audit` (or equivalent) in CI; Dependabot for security bumps.
- Review dependency additions; prefer fewer deps.

## Logging & data leakage

- `pino` at the daemon **redacts credentials and message bodies by default** —
  they never reach `daemon.*.log`.
- The **pairing QR is a live credential** — printed only to the interactive
  terminal, never written to the daemon log, short-lived.
- `sent.jsonl` stores send **metadata** (timestamp, session, recipient JID,
  kind, messageId) — never inbound content (there is no inbound handling) —
  `0600`, size-capped/rotated.
- The `--image` pairing QR is written through an explicit `0600` fd inside the
  `0700` config dir — never the shared tmpdir, where a predictable name would
  let any local user read it and become a linked device — and removed when
  pairing ends, including on Ctrl-C.

### `whatsappman summary` reads your AI transcripts

`summary` is the one feature that reads data it did not create: Claude Code
session transcripts under `~/.claude/projects` and `~/.iclaude/projects`. Those
files contain **every prompt and reply you have typed**, some of it secret — and
the digest can be sent over WhatsApp. Two rules make that safe:

- **Metadata only.** The digest carries the session's own generated title,
  counts, durations, git branch and file *names*. No prompt text, no reply text,
  no file contents. `test/digest.test.ts` plants a fake AWS key in a synthetic
  transcript and asserts it reaches neither the digest object nor the rendered
  message.
- **No model call.** Summarising is arithmetic over the transcript, not an LLM
  round-trip. Shipping a digest that phoned an API would break the "no
  third-party API, runs on your machine" promise the rest of this document
  rests on.

Sending is still your decision: `summary` prints locally and only transmits
when you pass `--to`.

## Destructive commands: cancel is never consent

`delete` and `reset` destroy credentials. Both prompt through one layer
(`src/cli/prompts.ts`) that defaults the confirmation to **No** and treats
Esc/Ctrl-C as **No** — the safe answer is the one you get by panicking out of
the prompt. Non-interactive shells cannot be prompted at all, so there they
still require an explicit `--yes` rather than proceeding. `eval/cli-surface.eval.ts`
fails the build if a destructive command stops using that helper, or if any file
hand-rolls its own prompt.

## Update security

`whatsappman update` pulls `@integratex/whatsappman` from `registry.npmjs.org`
over TLS; integrity is enforced by lockfile hashes; no elevated/`sudo`
postinstall runs. Publishing is **manual, only after explicit confirmation** — never
automated.

## Going further (opt-in OS sandboxing)

For users who genuinely need to wall the daemon off from *same-user* code — the
only thing that actually delivers "no other application can access it":

- **macOS**: ship a **codesigned + notarized** build, run under the **App
  Sandbox** with a minimal entitlement set, and rely on **TCC** so other apps
  can't inspect it; a hardened-runtime binary resists code injection.
- **Linux**: run the daemon under **seccomp** + an **AppArmor/SELinux** profile
  that restricts file and syscall access to exactly `~/.whatsappman` and the
  WhatsApp egress.
- **Containers**: run the daemon in a rootless container/namespace with only the
  config volume mounted.

These are documented as an advanced opt-in, not the default install, because
they add packaging/signing overhead disproportionate to a personal-use local
tool — but they are the honest answer to "hard isolation."

## Explicit non-goals

- No inbound message processing → no inbound-content attack surface.
- No web/HTTP surface, no database, no multi-tenant auth to get wrong.
- No secrets in the repo; no telemetry; nothing leaves the machine except the
  WhatsApp traffic itself.
