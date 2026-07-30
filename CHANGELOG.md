# Changelog

All notable changes to `@integratex/whatsappman` are documented here.

## [Unreleased]

## [0.4.2] - 2026-07-30

- **feat(doctor): a dependencies section, and `doctor --fix`.** `whatsappman update` shells out to `npm install -g`, which needs **git** — Baileys pulls `libsignal` from a git URL. So a missing git does not break a *running* install; it breaks the **next update**, with a bare `npm error syscall spawn git`. `doctor` never looked for git, so nothing warned you until that failed. It now reports git and npm alongside the existing node/npx checks, states git's role explicitly, and `--fix` prints the exact install command for the detected platform (`xcode-select --install` / `winget install --id Git.Git -e` / `sudo apt install git`).
  - It **prints, never runs**: installing git needs administrator rights, and a CLI that silently `sudo`-installs its own prerequisite is acting on a machine it does not own.
  - `installHint` is pure and exported, so the Windows and Linux branches — unverifiable from a Mac — are pinned by tests, including that no platform is ever handed another's package manager.
  - **This does not fix the first install.** That failure happens inside npm before this CLI exists, and nothing shipped in the package can catch it; npm `overrides` cannot help either (verified: they apply only to the root project, so ours are ignored when someone installs us as a dependency). The real fix is Baileys 7, which takes `libsignal` from the registry, once it leaves release-candidate status.

## [0.4.1] - 2026-07-30

- fix(readme): serve the package-page images from GitHub's CDN instead of the self-hosted site. The npm page for 0.4.0 rendered no images. Neither the URLs nor the registry's stored README were wrong — the images were simply unreachable in time: `whatsappman.indianic.dev` was answering with a **20.7s** TTFB (18–26s site-wide), far past any image proxy's patience. Not the app's fault either; measured on the server itself, our Node process served the same PNG from `127.0.0.1` in **1.4ms** — the host was CPU-starved by an unrelated tenant, which slowed the reverse proxy shared by every site on it. The images already lived in `docs/images/`, so pointing the README at `raw.githubusercontent.com` needed no new assets and cut the fetch to **0.4s**, while removing a self-hosted single point of failure from the package page of every future release. Code unchanged — this release exists only because a version's README is fixed at publish time and cannot be updated in place.

## [0.4.0] - 2026-07-30

### New commands

- **feat(cli): `whatsappman summary`** — a factual digest of your AI coding sessions: what you worked on, for how long, across which projects. Reads the Claude Code transcripts already on disk (`~/.claude/projects`, `~/.iclaude/projects`), defaults to the current project's latest session, and widens with `--all` / `--project <name>` / `--days N` / `--last N`. `--to` sends it over WhatsApp — the daily standup, written for you. **No model is called** (arithmetic, not an LLM, so the "no third-party API" promise holds) and it carries **metadata only** — session titles, counts, durations, branch, file *names* — never prompt or reply text. A transcript holds secrets; a digest you send must not, and a test plants a fake key in a transcript to prove none reaches the output. Active time ignores gaps over 10 minutes, so a session left open overnight cannot claim 14 hours.
- **feat(cli): `whatsappman run -- <command>`** — run something, then WhatsApp how it went: ✅/❌, duration, exit code, and on failure the tail of its output. Output still streams live and the command's exit code is propagated, so it drops into an existing script or CI step safely. `--on-fail` pages only on breakage; `--quiet` omits the tail. This covers the highest-traffic cases in `docs/USE-CASES.md` (#138 #246 #249 #250 #1 #2 #13) *including the failure branch* that hand-wired `&& whatsappman send …` always misses — you get pinged on success and hear nothing exactly when it broke.
- **feat(cli): `whatsappman me <text>`** — message yourself. Resolves the sending number's own phone, so the note-to-self inbox needs no number typed.
- **feat(cli): `whatsappman rename [<label>] [<newLabel>]`** — rename a number, keeping its credentials and history: moves `sessions/<label>/`, rewrites `meta.label`, carries the default pointer over, and reconnects under the new name without a QR. Refuses a name already taken, leaving both directories untouched.
- **feat(cli): `whatsappman presence <to> <typing|online|offline|recording|paused>`** — send a presence indicator. A status signal, not a message: no content is delivered and nothing is written to the audit log, so it stays outside the draft→confirm gate, but it still resolves the recipient and spends a rate-limit token like any send.

### Interactive CLI

- **feat(cli): every command that needs a value now asks for it.** `default`, `delete`, `rename`, `relink`, `reconnect`, `disconnect`, `scheduled cancel`, `settings set` and `presence` run without arguments show a real ↑/↓ menu instead of a `usage:` dead end — no remembering exact labels, copying UUIDs, or recalling that the setting is spelled `defaultDelayMs`. The CLI already wore `@clack/prompts`' diamond-tree look but had never had the library; prompts were hand-rolled `readline` ("Enter number 1-1", `Type "yes"`). One layer (`src/cli/prompts.ts`) now guarantees three things: **Esc/Ctrl-C always cancels and every prompt says so**, **cancel is never consent** (destructive confirmations default to No, so the safe answer is the one you get by panicking), and **non-TTY never blocks** — CI, pipes and MCP hosts fail fast with the argument they needed rather than hanging on a menu nobody can answer.
- fix(cli): `status <label>` on a stale or mistyped label now lists the labels that *do* exist. After a rename that is exactly the state you are in.
- fix(cli): `scheduled cancel` with nothing pending says so *and* accounts for the entries you just saw listed, instead of a bare "nothing pending" that reads like a bug.

### QR pairing

- **fix(link): the terminal QR now scans as fast as the `--image` PNG.** Three separate defects: the renderer inherited `qrcode`'s 1-module quiet zone (the standard wants 4, and a crowded finder pattern is a classic reason a camera will not lock on); solid runs were drawn with the `█` glyph, which fonts render a hair short of the cell so hairline gaps sliced through the finder patterns; and the 16-colour ANSI codes resolve to the terminal *theme's* black/white — on a dark theme a low-contrast grey-on-grey the camera has to strain to threshold. It now renders its own half-blocks with a real quiet zone, one `▀` per cell whose background paints the lower module (so solid runs are filled edge-to-edge, leading included), in the 256-palette's pure `#000`/`#fff`. A reconstruction test proves the rendered cells encode the exact source matrix, so the data is unchanged — only its legibility.

### Bulk sending

- **feat(bulk): a circuit breaker.** The send loop caught every error and carried on, so if WhatsApp started rejecting sends — which is what throttling and an early block look like from inside — it would push through all 100 recipients hammering a service telling it to stop. That is the behaviour most likely to turn a warning into a ban. It now stops after 3 *consecutive* failures, reports the remainder as `skipped` (never contacted, so the result cannot imply otherwise), and raises a desktop notification. Isolated failures reset the counter: one dead number in a list must not stop a batch.
- feat(bulk): the inter-send delay is jittered ±25%. Firing at exactly 2000 ms is machine-obvious, and mechanical regularity is what automated-behaviour detection looks for.

### Correctness

- **fix(ipc): a daemon older than your CLI now says so.** Renaming a number failed with `BAD_REQUEST: malformed request` because the daemon had been up since before the method existed. The daemon already had a precise `UNKNOWN_METHOD` error but it was unreachable — `method` is a `z.enum`, so an unknown method fails schema validation before the handler lookup that would have raised it. Both sides fixed: newer daemons answer "this daemon does not support X — it is running an older build than your CLI → run: whatsappman restart", and the client attaches the same guidance when an *already-running* daemon returns the bare old message, which is exactly when you cannot rely on the daemon being new.
- **fix(cli/windows): `run` and `summary` were broken on Windows.** `run` spawned multi-argument commands with no shell to preserve quoting; on Windows npm/npx/yarn/tsc are `.cmd` shims that CreateProcess cannot execute, so `run -- npm test` would have died with ENOENT. `summary` folded only `/` and `.` into `-`, so a Windows cwd (`C:\Users\k\App`) matched no transcript folder and reported nothing. Both now verified on a real `windows-latest` runner.

### Testing

- test: 108 → 192 tests. New coverage for the riskiest paths: `renameSession` (it moves a directory holding credentials — a bug loses a linked number, not a message), the digest's filesystem discovery and streaming parser, the bulk circuit breaker, and the Windows shell decision extracted as a pure function so it is testable without owning a Windows machine.
- eval: added `use-cases-consistency` (250 documented cases cannot drift into fiction — every command and flag is checked against the real parser), `cli-surface` (every command appears in `help` *and* the docs; no file hand-rolls a prompt), and `ipc-parity` (the `METHODS` allowlist, params schemas and daemon handlers must agree — the mismatch that produced the "malformed request" bug is now a build failure).
- **test/eval/smoke split into three tiers.** `test/` asks whether a function computes the right value; `eval/` whether the surface we hand a model or a person is correct and self-consistent (offline, under a second); `smoke/` whether the *actual published artifact* installs and works on a real OS.
- ci: a `windows-latest` / `macos-latest` / `ubuntu-latest` matrix installs the real tarball and runs one shared assertion list, so all three platforms are proven on every push rather than argued about.

### Docs

- **Installing requires `git`** — Baileys depends on `libsignal` via a git URL, so npm shells out to git; on a lean machine the install dies with a bare `npm error syscall spawn git / ENOENT`. Now stated in the README, including that no GitHub account or SSH key is involved (it is fetched over HTTPS).
- docs: `send-bulk` was never documented in `docs/CLI.md` despite being used in `USE-CASES.md` — found by the new `cli-surface` eval on its first run. Documented, along with the four anti-ban guards and the plain statement that none of them make WhatsApp a bulk-marketing channel.

## [0.3.0] - 2026-07-29

- **Package renamed to `@integratex/whatsappman`**, published to the public npm registry. The retired private registry `npm.indianic.in` is no longer a target, and `publishConfig` carries `access: public` instead of a registry pin. Everything that npx-resolves or registry-queries the package now reads the name from `package.json` at runtime (`getPackageName()`), so `whatsappman update`, the update notifier, and the editor MCP configs written by `register` can never again point at a package that doesn't exist.
- feat(link): `whatsappman link --image` (and `relink --image`) renders the pairing QR as a 512px PNG and opens it in the OS image viewer instead of drawing it in the terminal. A terminal QR cannot go below one module per character cell, so on a large terminal font it is unavoidably big; an image leaves the character grid behind and scales freely. The file is per-label and overwritten on each rotation, so the viewer refreshes in place. The pairing QR is a credential (whoever scans it first becomes a linked device), so it is written `0600` inside the `0700` config dir — never the shared tmpdir — and deleted when pairing ends, including on Ctrl-C.
- fix(link): the pairing QR no longer stacks. WhatsApp rotates the QR every ~20s and the link loop polls for ~3 minutes, so each rotation used to append another full block — several 33-row QRs marching down the terminal, with the live one pushed off-screen. It now repaints in place (cursor rewind + clear, skipped when stdout isn't a TTY or the block scrolled).
- fix(link): render the QR at error-correction level `L` — the fewest modules the payload allows, so each module is *larger* on screen. Measured against a real pairing QR (237 bytes: a 102-char ref + three 44-char base64 keys): 33×63 → 31×59 characters, QR version 11 → 10. Base64 forces byte mode, so version 10 is the smallest symbol that holds 237 bytes at `L` — 31×59 is the arithmetic floor for a terminal QR, and `--image` is the only way past it. `small: true` was already correct; `margin` was never a lever (the small renderer hardcodes a 1-module quiet zone and ignores the option).
- feat(link): warn when the QR can't fit the window ("needs 35 rows, window has 24 — enlarge the window, reduce the font size, or re-run with --image") instead of printing a QR whose top has scrolled away and can't be scanned. The terminal path also prints a one-line pointer to `--image`, since both render modes are supported and which one suits the window is the user's call.
- fix(settings): `settings set <numeric-key> ""` (an empty/whitespace value) now errors instead of silently coercing to `0` (`Number('')` is `0`).
- test: add coverage for the IPC protocol method↔schema invariant + param validation, session-label normalization/listing, MCP response/error envelopes, and settings value coercion (108 tests total, up from 67 at the start of the day).
- fix(daemon): keep the daemon crash-supervised across `restart` / `update`. `startDaemon()` used to always detached-spawn, so after a `whatsappman restart` (or `update`, which restarts) the daemon ran *outside* launchd/systemd and a crash was no longer auto-recovered (KeepAlive / Restart=on-failure) until next login. It now prefers the installed supervisor (`launchctl kickstart` / `systemctl --user start` / `rc-service start` / `schtasks /Run`), falling back to a detached spawn only when no autostart job is installed. Live-proven on launchd; per-platform command shapes unit-tested.
- feat(daemon/windows): implement the Windows Task Scheduler autostart writer (was stubbed). `daemon install` on Windows now registers an at-logon task with restart-on-failure (parity with launchd `KeepAlive` / systemd `Restart=on-failure`) via a UTF-16LE task XML; `install`/`uninstall`/`isInstalled` wired through `schtasks /Create /XML|/Delete|/Query`. Unit-tested; generated XML validated well-formed. Real execution on a Windows box remains the only pending sign-off.

## [0.2.1] - 2026-07-02

- feat(register): `register --write [--tools …] [--project]` now wires up every supported AI tool, not just Claude Code — Cursor, Gemini CLI, Windsurf (JSON `mcpServers` merge) and Codex (`[mcp_servers.whatsappman]` TOML). Idempotent, preserves unrelated servers; Claude Code still goes through the official `claude mcp add`.
- fix(cli): a bare `whatsappman link` on an already-connected number no longer dead-ends at "already connected" — it now points you to `link --label <name>` + `default <name>` so adding a second number is discoverable. Multi-number linking verified live (a connected number never blocks another's QR).

## [0.2.0] - 2026-07-02

- feat(cli): passive "update available" notifier — cached, non-blocking, TTY-only notice shown before command output when a newer version is published (mirrors mailman); refreshes via a detached background process, opt out with `NO_UPDATE_NOTIFIER` / `WHATSAPPMAN_NO_UPDATE_NOTIFIER`.
- feat(cli): TTY guard — `init` / `link` / `relink` (and `reset` / `delete` without `--yes`) now print a clear "needs a real terminal" message when run through an AI-tool command runner, a pipe, or CI, instead of hanging on an unscannable QR or a prompt that can't be answered.
- feat(cli): friendly "requires Node >= 18" message on old Node instead of a cryptic ESM crash.
- fix(update): `whatsappman update` now upgrades only when the registry version is strictly newer (shared `isNewerVersion`), so a dev build ahead of the published version is never "updated" backwards.

## [0.1.0] - 2026-07-02

- Initial release: MCP server + CLI to send WhatsApp messages (text, image, document, location, contact) via a Baileys-backed always-on local daemon. Multi-number, draft→confirm send, Markdown→WhatsApp formatting, bulk, daemon-held scheduling, send history, settings, desktop notifications, `init`/`doctor`/`register`/`reset`/`update`, and OS autostart (launchd/systemd/OpenRC). Local Unix-socket IPC with a capability token; attachment path guard; per-session rate limiter. No third-party API, no server, no database.
