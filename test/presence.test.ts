import { test } from 'node:test';
import assert from 'node:assert/strict';
import { METHODS, PRESENCE_TYPES, paramsSchemas } from '../src/ipc/protocol.ts';
import { PRESENCE_ALIASES } from '../src/cli/send.ts';

test('send_presence is an allowlisted method with a params schema', () => {
  assert.ok(METHODS.includes('send_presence'), 'send_presence missing from METHODS');
  assert.ok(paramsSchemas.send_presence, 'send_presence has no params schema');
});

test('the five canonical WhatsApp presence states are exposed', () => {
  assert.deepEqual(
    [...PRESENCE_TYPES].sort(),
    ['available', 'composing', 'paused', 'recording', 'unavailable'],
  );
});

test('send_presence params accept a recipient + a canonical presence', () => {
  const s = paramsSchemas.send_presence;
  assert.ok(s.safeParse({ to: '+919999900000', presence: 'composing' }).success);
  assert.ok(s.safeParse({ to: 'jid@s.whatsapp.net', presence: 'available', from: 'work' }).success);
});

test('send_presence params reject bad input', () => {
  const s = paramsSchemas.send_presence;
  // A CLI alias like "typing" is mapped to "composing" BEFORE the wire — the
  // protocol itself only accepts the canonical states, never the alias.
  assert.ok(!s.safeParse({ to: '123', presence: 'typing' }).success, 'alias must not reach the wire');
  assert.ok(!s.safeParse({ to: '123', presence: 'online' }).success, 'unknown presence rejected');
  assert.ok(!s.safeParse({ presence: 'composing' }).success, 'missing recipient rejected');
  assert.ok(!s.safeParse({ to: '', presence: 'composing' }).success, 'empty recipient rejected');
});

test('CLI aliases map friendly words to canonical presence states', () => {
  assert.equal(PRESENCE_ALIASES.typing, 'composing');
  assert.equal(PRESENCE_ALIASES.online, 'available');
  assert.equal(PRESENCE_ALIASES.offline, 'unavailable');
  assert.equal(PRESENCE_ALIASES.stop, 'paused');
  // Every alias target must be a real protocol presence state.
  for (const target of Object.values(PRESENCE_ALIASES)) {
    assert.ok((PRESENCE_TYPES as readonly string[]).includes(target), `alias target ${target} is not canonical`);
  }
});
