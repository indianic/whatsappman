# Evals

`npm run eval`

These evaluate **the surface we hand someone — a model or a person — and the
claims we make about it**. Not the internals the unit tests in `test/` cover.
They are deterministic and offline: no model is called, no network, no daemon,
no WhatsApp session. They run in CI in under a second.

## Three tiers, three different questions

| Tier | Command | Question it answers | Constraints |
|---|---|---|---|
| `test/` | `npm test` | Does this function compute the right value? | Offline, fast, no daemon |
| `eval/` | `npm run eval` | Is the surface we expose still correct, safe and self-consistent — and are our stated claims still true? | Offline, fast, no daemon, **static rubrics only** |
| `smoke/` | `npm run smoke` | Does the **actual published artifact** install and work on a real OS? | Needs network, Docker and a running daemon — so it sits **outside** `npm run verify` |

The boundary is not cosmetic. `smoke/` was briefly written as an eval, which
broke all three of this suite's rules at once: it pulls images over the network,
starts a daemon, and takes ~9s rather than under a second. It answers a question
neither of the other tiers can — *does the real tarball work on a real Linux
box* — so it earns its own tier rather than diluting what "eval" means here. The
same assertions run natively on ubuntu, macOS **and Windows** in
`.github/workflows/ci.yml`, which is the only way to cover Windows at all
(Windows containers require a Windows host).

## Why these exist separately from `test/`

The unit tests answer *"does this function compute the right value?"*. These
answer a different question: *"is what we hand the model still correct, safe,
and unambiguous?"* — a question no unit test was asking.

Two real failures motivated them:

- Four source files hardcoded `@indianic/whatsappman` while the README shipped
  `@integratex/whatsappman`. `whatsappman register` wrote editor MCP configs
  launching a package `npx` could not resolve, so the server failed to start for
  anyone installing from npm. Every test passed throughout.
- `cancel_scheduled` was described as *"Cancel a pending scheduled send."* —
  nothing telling a model where `scheduledId` comes from, or how it differs from
  `cancel_draft`. Caught by `tool-surface.eval.ts` on its first run and fixed.

## The suites

| File | Asserts |
|---|---|
| `safety-invariants.eval.ts` | The draft → preview → confirm gate is real. No tool reaches the daemon's raw `send_text`/`send_bulk`; `confirm_send` is the only dispatcher and accepts **nothing but** a `draftId`; only `draft_message` accepts message content. |
| `tool-surface.eval.ts` | Schema quality that decides tool-calling accuracy: closed objects (`additionalProperties: false`), every param described and typed, no two tools reading alike, every `required` field declared, every method in the IPC allowlist, plus a drift guard on the tool set. |
| `docs-consistency.eval.ts` | Countable doc claims stay true — the README badge and prose tool counts, `docs/FEATURES.md`, the "no raw send tool" promise (present in docs *and* true in code), and that no retired `@indianic` / `npm.indianic.in` reference creeps back into user-facing install docs. |
| `use-cases-consistency.eval.ts` | `docs/USE-CASES.md` promises every command and flag in it was checked against the real parser. Derives the actual surface from `src/cli` and fails on the first token the CLI would not recognise, so 250 documented cases cannot drift into fiction. |
| `cli-surface.eval.ts` | The **human** CLI stays coherent: every command appears in `whatsappman help` *and* in `docs/CLI.md`, no file hand-rolls a `readline` prompt (they all go through `prompts.ts`, so cancelling always works and never counts as consent), and the destructive commands really do use the shared confirmation. Found `send-bulk` undocumented on its first run. |
| `ipc-parity.eval.ts` | The IPC contract's three halves agree: the `METHODS` allowlist, the per-method params schema, and the daemon's handler map. A method in one but not another fails only at runtime — which is exactly how `rename` once reached a user as `malformed request`. Also asserts no state-changing method accepts empty params. |

## What they do *not* prove

They are **static rubrics**, not model-in-the-loop evals. They verify the
contract is well-formed, safe, and self-consistent. They cannot tell you whether
a given model *actually* picks `draft_message` over `confirm_send` in a real
conversation — that needs live transcripts and is deliberately out of scope
here, so the suite stays fast, free, and non-flaky.

## Adding a tool

`tool-surface.eval.ts` holds `EXPECTED_TOOLS`, and the doc evals check the
counts in `README.md` and `docs/FEATURES.md`. Adding a tool will fail all three
until you update them — that is the point: the tool surface should never grow by
accident, and the docs should never drift from it.

## Keeping them honest

Each suite is checked against a deliberately broken build before being trusted.
Injecting a `send_message` tool wired to `send_text` — precisely the regression
these exist to catch — fails 9 evals across all three files. An eval that cannot
fail is worse than no eval, so verify any new one the same way.
