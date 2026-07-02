import { test } from 'node:test';
import assert from 'node:assert/strict';

const { shouldSuggestAdditionalNumber } = await import('../src/cli/link.ts');

test('bare `link` on a connected number offers the multi-number on-ramp', () => {
  // No explicit label + already connected → the user most likely wants another
  // number; guide them to a labelled link instead of dead-ending.
  assert.equal(shouldSuggestAdditionalNumber('link', false, 'connected'), true);
});

test('explicit `link <label>` on a connected number does not nudge', () => {
  // They named a specific number that is already up — just report it.
  assert.equal(shouldSuggestAdditionalNumber('link', true, 'connected'), false);
});

test('relink never shows the add-another-number hint', () => {
  assert.equal(shouldSuggestAdditionalNumber('relink', false, 'connected'), false);
  assert.equal(shouldSuggestAdditionalNumber('relink', true, 'connected'), false);
});

test('a not-yet-connected number never nudges (the QR flow runs instead)', () => {
  for (const status of ['qr_pending', 'connecting', 'needs_relink', 'disconnected']) {
    assert.equal(shouldSuggestAdditionalNumber('link', false, status), false);
  }
});
