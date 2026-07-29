# Changelog

All notable changes to `@integratex/whatsappman` are documented here.

## [Unreleased]

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
