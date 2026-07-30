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
| `whatsappman status [<label>]` | Detail for one number. (Bare `whatsappman status` shows the whole tree.) |
| `whatsappman relink [<label>]` | Re-pair an expired/logged-out number with a fresh QR — keeps the label and history. This is what a `NEEDS_RELINK` error tells you to run. Omit the label and it lists your numbers so you can **pick the one to relink**. |
| `whatsappman reconnect [<label>]` | Force a reconnect attempt on a merely-dropped session (creds still valid; no QR). |
| `whatsappman disconnect [<label>]` | Drop the live socket but keep creds on disk, so a later `reconnect` is instant. |
| `whatsappman rename [<label>] [<newLabel>]` | Rename a number's label, keeping its creds + history (moves `sessions/<label>/` and carries the default pointer over). Omit either argument and it **prompts** — picks the number from the list, then asks for the new name. Not an MCP tool. |
| `whatsappman delete [<label>]` | **Permanently** remove a number: closes the socket, deletes `sessions/<label>/` (auth creds + meta). Requires `--yes` (or interactive confirm). Not an MCP tool. |
| `whatsappman default [<label>]` | Set the default number used when a send omits `from`. Writes `state.json`'s `defaultSession` — the single source of truth (sessions carry no `isDefault` flag). |

## Prompts: pick instead of type, and always a way out

Every command that needs a value takes it as an argument *or* asks for it. Run
`whatsappman default`, `rename`, `delete`, `relink`, `reconnect`, `disconnect`,
`scheduled cancel`, `settings set` or `presence` with the value missing and you
get a real menu instead of a `usage:` dead end — no remembering exact labels,
no copying UUIDs, no recalling that the setting is spelled `defaultDelayMs`.

- **↑/↓** to move, **Enter** to choose, **Esc** (or **Ctrl-C**) to cancel.
- **Cancelling changes nothing** — and on `delete` and `reset` a cancel counts
  as *no*, so the safe answer is the one you get by panicking.
- **Non-interactive shells never hang.** CI, pipes and MCP hosts have no one to
  answer a menu, so there the command fails immediately with the argument it
  needed. Destructive ones still require an explicit `--yes` there.

All of this goes through one layer (`src/cli/prompts.ts`), and
`eval/cli-surface.eval.ts` fails the build if a command skips it, disappears
from `help`, or goes undocumented here.

### Sending from the terminal (optional — same engine as the MCP tools)

| Command | Purpose |
|---|---|
| `whatsappman send <to> <text> [--from <label>]` | Quick one-off text send from the terminal. **Sends directly — no preview, no prompt:** typing the command *is* the human confirmation, which is what makes it safe to use unattended in cron, CI and webhooks. (The AI-facing MCP path is the gated one: `draft_message` → `confirm_send`, with no raw send tool.) `--yes` is accepted and ignored, so it can never leak into the message body. `--raw` skips the Markdown→WhatsApp conversion. For images/docs/locations, use the `--kind`/`--path` flags below. |
| `whatsappman presence <to> <typing\|online\|offline\|recording\|paused> [--from <label>]` | Send a presence indicator to a recipient — "typing…", "recording…", or online/offline. A **status signal, not a message**: no content is delivered and nothing is written to the audit log. Handy in a script to show a human-like "typing…" just before a `send`. Friendly words map to the WhatsApp states (`typing`→composing, `online`→available, `offline`→unavailable, `stop`→paused). |
| `whatsappman send-bulk <text> --to <a,b,c> [--from <label>] [--raw]` | Send one text to many recipients, with four anti-ban guards (below). Every recipient is reported `sent`, `failed` or `skipped`. |
| `whatsappman me <text> [--from <label>]` | Message **yourself** — resolves the sending number's own phone, so the note lands in your own chat without you typing your number. The note-to-self inbox. |
| `whatsappman scheduled list` | Read-only mirror of the `list_scheduled` MCP tool — pending/sent/failed scheduled sends. |
| `whatsappman recent [--limit N]` | Tail of `sent.jsonl` — what's been sent. |

#### Bulk sending and ban risk

WhatsApp bans numbers that behave like broadcast software. `send-bulk` has four
guards, all of them on by default:

| Guard | Default | What it prevents |
|---|---|---|
| **Recipient cap** | `maxBulkRecipients` = **100** | A 200- or 1000-number blast. Over the cap the send is refused outright (`BULK_LIMIT_EXCEEDED`) — it does not send the first 100 and trim the rest. |
| **Delay between sends** | `defaultDelayMs` = **2000 ms**, jittered ±25% | Machine-gun cadence. The jitter matters: a batch firing at *exactly* 2000 ms is machine-obvious, and mechanical regularity is precisely what automated-behaviour detection looks for. |
| **Circuit breaker** | stops after **3 consecutive failures** | The real ban risk. A run of failures is what throttling or an early block looks like from inside; continuing to push the remaining recipients then is what turns a warning into a ban. The batch stops, the rest are reported `skipped` (never contacted), and you get a desktop notification. Isolated failures — one dead number in a list — reset the counter and don't stop anything. |
| **Rate limiter** | 30 burst, 1/sec sustained, per number | A runaway loop calling send in a tight cycle, regardless of `send-bulk`. |

Raise the cap with `whatsappman settings set maxBulkRecipients <n>` and slow the
pace with `settings set defaultDelayMs <ms>` — but understand you are trading
directly against the ban risk. **WhatsApp is not a bulk-marketing channel**, and
none of these guards make it one; they keep ordinary multi-recipient use (an
on-call page, a team broadcast) from looking automated. Sending unsolicited
messages at volume will get the number banned no matter what this tool does.

### Daily drivers

Two commands that collapse the most common patterns in [USE-CASES.md](USE-CASES.md)
into a single thing to type.

| Command | Purpose |
|---|---|
| `whatsappman run [--to <recipient>] [--from <label>] [--on-fail] [--quiet] -- <command …>` | Run a command, then WhatsApp **how it went**: ✅/❌, duration, exit code, and — on failure — the tail of its output. Output still streams to your terminal live, and the command's **exit code is propagated**, so it is safe to drop into an existing script or CI step. `--on-fail` notifies only when it breaks ("page me if it fails"); `--quiet` omits the output tail. Covers the long-job (#138, #246, #249), batch-status (#250), deploy (#1, #2) and build (#13) cases in one command, *including the failure branch* people usually forget to wire up. |
| `whatsappman summary [--to <recipient>] [--all] [--project <name>] [--days N] [--last N] [--max N]` | A digest of your **AI coding sessions** — what you worked on, for how long, across which projects. Defaults to the current project's latest session and just prints; `--to` sends it (the daily standup). `--all` spans every project, `--days N` a time window, `--project` one project by friendly name. |

```bash
whatsappman run --to "Me" -- npm test          # ping yourself when the suite finishes
whatsappman run --on-fail --to "DevOps" -- ./deploy.sh   # only page when it breaks
whatsappman summary                             # this project, latest session
whatsappman summary --all --days 1 --to "Me"    # today's standup, every project
```

`run` executes whatever you hand it — there is no shell script involved on
whatsappman's side, and `.sh` above is only what *that* example happens to run.
The same command on Windows:

```powershell
whatsappman run --to "Me" -- npm test
whatsappman run --on-fail --to "DevOps" -- powershell -File .\deploy.ps1
```

**On the summary's data.** It is built entirely from the Claude Code transcripts
already on your disk (`~/.claude/projects/`, `~/.iclaude/projects/`) with **no
model call** — arithmetic, not an LLM, so it keeps the "no third-party API, runs
on your machine" promise. And it carries **metadata only**: session titles,
counts, durations, branch and file *names* — never prompt or reply text. A
transcript holds everything you typed, some of it secret; a digest you send over
WhatsApp must not. `test/digest.test.ts` pins that guarantee.

### Settings & maintenance

| Command | Purpose |
|---|---|
| `whatsappman settings get` | Print current global settings (`draftTtlMinutes`, `defaultDelayMs`, `maxBulkRecipients`, `alwaysConfirm`, `notifications`). |
| `whatsappman settings set <key> <value>` | Update one setting. `defaultDelayMs` / `maxBulkRecipients` throttle bulk sends to reduce ban risk. `notifications false` turns off desktop notifications (default on; see the README's *Desktop notifications* section, incl. the macOS Script Editor permission caveat). Also overridable per-process with `WHATSAPPMAN_NOTIFICATIONS=0`. |
| `whatsappman update` (alias `upgrade`) | Self-update: checks npm for a newer `@integratex/whatsappman` and updates the global install in place, then restarts the daemon so it loads the new build (briefly drops + auto-reconnects each session). No-op with a clear message when already current. |
| `whatsappman reset` | Wipes `~/.whatsappman/` (all sessions, creds, logs, scheduled queue) **and** uninstalls the daemon startup job, for a clean re-setup. Destructive — requires explicit `--yes`, no default-confirm bypass. |
| `whatsappman help [command]` | The command list (same as `--help`), or one command's summary. |
| `whatsappman examples` | Usage examples: the one-time terminal setup plus what to actually say inside your AI tool. Rendered in the same diamond tree as every other command. |
| `whatsappman version` (`--version`, `-v`) | Print the installed version. Worth checking against `whatsappman status` after an update: the CLI and the running daemon are separate processes, so a daemon started before an upgrade keeps serving the old build until `whatsappman restart`. |

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
