# Changelog

All notable changes to `@indianic/whatsappman` are documented here.

## [0.2.0] - 2026-07-02

- feat(cli): passive "update available" notifier — cached, non-blocking, TTY-only notice shown before command output when a newer version is published (mirrors mailman); refreshes via a detached background process, opt out with `NO_UPDATE_NOTIFIER` / `WHATSAPPMAN_NO_UPDATE_NOTIFIER`.
- feat(cli): TTY guard — `init` / `link` / `relink` (and `reset` / `delete` without `--yes`) now print a clear "needs a real terminal" message when run through an AI-tool command runner, a pipe, or CI, instead of hanging on an unscannable QR or a prompt that can't be answered.
- feat(cli): friendly "requires Node >= 18" message on old Node instead of a cryptic ESM crash.
- fix(update): `whatsappman update` now upgrades only when the registry version is strictly newer (shared `isNewerVersion`), so a dev build ahead of the published version is never "updated" backwards.

## [0.1.0] - 2026-07-02

- Initial release: MCP server + CLI to send WhatsApp messages (text, image, document, location, contact) via a Baileys-backed always-on local daemon. Multi-number, draft→confirm send, Markdown→WhatsApp formatting, bulk, daemon-held scheduling, send history, settings, desktop notifications, `init`/`doctor`/`register`/`reset`/`update`, and OS autostart (launchd/systemd/OpenRC). Local Unix-socket IPC with a capability token; attachment path guard; per-session rate limiter. No third-party API, no server, no database.
