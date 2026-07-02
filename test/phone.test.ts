import { test } from 'node:test';
import assert from 'node:assert/strict';

const { normalizePhone } = await import('../src/daemon/contact-service.ts');

test('bare national number gets the default country code (India 91)', () => {
  assert.equal(normalizePhone('9925623349', '91'), '919925623349');
  assert.equal(normalizePhone('99256 23349', '91'), '919925623349'); // spaces
  assert.equal(normalizePhone('(992) 562-3349', '91'), '919925623349'); // punctuation
});

test('leading national trunk 0 is stripped, then country code applied', () => {
  assert.equal(normalizePhone('09925623349', '91'), '919925623349');
});

test('an explicit + country code is used as-is (not overridden by the default)', () => {
  assert.equal(normalizePhone('+14155551234', '91'), '14155551234'); // US
  assert.equal(normalizePhone('+44 7700 900123', '91'), '447700900123'); // UK
  assert.equal(normalizePhone('+919925623349', '91'), '919925623349');
});

test('a number already carrying a country code (no +) is left alone', () => {
  assert.equal(normalizePhone('919925623349', '91'), '919925623349');
});

test('the default country code is configurable, not hardcoded to India', () => {
  assert.equal(normalizePhone('4155551234', '1'), '14155551234'); // default US
  assert.equal(normalizePhone('7700900123', '44'), '447700900123'); // default UK
});
