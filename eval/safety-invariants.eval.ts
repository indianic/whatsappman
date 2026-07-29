import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../src/mcp/server.js';

/**
 * The product's headline safety claim, made assertable:
 *
 *   "there's no raw 'send' tool, so an AI can never send an unpreviewed message"
 *
 * Everything here checks the surface an LLM is handed. These are the invariants
 * that make the claim true; if one breaks, the claim silently becomes false
 * while every unit test still passes.
 */

/** IPC methods that dispatch a message straight out, with no draft in between. */
const RAW_DISPATCH_METHODS = ['send_text', 'send_bulk'];

/** The one tool allowed to actually send, and the method it may use. */
const GATED_DISPATCHER = { tool: 'confirm_send', method: 'confirm_send' };

const entries = Object.entries(TOOLS);

test('no MCP tool is wired to a raw dispatch method', () => {
  // send_text / send_bulk exist on the daemon for the CLI (a human typed the
  // command). Exposing either over MCP would hand the model a one-shot send.
  const leaks = entries
    .filter(([, def]) => RAW_DISPATCH_METHODS.includes(def.method))
    .map(([name, def]) => `${name} -> ${def.method}`);
  assert.deepEqual(leaks, [], `raw send exposed to the model: ${leaks.join(', ')}`);
});

test('exactly one tool dispatches, and it is confirm_send', () => {
  const dispatchers = entries.filter(([name]) => name === GATED_DISPATCHER.tool);
  assert.equal(dispatchers.length, 1, 'confirm_send must exist');
  assert.equal(TOOLS[GATED_DISPATCHER.tool].method, GATED_DISPATCHER.method);
});

test('no tool is named like a direct send', () => {
  // A model picks tools by name first. `send_message` sitting next to
  // `draft_message` would get called on its own.
  const suspicious = entries
    .map(([name]) => name)
    .filter((name) => /^(send|post|deliver|dispatch|reply)(_|$)/.test(name));
  assert.deepEqual(suspicious, [], `tool name invites an ungated send: ${suspicious.join(', ')}`);
});

test('confirm_send accepts ONLY a draftId — no content can ride along', () => {
  // This is the crux. If confirm_send took `text` or `to`, the model could
  // dispatch arbitrary content that the user never previewed, and the whole
  // draft→preview→confirm chain would be decorative.
  const schema = TOOLS.confirm_send.inputSchema as {
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };
  assert.deepEqual(Object.keys(schema.properties), ['draftId'], 'confirm_send must take nothing but draftId');
  assert.deepEqual(schema.required, ['draftId'], 'draftId must be required, not optional');
  assert.equal(schema.additionalProperties, false, 'extra properties must be rejected, not ignored');
});

test('schedule_send sends a draft, never raw content', () => {
  // Scheduling is a deferred dispatch — it must be gated by the same draft.
  const schema = TOOLS.schedule_send.inputSchema as {
    properties: Record<string, unknown>;
    required: string[];
  };
  assert.ok(schema.required.includes('draftId'), 'a scheduled send must reference a draft');
  const contentish = Object.keys(schema.properties).filter((p) =>
    ['text', 'to', 'path', 'kind', 'contactPhone'].includes(p),
  );
  assert.deepEqual(contentish, [], `schedule_send must not accept content: ${contentish.join(', ')}`);
});

test('draft_message is the only tool that accepts message content', () => {
  const contentKeys = ['text', 'path', 'latitude', 'longitude', 'contactName', 'contactPhone'];
  for (const [name, def] of entries) {
    if (name === 'draft_message') continue;
    const props = Object.keys((def.inputSchema as { properties: Record<string, unknown> }).properties);
    const carries = props.filter((p) => contentKeys.includes(p));
    assert.deepEqual(carries, [], `${name} must not accept message content: ${carries.join(', ')}`);
  }
});

test('draft_message does not dispatch', () => {
  assert.equal(TOOLS.draft_message.method, 'draft_message');
  assert.match(
    TOOLS.draft_message.description,
    /does\s+not\s+send/i,
    'the description must tell the model, in words, that this does not send',
  );
});

test('confirm_send advertises idempotency and a truthful failure mode', () => {
  const d = TOOLS.confirm_send.description;
  // Replay safety matters: an agent that retries on timeout must not double-send.
  assert.match(d, /idempotent/i, 'replaying a draftId must be documented as safe');
  // "never a false sent" is a product promise about error reporting.
  assert.match(d, /never a false/i);
});

test('every tool maps to a distinct daemon method', () => {
  const methods = entries.map(([, def]) => def.method);
  const dupes = methods.filter((m, i) => methods.indexOf(m) !== i);
  assert.deepEqual([...new Set(dupes)], [], `two tools share one method: ${dupes.join(', ')}`);
});
