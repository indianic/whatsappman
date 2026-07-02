import { test } from 'node:test';
import assert from 'node:assert/strict';

const { toWhatsAppMarkup } = await import('../src/daemon/markup.ts');

test('Markdown bold **x** / __x__ → WhatsApp *x*', () => {
  assert.equal(toWhatsAppMarkup('a **bold** b'), 'a *bold* b');
  assert.equal(toWhatsAppMarkup('a __bold__ b'), 'a *bold* b');
});

test('strikethrough ~~x~~ → ~x~', () => {
  assert.equal(toWhatsAppMarkup('~~gone~~'), '~gone~');
});

test('Markdown link → text (url)', () => {
  assert.equal(
    toWhatsAppMarkup('see [the docs](https://example.com/x)'),
    'see the docs (https://example.com/x)',
  );
});

test('headings become a bold line', () => {
  assert.equal(toWhatsAppMarkup('# Title'), '*Title*');
  assert.equal(toWhatsAppMarkup('### Sub'), '*Sub*');
});

test('WhatsApp-native markup is left untouched', () => {
  assert.equal(toWhatsAppMarkup('*bold* _italic_ ~strike~'), '*bold* _italic_ ~strike~');
  assert.equal(toWhatsAppMarkup('`code` and ```block```'), '`code` and ```block```');
});

test('lists and quotes pass through (WhatsApp renders them)', () => {
  const src = '- one\n- two\n1. first\n> quoted';
  assert.equal(toWhatsAppMarkup(src), src);
});

test('newlines are preserved', () => {
  assert.equal(toWhatsAppMarkup('line1\nline2'), 'line1\nline2');
});

test('fenced code language hint is dropped', () => {
  assert.equal(toWhatsAppMarkup('```js\nx=1\n```'), '```\nx=1\n```');
});

test('a realistic Markdown block converts cleanly', () => {
  const md = '# Report\n\n**Status:** all *green*\n- 55 tests\n- [repo](https://x.io/r)';
  const out = toWhatsAppMarkup(md);
  assert.equal(
    out,
    '*Report*\n\n*Status:* all *green*\n- 55 tests\n- repo (https://x.io/r)',
  );
});
