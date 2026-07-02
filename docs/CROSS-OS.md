# whatsappman — Cross-Platform Support

whatsappman is pure Node.js (Node ≥18). [Baileys](https://github.com/WhiskeySockets/Baileys)
is Node-only but runs on every OS Node runs on, so the **core send
functionality is identical everywhere**. What differs per platform is only two
things: how the always-on daemon is kept alive (init system), and how
credentials are optionally encrypted at rest (keychain backend).

This mirrors mailman's `docs/CROSS-OS.md` stance: written cross-platform from
day one, but each OS earns a **✅ verified** badge only after a real smoke test
on that OS.

## Support matrix

| Concern | macOS | Windows | Ubuntu / Xubuntu / Debian / Fedora | Alpine / minimal servers / containers |
|---|---|---|---|---|
| **Core** (Node + Baileys + send/QR) | ✅ coded | ✅ coded | ✅ coded | ✅ coded (musl caveat) |
| **IPC transport** | Unix domain socket | named pipe (`\\.\pipe\whatsappman`) | Unix domain socket | Unix domain socket |
| **Daemon auto-start** | launchd | Task Scheduler | systemd `--user` unit | OpenRC service, or `nohup`+pidfile fallback |
| **Cred encryption (optional, keytar)** | Keychain | Credential Vault | libsecret / gnome-keyring | often unavailable → documented fallback |
| **Verified on real hardware** | pending | pending | pending | pending |

Everything is "coded / pending verification" — nothing has been built or run
yet (planning stage). Verification badges get filled in as each OS is tested.

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
