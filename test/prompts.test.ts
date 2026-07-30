import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CANCEL_HINT } from '../src/cli/prompts.ts';
import { settingChoices, isBoolSetting, SETTABLE } from '../src/cli/settings.ts';
import { scheduledChoiceLabel } from '../src/cli/index.ts';
import type { Settings } from '../src/config/schema.ts';

const SETTINGS: Settings = {
  schemaVersion: 1,
  draftTtlMinutes: 15,
  defaultDelayMs: 2000,
  maxBulkRecipients: 100,
  alwaysConfirm: true,
  notifications: false,
  defaultCountryCode: '91',
};

test('every prompt advertises the way out', () => {
  // "How do I exit this?" should be answerable from the screen, not by
  // killing the terminal.
  assert.match(CANCEL_HINT, /esc/i);
});

test('the settings picker offers every settable key, and only those', () => {
  const choices = settingChoices(SETTINGS);
  assert.deepEqual(choices.map((c) => c.value).sort(), [...SETTABLE].sort());
});

test('each settings row shows its CURRENT value and what the key does', () => {
  // Nobody remembers what `defaultDelayMs` is set to, which is exactly why the
  // old "usage: settings set <key> <value>" dead end was unhelpful.
  const byKey = Object.fromEntries(settingChoices(SETTINGS).map((c) => [c.value, c]));
  assert.match(byKey.defaultDelayMs.label, /2000/, 'current value is shown');
  assert.match(byKey.defaultDelayMs.hint, /bulk/i, 'the hint explains the key');
  assert.match(byKey.notifications.label, /false/, 'booleans show their state too');
});

test('bool settings are recognised so they get a true/false menu, not free text', () => {
  assert.equal(isBoolSetting('notifications'), true);
  assert.equal(isBoolSetting('alwaysConfirm'), true);
  assert.equal(isBoolSetting('defaultDelayMs'), false);
  assert.equal(isBoolSetting('defaultCountryCode'), false);
});

test('a scheduled send reads as when → who (what), never a raw UUID', () => {
  // The id is a UUID nobody types from memory; the menu row has to carry the
  // information you actually choose on.
  const label = scheduledChoiceLabel({
    scheduledId: '8f14e45f-ceea-467a-9f1a-1a1a1a1a1a1a',
    from: 'work',
    toName: 'Rajesh',
    kind: 'text',
    fireAt: '2026-07-31T09:00:00+05:30',
    status: 'pending',
  });
  assert.match(label, /2026-07-31T09:00/);
  assert.match(label, /Rajesh/);
  assert.match(label, /text/);
  assert.ok(!label.includes('8f14e45f'), 'the UUID is the value, not the label');
});
