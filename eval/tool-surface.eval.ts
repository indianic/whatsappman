import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../src/mcp/server.js';
import { METHODS } from '../src/ipc/protocol.js';

/**
 * Rubrics on the quality of the tool surface — the things that decide whether a
 * model calls the right tool with the right arguments. A schema can be valid
 * and still be unusable (undescribed params, silent extra-arg acceptance, two
 * tools that read identically), and nothing else in the suite would notice.
 */

const entries = Object.entries(TOOLS);

/** The agreed surface. Adding or removing a tool should be a deliberate edit here. */
const EXPECTED_TOOLS = [
  'get_status',
  'list_sessions',
  'health_check',
  'resolve_recipient',
  'list_groups',
  'draft_message',
  'confirm_send',
  'cancel_draft',
  'schedule_send',
  'list_scheduled',
  'cancel_scheduled',
  'list_recent',
];

test('the tool surface matches the agreed set (drift guard)', () => {
  assert.deepEqual(Object.keys(TOOLS).sort(), [...EXPECTED_TOOLS].sort());
});

test('every tool name is snake_case', () => {
  for (const [name] of entries) {
    assert.match(name, /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, `${name} is not snake_case`);
  }
});

test('every tool routes to a method the daemon actually implements', () => {
  const known = new Set<string>(METHODS);
  for (const [name, def] of entries) {
    assert.ok(known.has(def.method), `${name} -> "${def.method}" is not in the IPC allowlist`);
  }
});

test('every tool has a description with real substance', () => {
  for (const [name, def] of entries) {
    assert.ok(def.description.trim().length >= 40, `${name}'s description is too thin to disambiguate`);
    assert.doesNotMatch(def.description, /^TODO|TBD/i, `${name} has a placeholder description`);
  }
});

test('no two tools share a description', () => {
  // Identical text makes the choice a coin flip for the model.
  const seen = new Map<string, string>();
  for (const [name, def] of entries) {
    const key = def.description.trim().toLowerCase();
    const prior = seen.get(key);
    assert.equal(prior, undefined, `${name} and ${prior} have identical descriptions`);
    seen.set(key, name);
  }
});

test('every input schema is a closed object', () => {
  for (const [name, def] of entries) {
    const schema = def.inputSchema as Record<string, unknown>;
    assert.equal(schema.type, 'object', `${name} schema must be an object`);
    assert.equal(
      schema.additionalProperties,
      false,
      `${name} must reject unknown args — otherwise a hallucinated param is silently dropped`,
    );
    assert.ok(schema.properties && typeof schema.properties === 'object', `${name} needs a properties map`);
    assert.ok(Array.isArray(schema.required), `${name} needs a required array (use [] when nothing is required)`);
  }
});

test('every property carries a description', () => {
  // An undescribed param is where a model guesses — and guesses wrong.
  for (const [name, def] of entries) {
    const props = (def.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    for (const [prop, spec] of Object.entries(props)) {
      assert.ok(spec.description && spec.description.trim().length > 0, `${name}.${prop} has no description`);
    }
  }
});

test('every required field exists in properties', () => {
  for (const [name, def] of entries) {
    const schema = def.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    for (const req of schema.required) {
      assert.ok(req in schema.properties, `${name} requires "${req}" but never declares it`);
    }
  }
});

test('every property declares a usable type', () => {
  const allowed = new Set(['string', 'number', 'boolean', 'object', 'array']);
  for (const [name, def] of entries) {
    const props = (def.inputSchema as { properties: Record<string, { type?: string; enum?: unknown[] }> }).properties;
    for (const [prop, spec] of Object.entries(props)) {
      assert.ok(spec.type && allowed.has(spec.type), `${name}.${prop} has an unusable type: ${spec.type}`);
      if (spec.enum) {
        assert.ok(Array.isArray(spec.enum) && spec.enum.length > 0, `${name}.${prop} has an empty enum`);
      }
    }
  }
});

test('read-only tools require no arguments', () => {
  // If listing sessions demanded a param, a model would invent one.
  for (const name of ['get_status', 'list_sessions']) {
    const schema = TOOLS[name].inputSchema as { required: string[] };
    assert.deepEqual(schema.required, [], `${name} should be callable with no arguments`);
  }
});

test('id-taking tools name their id parameter after its producer', () => {
  // draftId comes from draft_message, scheduledId from schedule_send. Coherent
  // naming is what lets a model thread the value from one call to the next.
  assert.ok('draftId' in (TOOLS.confirm_send.inputSchema as { properties: object }).properties);
  assert.ok('draftId' in (TOOLS.cancel_draft.inputSchema as { properties: object }).properties);
  assert.ok('scheduledId' in (TOOLS.cancel_scheduled.inputSchema as { properties: object }).properties);
});
