# Evals

`npm run eval`

These evaluate the **tool surface an LLM is handed** — not the internals the
unit tests in `test/` cover. They are deterministic and offline: no model is
called, no network, no daemon, no WhatsApp session. They run in CI in under a
second.

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
