# Changelog

All notable changes to `@indianic/whatsappman` are documented here.

## [Unreleased]

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
