# whatsappman — Standards & Conventions

whatsappman deliberately inherits every convention from its sibling
[`../mailman`](../../mailman) so the two tools feel like one family. This file
pins them so nothing drifts during the build. Where a rule has a "why", it's
because mailman learned it the hard way.

## Design — the diamond-tree CLI

Every human-facing `whatsappman <command>` renders through **one shared
diamond-tree vocabulary** (`src/cli/tree.ts`, ported from mailman), never ad
hoc `console.table()` / `JSON.stringify()` / `process.stdout.write()`. So
`status`, `numbers`, `doctor`, `daemon status`, `help`, `examples` all look
like one tool:

```
┌  whatsappman — status
│
◆  daemon
◇  running (pid 51234) · up 3h 12m · host kalpesh.local
│
◆  numbers
│  work       +91 98xxxxxxx0   connected      default
│  personal   +91 99xxxxxxx1   needs_relink
│
└  status
```

- **`◆` filled diamond** — section header (carries the one leading blank rail line).
- **`◇` hollow diamond** — a single confirmatory fact under a section; auto-flips to red **`■`** when false.
- **`■` red square** — error / failure line.
- **`▲` triangle** — worth flagging, not a hard failure (e.g. a `needs_relink` number).
- **Spacing is part of the design.** Rows attach tightly; only the `◆` header carries a blank rail line. Only `intro()`/`outro()` (`┌`/`└`) come from `@clack/prompts` — everything else writes rows directly (clack's `log.*` helpers double-space lists).

The diamond tree is **CLI-only**. Every MCP tool returns plain JSON (below), so
an AI host never has to parse decorative output.

## Output format — JSON-in-text, host-agnostic

- Every MCP tool result is `JSON.stringify(value)` inside the MCP `content`
  array's `text` block — via `src/response.ts`'s `toolResponse()` /
  `toolError(code, message)`. Same convention as mailman and this developer's
  other MCP servers, so Claude Code / Cursor / Windsurf all parse identically.
- Failures are structured `{ code, message }` (+ `isError: true`), never bare
  prose — Claude branches on `code`. See the error-code table in
  [PLAN.md](PLAN.md#error-codes).
- Select tools add a `next_steps: string[]` hint (the exact CLI command to fix
  an error, or the candidate list on an ambiguous recipient).

## Security model

- **Local-only transport.** Unix domain socket / named pipe with `0600` perms —
  no network surface. "Can this OS user read the socket file" is the trust
  boundary, same as the config itself.
- **Creds machine-local, never logged, never leave the box.** Baileys
  linked-device creds live under `~/.whatsappman/sessions/<label>/auth/` at
  `0700`. `pino` logging redacts creds and message bodies by default.
- **Optional later hardening**: encrypt the `auth/` payloads with a
  keytar-backed master key exactly as mailman encrypts `accounts.json`
  (machine-bound — copying the folder to another machine yields useless
  ciphertext). Noted, not in the initial build.
- **CLI vs MCP split is a security boundary, not just ergonomics.** Anything
  interactive, QR-dependent, or destructive (link/relink, delete, daemon
  install/uninstall, reset) is terminal-only and never an MCP tool — an LLM
  session must not be able to unpair a number, delete creds, or tear down the
  daemon. See [SKILLS.md](SKILLS.md) vs [CLI.md](CLI.md).
- **Nothing sends without a preview.** `draft_message` → `confirm_send`;
  `confirm_send` is the only dispatcher and is idempotent (no double-send).
- **Audit trail, not surveillance.** `sent.jsonl` records send metadata
  (timestamp, session, recipient JID, kind, messageId) — never inbound content
  (there is no inbound handling).
- **Destructive commands require explicit `--yes`** — no default-confirm bypass
  (`delete`, `reset`).

## Coding standards (mirrored from mailman)

| Thing | Value |
|---|---|
| Language | TypeScript, ESM (`"type": "module"`) |
| `tsconfig` | `target`/`lib` ES2022, `module`/`moduleResolution` NodeNext, `strict: true`, `declaration: true`, `rootDir: src` → `outDir: dist` |
| Lint | `typescript-eslint` recommended + `no-unused-vars` warn with `^_` ignore |
| Scripts | `build` (tsc), `dev` (tsx), `lint`, `typecheck`, `test` (`tsx --test test/*.test.ts`) |
| Node | `engines.node >= 18` |
| CI | GitHub Actions: lint → typecheck → build → test on every PR/push |
| Config schemas | zod, every persisted file carries a `schemaVersion` from day one |
| File writes | single writer (the daemon), atomic temp-file + `fs.rename()`, `.bak` before every write |
| Responses | JSON-in-text; structured `{ code, message }` errors |

## Package metadata

| Field | Value |
|---|---|
| `name` | `@indianic/whatsappman` |
| `bin` | `whatsappman` (primary) + `mcp-whatsappman` (alias, same binary) |
| `author` | `kalpesh` |
| `license` | `MIT` |
| `publishConfig.registry` | `https://npm.indianic.in/` (private IndiaNIC registry) |
| Publish | **only after explicit confirmation** — never automatic (matches mailman) |

## The single-source-of-truth rules (mailman lessons)

- **`state.json`'s `defaultSession` is the only place** that decides the default
  number. Sessions never carry an `isDefault` flag (mailman had a redundant
  per-account flag drift before it was caught — don't repeat it).
- **The daemon owns all mutable WhatsApp state.** Clients mutate only via IPC;
  they never write `sessions/`, `state.json`, or `scheduled.json` directly.
