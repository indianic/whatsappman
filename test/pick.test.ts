import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionChoiceLabel } from '../src/cli/pick.ts';
import type { SessionSummary } from '../src/status.ts';

const S = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  label: 'work',
  phone: '919925623349',
  status: 'connected',
  lastConnectedAt: null,
  isDefault: false,
  ...over,
});

/**
 * Selection itself is an arrow-key menu (@clack/prompts `select`), so there is
 * no typed-answer parsing left to unit-test — what remains is that each menu row
 * is readable and aligned, since that is all the user has to choose between.
 */
test('a menu row shows label, phone and status', () => {
  const rendered = sessionChoiceLabel(S());
  assert.match(rendered, /work/);
  assert.match(rendered, /919925623349/);
  assert.match(rendered, /connected/);
});

test('menu rows are column-aligned so the list scans vertically', () => {
  const a = sessionChoiceLabel(S({ label: 'work' }));
  const b = sessionChoiceLabel(S({ label: 'personal-long' }));
  assert.equal(a.indexOf('919925623349'), b.indexOf('919925623349'), 'phone column must line up');
});

test('a number with no resolved phone still renders a row', () => {
  // A session that is linked but not yet connected has no phone; it must remain
  // selectable (you may well be trying to delete or relink exactly that one).
  const rendered = sessionChoiceLabel(S({ phone: null, status: 'needs_relink' }));
  assert.match(rendered, /—/);
  assert.match(rendered, /needs_relink/);
});
