import { test } from 'node:test';
import assert from 'node:assert/strict';
import { METHODS, DRAFT_KINDS, requestSchema, paramsSchemas } from '../src/ipc/protocol.ts';

test('every allowlisted method has a params schema (and no orphan schemas)', () => {
  // The daemon looks up paramsSchemas[method] for every request; a method in the
  // allowlist without a schema would crash or skip validation. Keep them in lockstep.
  for (const m of METHODS) {
    assert.ok(paramsSchemas[m], `method "${m}" is missing a params schema`);
  }
  const schemaKeys = Object.keys(paramsSchemas).sort();
  assert.deepEqual(schemaKeys, [...METHODS].sort(), 'paramsSchemas keys must match METHODS exactly');
});

test('requestSchema requires a non-empty id + token and a known method', () => {
  assert.ok(requestSchema.safeParse({ id: '1', token: 't', method: 'ping' }).success);
  assert.ok(!requestSchema.safeParse({ id: '1', method: 'ping' }).success, 'missing token rejected');
  assert.ok(!requestSchema.safeParse({ id: '', token: 't', method: 'ping' }).success, 'empty id rejected');
  assert.ok(!requestSchema.safeParse({ id: '1', token: 't', method: 'nope' }).success, 'unknown method rejected');
});

test('draft_message enforces the per-kind required fields', () => {
  const s = paramsSchemas.draft_message;
  // kind defaults to text
  const okText = s.safeParse({ to: '123', text: 'hi' });
  assert.ok(okText.success);
  assert.equal((okText as { data: { kind: string } }).data.kind, 'text');

  assert.ok(!s.safeParse({ to: '123', kind: 'text' }).success, 'text kind needs text');
  assert.ok(!s.safeParse({ to: '123', kind: 'image' }).success, 'image needs path');
  assert.ok(s.safeParse({ to: '123', kind: 'image', path: '/a.png' }).success);
  assert.ok(!s.safeParse({ to: '123', kind: 'location', latitude: 1 }).success, 'location needs both lat+lng');
  assert.ok(s.safeParse({ to: '123', kind: 'location', latitude: 1, longitude: 2 }).success);
  assert.ok(!s.safeParse({ to: '123', kind: 'contact', contactName: 'A' }).success, 'contact needs name+phone');
  assert.ok(s.safeParse({ to: '123', kind: 'contact', contactName: 'A', contactPhone: '1' }).success);
});

test('DRAFT_KINDS is the exact set draft_message accepts', () => {
  assert.deepEqual([...DRAFT_KINDS], ['text', 'image', 'document', 'location', 'contact']);
});

test('send_bulk requires a non-empty recipient list', () => {
  const s = paramsSchemas.send_bulk;
  assert.ok(!s.safeParse({ to: [], text: 'hi' }).success, 'empty to[] rejected');
  assert.ok(s.safeParse({ to: ['a', 'b'], text: 'hi' }).success);
  assert.ok(!s.safeParse({ to: ['a'], text: '' }).success, 'empty text rejected');
});

test('update_settings validates defaultCountryCode as 1-4 bare digits', () => {
  const s = paramsSchemas.update_settings;
  assert.ok(s.safeParse({ defaultCountryCode: '91' }).success);
  assert.ok(s.safeParse({ defaultCountryCode: '1' }).success);
  assert.ok(!s.safeParse({ defaultCountryCode: '+91' }).success, 'must be bare digits, no +');
  assert.ok(!s.safeParse({ defaultCountryCode: '12345' }).success, 'max 4 digits');
  assert.ok(!s.safeParse({ defaultCountryCode: '9a' }).success, 'digits only');
});

test('list_recent caps limit at 500 and accepts no params', () => {
  const s = paramsSchemas.list_recent;
  assert.ok(s.safeParse(undefined).success);
  assert.ok(s.safeParse({ limit: 500 }).success);
  assert.ok(!s.safeParse({ limit: 501 }).success, 'over the cap rejected');
  assert.ok(!s.safeParse({ limit: 0 }).success, 'must be positive');
});
