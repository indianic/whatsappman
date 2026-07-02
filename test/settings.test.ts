import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerceSettingValue, SETTABLE } from '../src/cli/settings.ts';

test('bool keys accept true/1/yes/on (any case), everything else is false', () => {
  for (const truthy of ['true', 'TRUE', '1', 'yes', 'on', 'On']) {
    assert.deepEqual(coerceSettingValue('alwaysConfirm', truthy), { ok: true, value: true });
  }
  for (const falsy of ['false', '0', 'no', 'off', 'nonsense', '']) {
    assert.deepEqual(coerceSettingValue('notifications', falsy), { ok: true, value: false });
  }
});

test('defaultCountryCode strips a leading + and requires 1-4 digits', () => {
  assert.deepEqual(coerceSettingValue('defaultCountryCode', '91'), { ok: true, value: '91' });
  assert.deepEqual(coerceSettingValue('defaultCountryCode', '+91'), { ok: true, value: '91' });
  assert.deepEqual(coerceSettingValue('defaultCountryCode', '1'), { ok: true, value: '1' });

  for (const bad of ['12345', '', '9a', '+', 'abc']) {
    const r = coerceSettingValue('defaultCountryCode', bad);
    assert.equal(r.ok, false, `"${bad}" should be rejected`);
  }
});

test('numeric keys parse a finite number, else error', () => {
  assert.deepEqual(coerceSettingValue('defaultDelayMs', '250'), { ok: true, value: 250 });
  assert.deepEqual(coerceSettingValue('draftTtlMinutes', '10'), { ok: true, value: 10 });

  for (const bad of ['abc', '', '  ', 'NaN', 'ten']) {
    assert.equal(coerceSettingValue('maxBulkRecipients', bad).ok, false, `"${bad}" should be rejected`);
  }
});

test('SETTABLE lists exactly the numeric + bool + string keys', () => {
  assert.deepEqual(
    [...SETTABLE].sort(),
    ['alwaysConfirm', 'defaultCountryCode', 'defaultDelayMs', 'draftTtlMinutes', 'maxBulkRecipients', 'notifications'].sort(),
  );
});
