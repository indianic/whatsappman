import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { METHODS, paramsSchemas } from '../src/ipc/protocol.js';

/**
 * The IPC contract has three halves that must agree: the METHODS allowlist, the
 * per-method params schema, and the daemon's handler map. Adding a feature means
 * touching all three, and missing one fails only at runtime — the exact failure
 * that shipped today, where a method the daemon didn't know surfaced to the user
 * as "malformed request" while renaming a number.
 *
 * These evals make that mismatch a build failure instead of a user's bug report.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const daemonMain = readFileSync(path.join(ROOT, 'src/daemon/main.ts'), 'utf8');

/** Handler keys registered in the daemon's `new Map<Method, Handler>([...])`. */
const registered = new Set(
  [...daemonMain.matchAll(/^\s*\[?\s*'([a-z_]+)',\s*(?:\(|async|\()/gm)].map((m) => m[1]),
);
// Single-line handlers like `['ping', () => …]` and multi-line `['x', async (…)`
// both match above; also catch the `'name',` on its own line form.
for (const m of daemonMain.matchAll(/^\s*'([a-z_]+)',$/gm)) registered.add(m[1]);

test('the daemon handler map parsed into a plausible surface', () => {
  assert.ok(
    registered.size >= METHODS.length - 2,
    `only parsed ${registered.size} handlers for ${METHODS.length} methods — the parser is likely broken, not the code`,
  );
});

test('every allowlisted IPC method has a daemon handler', () => {
  // A method in METHODS with no handler passes schema validation, reaches the
  // handler lookup, and dies as UNKNOWN_METHOD at runtime — for the user, a
  // command that simply does not work.
  const orphans = METHODS.filter((m) => !registered.has(m));
  assert.deepEqual(orphans, [], `methods with no daemon handler: ${orphans.join(', ')}`);
});

test('every daemon handler is an allowlisted method', () => {
  // The reverse: a handler whose name is not in METHODS is dead code, because
  // requestSchema's enum rejects the request before the lookup ever happens.
  const unreachable = [...registered].filter((h) => !(METHODS as readonly string[]).includes(h));
  assert.deepEqual(unreachable, [], `handlers unreachable via METHODS: ${unreachable.join(', ')}`);
});

test('every allowlisted method has a params schema', () => {
  const missing = METHODS.filter((m) => !paramsSchemas[m]);
  assert.deepEqual(missing, [], `methods without a params schema: ${missing.join(', ')}`);
});

test('a method that changes state is never given a no-params schema by accident', () => {
  // `noParams` on a mutating method means the daemon would accept a call with no
  // arguments and act on undefined — e.g. delete_session with no label.
  const mutating = METHODS.filter((m) =>
    /^(send_|draft_|confirm_|cancel_|schedule_|delete_|rename_|relink|reconnect|disconnect|set_|update_|link)/.test(m),
  );
  assert.ok(mutating.length >= 10, 'sanity: expected to find the mutating methods');
  for (const m of mutating) {
    const schema = paramsSchemas[m];
    // undefined must not satisfy a mutating method's schema.
    assert.equal(
      schema.safeParse(undefined).success,
      false,
      `${m} changes state but accepts no params — a call with no arguments would act on undefined`,
    );
  }
});
