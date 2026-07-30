# whatsappman — CLI Commands

These are commands **you** type directly in a terminal — daemon lifecycle,
number linking/management, setup, and diagnostics. They're separate from the
MCP tools in [docs/SKILLS.md](SKILLS.md), which Claude calls conversationally.
The split is deliberate: anything interactive (scanning a QR), destructive
(deleting a session, resetting), or that manages the background daemon belongs
here, not behind something an LLM session could be talked into triggering.

The primary command is **`whatsappman`**. `mcp-whatsappman` is kept as an alias
(both resolve to the same binary).

Bare `whatsappman` behaves differently by context: launched over pipes (how
every MCP host runs it), it starts the stdio MCP server; typed by a person at a
TTY, it shows the command list instead — a bare JSON-RPC server silently
waiting on stdin is never what a human wanted. The `daemon start` argv path is
what the OS startup job invokes; it's not something you normally type (use
`whatsappman start`). Unknown commands suggest the nearest real one.

## Command list

### Setup

| Command | Purpose |
|---|---|
| `whatsappman init` | First-run wizard, the recommended starting point. Installs the always-on daemon (launchd/systemd/Task-Scheduler job), starts it, **links your first number by QR** (prints the QR in the terminal — scan it with WhatsApp → Linked Devices), sets it as default, then **auto-writes the `whatsappman` MCP config into whichever AI tools you pick** (Claude Code, Cursor, Gemini CLI, Windsurf, Codex) at a chosen scope. Idempotent. |
| `whatsappman register` | Register whatsappman with your AI editors without the rest of `init`. `register --tools <a,b,…\|all> [--scope global\|project]` writes/merges each tool's MCP config directly (same engine `init` uses; idempotent). `register -i` runs the interactive picker. Bare `register` just prints the copy-pasteable `claude mcp add whatsappman -- npx -y @integratex/whatsappman` line without writing anything. |

### Daemon lifecycle

| Command | Purpose |
|---|---|
| `whatsappman daemon install` | Write the platform startup job (launchd plist / systemd user unit / Task-Scheduler task) + the per-instance launcher, so the daemon runs at login and restarts on crash. Run for you by `init`; idempotent. |
| `whatsappman daemon uninstall` | Unload and remove the startup job + launcher. Keeps `sessions/` (your linked numbers) unless `--purge`. |
| `whatsappman start` | Load/start the daemon now (it also auto-starts at login once installed). |
| `whatsappman stop` | Clean SIGTERM. The daemon exits 0, so `KeepAlive` leaves it stopped — it won't fight you. |
| `whatsappman restart` | Stop then start. |
| `whatsappman status` | The `@clack/prompts` diamond tree: daemon up? (pid, uptime, host), every number with its status, default marker, pending-scheduled count. Same data as the `get_status` MCP tool. |
| `whatsappman logs [-f] [--err]` | Print (or `-f` follow) the daemon log at `~/.whatsappman/logs/daemon.out.log` (`--err` for stderr). |
| `whatsappman doctor` | Pre-flight checks, distinct from `status` (which reports configured state): is the daemon socket reachable, socket/creds perms correct, Node ≥18, is `node`/`npx` on the startup job's PATH (catches the launchd/systemd bare-PATH gotcha), and each session's live connection. |

### Numbers (multiple, each a session)

| Command | Purpose |
|---|---|
| `whatsappman link [--label <name>] [--image]` | Link a **new** number. Renders a fresh QR in the terminal; scan it with WhatsApp → Linked Devices. On success, writes `sessions/<label>/` with the resolved phone number. Repeat for as many numbers as you want. Defaults the label to the phone number if `--label` is omitted. Pass `--image` to open the QR as a PNG in your image viewer instead — useful when a large terminal font makes the in-terminal QR fill the window (it can't be shrunk below one module per character cell). |
| `whatsappman numbers` (alias `list`) | Table of all sessions: **label · phone · status · last-connected · default**. |
| `whatsappman status <label>` | Detail for one number. (Bare `whatsappman status` shows the whole tree.) |
| `whatsappman relink <label>` | Re-pair an expired/logged-out number with a fresh QR — keeps the label and history. This is what a `NEEDS_RELINK` error tells you to run. |
| `whatsappman reconnect <label>` | Force a reconnect attempt on a merely-dropped session (creds still valid; no QR). |
| `whatsappman disconnect <label>` | Drop the live socket but keep creds on disk, so a later `reconnect` is instant. |
| `whatsappman delete <label>` | **Permanently** remove a number: closes the socket, deletes `sessions/<label>/` (auth creds + meta). Requires `--yes` (or interactive confirm). Not an MCP tool. |
| `whatsappman default <label>` | Set the default number used when a send omits `from`. Writes `state.json`'s `defaultSession` — the single source of truth (sessions carry no `isDefault` flag). |

### Sending from the terminal (optional — same engine as the MCP tools)

| Command | Purpose |
|---|---|
| `whatsappman send <to> <text> [--from <label>]` | Quick one-off text send from the terminal. **Sends directly — no preview, no prompt:** typing the command *is* the human confirmation, which is what makes it safe to use unattended in cron, CI and webhooks. (The AI-facing MCP path is the gated one: `draft_message` → `confirm_send`, with no raw send tool.) `--yes` is accepted and ignored, so it can never leak into the message body. `--raw` skips the Markdown→WhatsApp conversion. For images/docs/locations, use the `--kind`/`--path` flags below. |
| `whatsappman scheduled list` | Read-only mirror of the `list_scheduled` MCP tool — pending/sent/failed scheduled sends. |
| `whatsappman recent [--limit N]` | Tail of `sent.jsonl` — what's been sent. |

### Settings & maintenance

| Command | Purpose |
|---|---|
| `whatsappman settings get` | Print current global settings (`draftTtlMinutes`, `defaultDelayMs`, `maxBulkRecipients`, `alwaysConfirm`, `notifications`). |
| `whatsappman settings set <key> <value>` | Update one setting. `defaultDelayMs` / `maxBulkRecipients` throttle bulk sends to reduce ban risk. `notifications false` turns off desktop notifications (default on; see the README's *Desktop notifications* section, incl. the macOS Script Editor permission caveat). Also overridable per-process with `WHATSAPPMAN_NOTIFICATIONS=0`. |
| `whatsappman update` (alias `upgrade`) | Self-update: checks npm for a newer `@integratex/whatsappman` and updates the global install in place, then restarts the daemon so it loads the new build (briefly drops + auto-reconnects each session). No-op with a clear message when already current. |
| `whatsappman reset` | Wipes `~/.whatsappman/` (all sessions, creds, logs, scheduled queue) **and** uninstalls the daemon startup job, for a clean re-setup. Destructive — requires explicit `--yes`, no default-confirm bypass. |
| `whatsappman help [command]` | The command list (same as `--help`), or one command's summary. |
| `whatsappman examples` | Usage examples: the one-time terminal setup plus what to actually say inside your AI tool. Rendered in the same diamond tree as every other command. |

## Why linking is CLI-only

Pairing a number requires displaying a QR code and having a human scan it with
their phone — inherently interactive and terminal-bound. There's no
conversational way for an LLM to do it, and it's also the one moment where
credentials are created, so it stays a deliberate, human-run action.
`whatsappman relink` (re-pairing an expired number) is the same, which is why a
`NEEDS_RELINK` error from a send always points you back to the terminal.

## Typical first run

```bash
npx @integratex/whatsappman init
# → installs the daemon, prints a QR
# → scan with WhatsApp (Settings → Linked Devices → Link a Device)
# → "work" number connected, set as default
# → MCP config written into Claude Code

# link a second number later:
whatsappman link --label personal
# scan its QR too

whatsappman numbers
# work       +91 98xxxxxxx0   connected      default
# personal   +91 99xxxxxxx1   connected

# then, from any Claude session:
#   "whatsappman, send 'on my way' to Kalpesh from work"
```
