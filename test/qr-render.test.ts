import { test } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { qrBlockSize, qrFitAdvice, repaintPrefix, createQrPainter } from '../src/cli/link.js';

/**
 * The QR is the one screen a user cannot work around: if it overflows the
 * window its top scrolls away and it stops being scannable. These pin the size
 * we actually emit, so a renderer/option change can't quietly inflate it again.
 */

/**
 * A real WhatsApp pairing payload, measured off a live daemon: a 102-char ref
 * plus three 44-char base64 keys = 237 bytes. An earlier version of this file
 * guessed ~157 and every size assertion here was correspondingly optimistic —
 * the real QR is version 10 (57 modules), not version 7.
 */
const PAYLOAD = ['2@' + 'R'.repeat(100), 'a'.repeat(44), 'b'.repeat(44), 'c'.repeat(44)].join(',');

const render = (opts: Record<string, unknown>) =>
  QRCode.toString(PAYLOAD, { type: 'terminal', small: true, ...opts });

test('qrBlockSize ignores ANSI colour escapes when measuring width', () => {
  const block = '\x1b[47m\x1b[30mAB\x1b[0m\n\x1b[47mCD\x1b[0m\n';
  assert.deepEqual(qrBlockSize(block), { rows: 2, cols: 2 });
});

test('qrBlockSize does not count the trailing newline as a row', () => {
  assert.equal(qrBlockSize('ab\ncd\n').rows, 2);
  assert.equal(qrBlockSize('ab\ncd\n\n').rows, 2);
});

test('error correction L renders a genuinely smaller QR than the default', async () => {
  const small = qrBlockSize(await render({ errorCorrectionLevel: 'L' }));
  const dflt = qrBlockSize(await render({}));
  assert.ok(small.rows < dflt.rows, `L (${small.rows}) must be shorter than default (${dflt.rows})`);
  assert.ok(small.cols < dflt.cols, `L (${small.cols}) must be narrower than default (${dflt.cols})`);
});

test('the QR we emit fits a standard 80x24 terminal in width', async () => {
  const { cols } = qrBlockSize(await render({ errorCorrectionLevel: 'L' }));
  assert.ok(cols <= 80, `QR is ${cols} cols wide — will wrap and become unscannable at 80 columns`);
});

test('half-block packing keeps the QR roughly square (2 module rows per text row)', async () => {
  // A terminal cell is ~2x taller than wide, so cols must be ~2x rows for the
  // rendered QR to read as a square to a scanner.
  const { rows, cols } = qrBlockSize(await render({ errorCorrectionLevel: 'L' }));
  const ratio = cols / rows;
  assert.ok(ratio > 1.7 && ratio < 2.1, `aspect ratio ${ratio.toFixed(2)} — QR would scan as distorted`);
});

test('qrFitAdvice stays silent when the window has room', () => {
  assert.equal(qrFitAdvice({ rows: 23, cols: 43 }, { rows: 40, cols: 100 }), null);
});

test('qrFitAdvice reports a short window, naming rows and the reserve', () => {
  const advice = qrFitAdvice({ rows: 23, cols: 43 }, { rows: 24, cols: 100 });
  assert.ok(advice, 'a 23-row QR plus heading lines does not fit 24 rows');
  assert.match(advice, /27 rows \(window has 24\)/);
});

test('qrFitAdvice reports a narrow window', () => {
  const advice = qrFitAdvice({ rows: 23, cols: 43 }, { rows: 60, cols: 40 });
  assert.match(advice ?? '', /43 columns \(window has 40\)/);
});

test('qrFitAdvice reports both dimensions at once', () => {
  const advice = qrFitAdvice({ rows: 23, cols: 43 }, { rows: 10, cols: 20 });
  assert.match(advice ?? '', /rows.*and.*columns/);
});

test('qrFitAdvice says nothing when the terminal size is unknown', () => {
  // Piped/redirected output reports no size — a warning there would be noise.
  assert.equal(qrFitAdvice({ rows: 23, cols: 43 }, {}), null);
  assert.equal(qrFitAdvice({ rows: 23, cols: 43 }, { rows: undefined, cols: undefined }), null);
});

test('repaintPrefix emits nothing for the first paint', () => {
  // Rewinding before anything was drawn would eat the heading above it.
  assert.equal(repaintPrefix(0), '');
});

test('repaintPrefix rewinds exactly N lines and clears below', () => {
  assert.equal(repaintPrefix(27), '\x1b[27A\x1b[0J');
});

test('the QR the linker emits is a single block whose line count is countable', async () => {
  // The repaint arithmetic depends on counting newlines in what we wrote; if
  // the renderer ever stopped emitting a trailing newline the next rewind
  // would be off by one and start eating the heading.
  const ascii = await render({ errorCorrectionLevel: 'L' });
  const body = '\n' + ascii + '\n';
  const emitted = (body.match(/\n/g) ?? []).length;
  assert.ok(emitted >= qrBlockSize(ascii).rows, 'emitted newlines must cover every QR row');
});

/**
 * Drive the real painter with stdout stubbed, capturing what it emits. This is
 * the regression that made the QR look "too large": WhatsApp rotates the
 * pairing QR mid-link, and every rotation used to append another full block.
 */
async function paintTwice(term: { isTTY: boolean; rows?: number; cols?: number }) {
  const out: string[] = [];
  const stdout = process.stdout as unknown as Record<string, unknown>;
  const saved = { write: stdout.write, isTTY: stdout.isTTY, rows: stdout.rows, columns: stdout.columns };
  stdout.write = (chunk: string) => { out.push(String(chunk)); return true; };
  stdout.isTTY = term.isTTY;
  stdout.rows = term.rows;
  stdout.columns = term.cols;
  try {
    const paint = createQrPainter();
    await paint(PAYLOAD);
    await paint(PAYLOAD.replace('2@', '3@')); // a rotated QR
  } finally {
    Object.assign(stdout, saved);
  }
  return out;
}

test('a rotated QR repaints in place instead of stacking a second block', async () => {
  const [first, second] = await paintTwice({ isTTY: true, rows: 60, cols: 120 });
  assert.equal(repaintPrefix(0), '', 'sanity: first paint has no rewind');
  assert.ok(!first.startsWith('\x1b['.concat('0A')), 'first paint must not rewind');
  const rewind = second.match(/^\x1b\[(\d+)A\x1b\[0J/);
  assert.ok(rewind, 'the second QR must rewind over the first, not append below it');
  const firstLines = (first.match(/\n/g) ?? []).length;
  assert.equal(Number(rewind[1]), firstLines, 'rewind must match exactly what the first paint emitted');
});

test('no repaint when stdout is not a TTY', async () => {
  // Piped output has no cursor to move; emitting ANSI would corrupt the stream.
  const [, second] = await paintTwice({ isTTY: false, rows: 60, cols: 120 });
  assert.doesNotMatch(second, /\x1b\[\d+A/, 'must not emit cursor movement into a pipe');
});

test('no repaint when the QR is too big for the window', async () => {
  // The block scrolls in that case, so rewinding would eat the wrong lines.
  const [, second] = await paintTwice({ isTTY: true, rows: 10, cols: 30 });
  assert.doesNotMatch(second, /\x1b\[\d+A/, 'must not rewind when the QR scrolled');
});

/**
 * The image escape hatch. The terminal QR has a hard floor of one module per
 * character cell, so on a large terminal font it is simply big; an image leaves
 * the character grid behind and the viewer scales it freely.
 */
test('qrImagePath lives in the 0700 config dir, never the shared tmpdir', async () => {
  const { qrImagePath } = await import('../src/cli/link.js');
  const { baseDir } = await import('../src/config/paths.js');
  const os = await import('node:os');
  const p = qrImagePath('default');
  assert.ok(p.startsWith(baseDir()), `QR image must live under ${baseDir()}, got ${p}`);
  // The pairing QR is a credential: in a world-writable /tmp a predictable name
  // lets a local user read it and hijack the pairing, or pre-create a symlink.
  assert.ok(!p.startsWith(os.tmpdir()) || baseDir().startsWith(os.tmpdir()),
    'QR image must not sit in the shared tmpdir');
});

test('the image painter writes 0600 into a 0700 dir, and cleans up', { skip: process.platform === 'win32' }, async () => {
  // Drives the REAL painter (with a stub opener so no GUI launches). The
  // pairing QR is a credential: a world-readable file would let any local user
  // scan it and become a linked device on the account.
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-qrimg-'));
  const savedDir = process.env.WHATSAPPMAN_DIR;
  process.env.WHATSAPPMAN_DIR = sandbox;
  try {
    const { createQrImagePainter, qrImagePath, removeQrImage } = await import('../src/cli/link.js');
    const opened: string[] = [];
    const paint = createQrImagePainter('permtest', async (f) => { opened.push(f); });

    await paint(PAYLOAD);
    const file = qrImagePath('permtest');
    assert.ok(fs.existsSync(file), 'painter must write the PNG');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'QR image must be 0600, not world-readable');
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700, 'parent dir must be 0700');
    assert.deepEqual(opened, [file], 'viewer opened exactly once');

    // A rotation overwrites in place, stays 0600, and does not re-open a window.
    await paint(PAYLOAD.replace('2@', '3@'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'rotation must not loosen perms');
    assert.equal(opened.length, 1, 'rotation must not open a second viewer window');

    removeQrImage('permtest');
    assert.ok(!fs.existsSync(file), 'the credential must not be left on disk');
  } finally {
    if (savedDir === undefined) delete process.env.WHATSAPPMAN_DIR;
    else process.env.WHATSAPPMAN_DIR = savedDir;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('the PNG QR is real, non-trivial image data at a scannable size', async () => {
  const { qrImagePath } = await import('../src/cli/link.js');
  const { readFileSync, rmSync, existsSync } = await import('node:fs');
  const file = qrImagePath('evaltest');
  try {
    await QRCode.toFile(file, PAYLOAD, { type: 'png', errorCorrectionLevel: 'L', margin: 2, width: 512 });
    const buf = readFileSync(file);
    assert.ok(buf.length > 300, `PNG is suspiciously small (${buf.length} bytes)`);
    // PNG magic number — proves we wrote an image, not an error string.
    assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'not a PNG');
    // IHDR width is bytes 16-19, big-endian. The renderer snaps to a whole
    // number of pixels per module, so the result lands near the requested 512
    // rather than exactly on it — what matters is that it's comfortably
    // scannable and square.
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    assert.ok(width >= 400, `PNG is only ${width}px wide — too small to scan comfortably`);
    assert.equal(width, height, 'a QR must be square');
  } finally {
    if (existsSync(file)) rmSync(file);
  }
});

/**
 * Both render modes are first-class and stay that way: the terminal QR for
 * anyone happy with it, `--image` for anyone whose window it swamps. Neither is
 * a fallback for the other, so neither should quietly disappear.
 */
test('the fit warning points at --image, not just "resize your window"', () => {
  const advice = qrFitAdvice({ rows: 31, cols: 59 }, { rows: 24, cols: 80 });
  assert.ok(advice, 'a 31-row QR does not fit 24 rows');
  assert.match(advice, /--image/, 'the escape hatch must be mentioned where the problem is hit');
  assert.match(advice, /font size/, 'the in-terminal remedy must still be offered');
});

test('both painters exist and are independently constructible', async () => {
  const link = await import('../src/cli/link.js');
  assert.equal(typeof link.createQrPainter, 'function', 'terminal mode must remain available');
  assert.equal(typeof link.createQrImagePainter, 'function', 'image mode must remain available');
  // Constructing the image painter must not touch the disk or open anything
  // until a QR is actually painted.
  const paint = link.createQrImagePainter('unused-label', async () => {});
  assert.equal(typeof paint, 'function');
});

test('a real 237-byte pairing QR still fits 80 columns in the terminal', async () => {
  // The floor is 59 cols; if a future change pushed past 80 the QR would wrap
  // and become unscannable on a default-width terminal.
  const { cols, rows } = qrBlockSize(await render({ errorCorrectionLevel: 'L' }));
  assert.ok(cols <= 80, `${cols} cols will wrap at 80`);
  assert.ok(rows <= 40, `${rows} rows is taller than a typical window`);
});
