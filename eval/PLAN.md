# Eval plan — the CLI tier

## Why the site's approach does not transfer

The site can be **rendered and inspected**. Open a page, read the DOM, and you
have the artefact a visitor sees. That is why its evals are mostly structural
(does this link resolve, does this file exist) and its smoke tier drives Chrome.

A CLI has no DOM. Its entire contract with the outside world is four things:

```
argv  →  ( stdout , stderr , exit code )   + what it did to the filesystem
```

Everything a user or a script can observe passes through that boundary. So the
CLI eval tier should be organised around **that contract**, not around source
structure. The existing 51 evals mostly check *internal consistency* — command
lists agree with docs, tools map to handlers, schemas are well-formed. Valuable,
and all of it is upstream of the boundary. Almost nothing yet pins the boundary
itself.

That matters more here than for most CLIs, because WhatsAppMan is designed to be
**scripted and unattended**: `whatsappman run -- ./deploy.sh` in CI, a cron
digest, an AI agent calling it. Every one of those runs with no human watching,
no terminal attached, and a caller that reads the exit code and nothing else.

## The four boundary invariants

### B1 — exit codes mean something

Today: `0`, `1`, `130` are the only codes in `src/`. That is already correct
discipline and nothing enforces it.

The contract that makes `whatsappman send … && ./deploy.sh` safe:

| code | meaning |
|-----|---------|
| `0` | it worked |
| `1` | it declined cleanly — not connected, nothing to do, user said no |
| `130` | interrupted (SIGINT), the POSIX `128 + SIGINT` convention |

The failure this prevents is the worst kind a CLI has: **exit 0 on failure.**
A script chained with `&&` then proceeds as if a message was delivered when it
was not. `smoke/all-commands.mjs` checks `0 or 1` at runtime for 31 commands;
nothing checks the source can't grow an `exit(2)` or an early `exit(0)` on an
error path.

### B2 — stream discipline

`stdout` is the data. `stderr` is the commentary. The rule is `whatsappman
recent | jq` must work, and progress noise must never land in the pipe.

Current state is unusually good: **zero `console.log` in `src/`** — everything
goes through the `tree.ts` renderer. That is exactly the discipline worth
pinning *before* someone adds a quick `console.log` while debugging and ships it.

### B3 — never hang without a TTY

An interactive prompt with no terminal attached does not fail — it **waits
forever**. In cron or CI that is a hung job, no output, no exit, until something
kills it. We have `canPrompt()` for exactly this; the eval is that every prompt
call site is behind it, with no exceptions.

This is the single highest-consequence CLI-native invariant, because the failure
mode is silent and unbounded. `all-commands.mjs` proves it at runtime for the 8
interactive commands *that exist today* — a static eval covers the ninth, the
day someone adds it.

### B4 — no ANSI when piped

Colour codes written into a log file or a pipe corrupt it. Rendering must be
conditional on `stdout.isTTY`.

## The gaps found in the audit

Beyond the boundary work, four concrete gaps — two of them already broken:

### P1 — version-string drift ✅ *shipped*

`docs/FEATURES.md` declared itself three releases behind, publicly, on GitHub.

It was the **second** occurrence: the strings were fixed once by hand and the
invariant was never pinned, so it came straight back — the whole argument for an
eval rather than a fix. The site already had `no page hardcodes a package
version`; the package had no equivalent.

**Fixed by deleting the rot source**, not by bumping the number. The header now
points at npm, so there is nothing left to go stale and no doc edit required at
release time. The eval remains, to catch anyone re-adding one.

**Eval:** no doc *declares itself* at a version other than `package.json`'s, and
no doc pins an install to a stale version. Prose about history — "since 0.4.2",
"first published as 0.1.0" — stays legal, which is what keeps this eval switched
on. CHANGELOG and dot-directories (`.remember/`, a gitignored dated journal) are
records, not declarations, and are excluded.

### P2 — the audit log must stay metadata-only

`src/audit.ts` states it: *"metadata only (never message bodies or inbound
content)"*. `SentLogEntry` has no content field, and the sent record confirms it
in practice.

This is not a nicety. It is the claim the product is sold on — *"your machine
only, no API, no server, no database"* — and the reason it is safe to point an
AI at WhatsApp at all. One `body: text` added to that interface in a debugging
session and every message a user ever sent is on disk in plaintext, forever,
with nothing failing.

**Eval:** `SentLogEntry` declares no content-bearing field (`text`, `body`,
`message`, `caption`, `content`), and no `appendSent` call site passes one.

### P3 — cross-OS assumptions

Zero of the 51 evals mention `win32`. Both Windows bugs this project has had
(`.cmd` shims need a shell; `encodeProjectDir` missed `\` and `:`) were caught by
CI on Windows — *after* being written, pushed, and run through a full green local
`verify`.

An eval catches that class in under a second on the machine writing it. Must be
written narrowly: `src/daemon/install.ts` contains legitimate POSIX paths for
launchd and systemd, so a naive `/usr/` grep is a false-positive factory. Target
instead: user-facing paths built with string `'/'` concatenation rather than
`path.join`, and platform branches that handle `darwin`/`linux` but not `win32`.

### P4 — README and docs command snippets

We validate every `whatsappman …` invocation in `USE-CASES.md` — commands and
flags must exist. We do **not** validate `README.md` or the rest of `docs/`,
which is what someone reads first and copy-pastes.

**Eval:** extend the existing `use-cases-consistency` parser across every tracked
markdown file. The parser already exists; only its input set changes.

## Priority

| | what | tier | why now |
|---|---|---|---|
| **P1** | version drift | eval | already broken, in public, second occurrence |
| **P2** | audit log metadata-only | eval | protects the core privacy claim |
| **B3** | no prompt without a TTY | eval | silent unbounded hang in cron/CI |
| **B1** | exit-code contract | eval | `&&` chains treat failure as success |
| **P3** | cross-OS | eval | the only class that has actually shipped broken twice |
| **P4** | docs snippets | eval | rot in the most-read file |
| **B2** | stream discipline | eval | cheap, locks in discipline already held |
| **B4** | no ANSI when piped | eval | corrupts logs; low frequency |

All eight are **static** — offline, no daemon, no network, sub-second. They
belong in the eval tier, not smoke. Estimated: 20–24 new cases across three new
files (`boundary.eval.ts`, `privacy.eval.ts`, `cross-os.eval.ts`) plus edits to
`docs-consistency` and `use-cases-consistency`.

## What stays out of the eval tier

Worth stating, so this does not creep:

- **Real send / delivery** — needs a live WhatsApp session. Smoke, and mostly manual.
- **Terminal rendering fidelity** (the QR) — needs a real terminal and human eyes.
  Three rounds of fixes were driven by a photograph of a screen; no eval was ever
  going to catch "the modules are too small to scan."
- **Daemon lifecycle under load** — needs a running daemon. Smoke.
- **Anything requiring Docker or Chrome** — already correctly in smoke.
