# whatsappman — Cross-Platform Support

whatsappman is pure Node.js (Node ≥18). [Baileys](https://github.com/WhiskeySockets/Baileys)
is Node-only but runs on every OS Node runs on, so the **core send
functionality is identical everywhere**. What differs per platform is only two
things: how the always-on daemon is kept alive (init system), and how
credentials are optionally encrypted at rest (keychain backend).

This mirrors mailman's `docs/CROSS-OS.md` stance: written cross-platform from
day one, but each OS earns a **✅ verified** badge only after a real smoke test
on that OS.

## How verification works now (since 0.4.2)

Platform support is no longer argued about — it is **measured on every push**.
`.github/workflows/ci.yml` runs a matrix over `ubuntu-latest`, `macos-latest`
and `windows-latest` that **packs the real npm tarball, installs it globally,
and drives the installed CLI** through `smoke/cli-assertions.mjs`. The same
assertion list runs inside a throwaway Linux container via `npm run smoke`, so
the container and the three CI platforms can never drift apart.

Each platform asserts it picks *its own* autostart mechanism **and rejects the
others'** — Linux must never select launchd, Windows must never select systemd.
The suite also covers exit-code propagation from `run`, graceful behaviour on a
machine with no state, that no prompt blocks without a TTY, and that the daemon
**starts and stops**.

Windows containers require a Windows *host*, so no amount of Docker on a Mac or
a Linux box substitutes for the `windows-latest` runner. That runner is the only
reason the Windows column below says verified rather than coded.

**Two Windows-only bugs were found and fixed this way**, both invisible on
POSIX and total on Windows:

- `whatsappman run` spawned multi-argument commands with no shell to preserve
  quoting exactly. On Windows `npm`/`npx`/`yarn`/`tsc` are `.cmd` shims that
  CreateProcess cannot execute, so `run -- npm test` — the most likely thing
  anyone types — died with `ENOENT`.
- `whatsappman summary` folded only `/` and `.` into `-` when resolving the
  transcript folder, so a Windows cwd (`C:\Users\k\App`) matched nothing and the
  digest silently reported no sessions.

Both were fixed by reasoning about win32 semantics *before* the runner existed —
and only the runner turned that reasoning into evidence.

## Support matrix

| Concern | macOS | Windows | Ubuntu / Xubuntu / Debian / Fedora | Alpine / minimal servers / containers |
|---|---|---|---|---|
| **Core** (Node + Baileys + send/QR) | ✅ coded | ✅ coded | ✅ coded | ✅ coded (musl caveat) |
| **IPC transport** | Unix domain socket | named pipe (`\\.\pipe\whatsappman`) | Unix domain socket | Unix domain socket |
| **Daemon auto-start** | launchd | Task Scheduler | systemd `--user` unit | OpenRC service, or `nohup`+pidfile fallback |
| **Cred encryption (optional, keytar)** | Keychain | Credential Vault | libsecret / gnome-keyring | often unavailable → documented fallback |
| **Desktop notifications (default-on, best-effort)** | `osascript` (shows as **Script Editor** — permission caveat) | PowerShell WinRT toast | `notify-send` (needs libnotify + a desktop session) | none on headless → silent no-op |
| **Install + CLI + daemon lifecycle** | ✅ CI, every push | ✅ CI, every push | ✅ CI, every push | ✅ `npm run smoke` (container) |
| **Verified on real hardware** | ✅ send + link + daemon + **notification banner** | CI runner only — no live WhatsApp send yet | CI runner + container | container only |

Notifications never block or fail a send — a missing mechanism or denied
permission silently no-ops. See the README's *Desktop notifications* section
for the mechanism details, how to disable, and the **macOS Script Editor**
permission caveat (System Settings → Notifications → Script Editor).

**What the CI badge does and does not cover.** It proves the published package
installs and the CLI and daemon behave on that OS. It does **not** prove a live
WhatsApp send there — that needs a real linked number, which a CI runner cannot
have. Real Baileys socket behaviour (throttling, reconnects, bans) is still only
learnable in production, on any platform.

## Prerequisites (all platforms)

**Node ≥18 and `git`.** git is not optional: Baileys pulls `libsignal` from a
git URL, so npm shells out to git during install — and `whatsappman update`
calls `npm install -g`, so a missing git breaks the *next update* with a bare
`npm error syscall spawn git`. `whatsappman doctor` reports both, and
`doctor --fix` prints the install command for the detected platform. Windows in
particular does not ship git by default.

No GitHub account or SSH key is involved; upstream declares `git+https`.

## Layer 1 — Core: identical everywhere

Node ≥18 + `@whiskeysockets/baileys` + `qrcode` + `pino`. Sending text, image,
document, location, contact; QR pairing (rendered as terminal ASCII, so **no
GUI is required** — works over SSH on a headless server); auto-reconnect;
multiple numbers. No platform branching in this layer.

## Layer 2 — IPC transport

- **POSIX (macOS, Linux, all distros)** — Unix domain socket at
  `~/.whatsappman/daemon.sock`, `0600`.
- **Windows** — no Unix sockets, so a **named pipe** with an owner-SID-only
  DACL + `PIPE_REJECT_REMOTE_CLIENTS` (see [SECURITY.md](SECURITY.md)).

`src/ipc/transport.ts` picks by `process.platform`; everything above it (client,
server, protocol) is platform-agnostic.

## Layer 3 — Daemon auto-start: no single mechanism

`whatsappman daemon install` detects the platform / init system and installs the
right startup job so the daemon runs at login and restarts on crash:

- **macOS → launchd.** Per-instance launcher + plist, `RunAtLoad` +
  `KeepAlive{Crashed:true, SuccessfulExit:false}`, `ThrottleInterval`. (Modeled
  on the newra daemon.)
- **Windows → Task Scheduler** at-logon trigger (or Startup-folder launcher).
- **systemd distros (Ubuntu, Xubuntu, Debian, Fedora, most desktop Linux) →
  systemd `--user` unit.** `Restart=on-failure`; `loginctl enable-linger` so it
  survives logout / runs on a headless server without an active session.
- **Alpine — the notable difference: Alpine uses OpenRC, not systemd.** The
  installer detects the absence of systemd-user and falls back to an **OpenRC
  service** or, failing that, a **`nohup` + pidfile launcher**. The
  `nohup`+pidfile path is also the universal fallback for any init-less
  container or minimal host.
- **Detection order:** systemd-user present? → systemd. Else OpenRC present? →
  OpenRC. Else → `nohup`+pidfile. `whatsappman doctor` reports which mechanism
  is in use.

The launchd/systemd/cron **PATH gotcha** (these don't inherit the shell PATH, so
`node`/`npx` aren't found) is handled by baking `process.execPath`'s dir +
common install dirs into the job's PATH — logic lifted from mailman's
`src/scheduler/ticker-install.ts`.

## Layer 4 — Credential encryption (optional): the keytar caveat

Encrypting the Baileys `auth/` creds with a keychain-backed key (see
[SECURITY.md](SECURITY.md)) is the **one place with a native dependency**
(`keytar`) and the one place platform support is uneven:

- **macOS** → Keychain. **Windows** → Credential Vault. **Ubuntu/Xubuntu/Fedora
  with a GUI** → libsecret / gnome-keyring. All fine.
- **Alpine (musl libc, not glibc)** — keytar's prebuilt native binary may not
  exist for musl, needing build tools (`build-base`, `libsecret-dev`) to compile
  from source; and a minimal Alpine box usually has **no keyring daemon at
  all**.
- **Any headless server / container** — typically no keyring daemon reachable.

Because of this, **cred encryption is optional and never blocks core
functionality.** When no keyring is available the daemon either (a) runs with
plaintext creds + a clear warning to restrict `~/.whatsappman` perms and exclude
it from sync/backup, or (b) uses a passphrase-derived key. Base sending works
on Alpine/headless regardless of keytar.

## A note in whatsappman's favour on servers

Because whatsappman *needs* an always-on process anyway, a **Linux server
(Ubuntu or Alpine)** is arguably the *best* host: it never sleeps, so the
WhatsApp connection and scheduled sends stay solid — unlike a laptop that
suspends and must reconnect on wake. Pair the number once over SSH (the QR
renders as terminal ASCII, no GUI needed) and it runs indefinitely.

## Verification checklist (per OS)

Marked done only after a real run on that OS:

- [ ] macOS — link, send, daemon reconnect-after-restart, launchd auto-start
- [ ] Windows — named-pipe IPC, Task-Scheduler auto-start, send
- [ ] Ubuntu / Xubuntu — systemd `--user` + linger, send, reconnect
- [ ] Alpine — OpenRC / `nohup` fallback, send **without** keytar (plaintext-creds path + warning)
- [ ] Headless server over SSH — QR pairing in a terminal, no GUI
