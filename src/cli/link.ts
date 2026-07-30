import QRCode from 'qrcode';
import open from 'open';
import { join } from 'node:path';
import { openSync, writeFileSync, closeSync, chmodSync, rmSync } from 'node:fs';
import { baseDir, ensureBaseDir } from '../config/paths.js';
import { intro, outro, section, fact, row, attention, fail } from './tree.js';
import { request } from '../ipc/client.js';
import { startDaemon } from './daemon-control.js';
import { isDaemonAlive } from '../daemon/lock.js';
import { normalizeLabel } from '../config/sessions.js';
import { requireTty } from './interactive.js';
import { pickSession } from './pick.js';
import { WhatsAppManError } from '../errors.js';

interface LinkState {
  label: string;
  status: string;
  qr: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 90; // ~3 minutes

/**
 * A terminal QR has a hard floor: one module per character cell. The module
 * count is fixed by the payload, so the only lever on size is the error
 * correction level — 'L' (7% recovery) yields the fewest modules, which makes
 * each module *bigger* on screen and easier to scan, not harder.
 *
 * Measured against a real WhatsApp pairing QR (237 bytes: a 102-char ref plus
 * three 44-char base64 keys): 'L' gives QR version 10, 57 modules, 31 rows x 59
 * cols — against version 11, 61 modules, 33 x 63 at the default 'M'. Base64 has
 * lowercase, so the payload can only use byte mode (8 bits/char); version 10 is
 * the smallest that holds 237 bytes at 'L', which makes 31 x 59 the arithmetic
 * floor for a terminal QR here. `--image` is the only way past it.
 *
 * `margin` is not a lever: the small renderer hardcodes a 1-module quiet zone
 * and ignores the option entirely.
 *
 * `small: true` is what keeps the aspect ratio right — it packs two module rows
 * into one text row using half-blocks (▀▄), and since a terminal cell is about
 * twice as tall as it is wide, the result reads as square to a scanner. Packing
 * horizontally too (quadrant blocks) would halve the width and render a
 * distorted, unscannable rectangle.
 */
const QR_ERROR_CORRECTION = 'L';

/**
 * How many modules of white quiet zone to draw around the code. The QR standard
 * calls for 4; `qrcode`'s built-in small terminal renderer hardcodes just 1 and
 * ignores its `margin` option — and a one-module border is a well-known reason a
 * phone camera fails to lock on, since surrounding terminal text sits right
 * against the finder patterns. We render our own half-blocks (below) so we can
 * give it a real quiet zone. 2 keeps the block ≤ 80 columns and the same height
 * as before while doubling the border; the dark terminal beyond the white zone
 * adds even more contrast for the scanner.
 */
const QR_QUIET_ZONE = 2;

/**
 * Render a QR as compact terminal text, two module rows packed into each text
 * row, forced black-on-white with a real quiet zone. Exported for tests.
 *
 * Every cell is a single upper-half block `▀`: its FOREGROUND colour paints the
 * top module, its BACKGROUND colour the bottom module. This one-glyph + fg/bg
 * scheme (what image viewers like chafa use) beats mixing ▀▄█/space: a solid
 * black run is drawn by the cell BACKGROUND, which the terminal fills edge to
 * edge — including the line leading — so stacked rows stay seamless.
 *
 * Colours are the 256-palette's PURE black (16 = #000000) and white (231 =
 * #ffffff), never the 16-colour codes (30/37/40/47) — those resolve to the
 * terminal *theme's* black/white, which on a dark theme is a low-contrast
 * grey-on-grey that a phone camera has to strain to threshold (why the terminal
 * QR scanned slowly while the pure-black-on-white PNG scanned instantly). 256
 * colour is near-universal, including Terminal.app, which lacks truecolor.
 *
 * `margin` on the library renderer is a no-op in small mode, so we draw our own
 * quiet zone — the QR standard wants ~4 modules; the library gives only 1.
 */
const FG_DARK = '38;5;16'; // pure-black foreground   (top module dark)
const FG_LIGHT = '38;5;231'; // pure-white foreground  (top module light)
const BG_DARK = '48;5;16'; // pure-black background   (bottom module dark)
const BG_LIGHT = '48;5;231'; // pure-white background  (bottom module light)

export function renderTerminalQr(text: string, quietZone = QR_QUIET_ZONE): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: QR_ERROR_CORRECTION });
  const size = qr.modules.size;
  const data = qr.modules.data;
  // Any coordinate outside the module grid is quiet zone → light (never dark).
  const dark = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < size && y < size && !!data[y * size + x];

  const RESET = '\x1b[0m';
  const lo = -quietZone;
  const hi = size + quietZone;

  const lines: string[] = [];
  for (let y = lo; y < hi; y += 2) {
    let line = '';
    for (let x = lo; x < hi; x++) {
      const fg = dark(x, y) ? FG_DARK : FG_LIGHT; // top module → foreground
      const bg = dark(x, y + 1) ? BG_DARK : BG_LIGHT; // bottom module → background
      line += `\x1b[${fg};${bg}m▀`;
    }
    lines.push(line + RESET);
  }
  return lines.join('\n') + '\n';
}

/** Rendered size of a terminal QR block, ANSI escapes excluded. Pure, for tests. */
export function qrBlockSize(ascii: string): { rows: number; cols: number } {
  const lines = ascii.replace(/\n+$/, '').split('\n');
  const width = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
  return { rows: lines.length, cols: Math.max(0, ...lines.map(width)) };
}

/**
 * Advice when the QR can't fit the window, or null when it does. A QR that
 * overflows scrolls its own top off the screen and cannot be scanned, so it's
 * far better to say why than to print a broken one. `reserve` accounts for the
 * heading + prompt lines printed around it.
 */
export function qrFitAdvice(
  block: { rows: number; cols: number },
  term: { rows?: number; cols?: number },
  reserve = 4,
): string | null {
  const needRows = block.rows + reserve;
  const short: string[] = [];
  if (term.rows && term.rows < needRows) short.push(`${needRows} rows (window has ${term.rows})`);
  if (term.cols && term.cols < block.cols) short.push(`${block.cols} columns (window has ${term.cols})`);
  if (!short.length) return null;
  return `the QR needs ${short.join(' and ')} — enlarge the window, reduce the font size, or re-run with --image to open it in an image viewer instead`;
}

/**
 * ANSI to rewind over a previously painted block: move the cursor up N lines,
 * then clear to the end of the screen. Empty on the first paint. Pure, for tests.
 */
export function repaintPrefix(previousLines: number): string {
  return previousLines > 0 ? `\x1b[${previousLines}A\x1b[0J` : '';
}

/**
 * Where the `--image` QR is written: inside the 0700 config dir, NOT the shared
 * tmpdir.
 *
 * The pairing QR is a credential — whoever scans it first becomes a linked
 * device on the account. In `os.tmpdir()` (a world-writable `/tmp` on Linux)
 * a predictable name lets any local user read it and hijack the pairing, or
 * pre-create the path as a symlink to redirect the write. Keeping it under
 * `~/.whatsappman` (0700, already enforced by ensureBaseDir) closes both, and
 * matches how every other secret here is stored — see config/store.ts.
 *
 * Stable per label so each rotation overwrites it and the open viewer refreshes
 * in place rather than stacking a window per rotation.
 */
export function qrImagePath(label: string): string {
  return join(baseDir(), `qr-${label}.png`);
}

/** Best-effort removal of the QR image; the QR is a credential, so don't leave it lying around. */
export function removeQrImage(label: string): void {
  try {
    rmSync(qrImagePath(label), { force: true });
  } catch {
    // best-effort: a leftover file is not worth failing the link over
  }
}

/**
 * Render the QR as a PNG and open it in the OS image viewer.
 *
 * The terminal QR has a hard floor — one module per character cell — so on a
 * large terminal font it is simply big, and no rendering trick shrinks it
 * further without destroying the aspect ratio a scanner needs. An image escapes
 * the character grid entirely: the viewer scales it to whatever size suits, and
 * it stays crisp because it's real pixels rather than half-block glyphs.
 *
 * Written through an explicit 0600 fd rather than QRCode.toFile, which uses a
 * bare createWriteStream and would land at 0644 (world-readable).
 */
export function createQrImagePainter(
  label: string,
  // Injectable so tests can exercise the real write path without launching a
  // GUI image viewer.
  opener: (file: string) => Promise<unknown> = open,
): (qr: string) => Promise<void> {
  const file = qrImagePath(label);
  let opened = false;

  return async function paintQrImage(qr: string): Promise<void> {
    const png = await QRCode.toBuffer(qr, {
      type: 'png',
      errorCorrectionLevel: QR_ERROR_CORRECTION,
      margin: 2,
      width: 512,
    });

    ensureBaseDir(); // guarantees the 0700 parent before anything is written
    const fd = openSync(file, 'w', 0o600);
    try {
      writeFileSync(fd, png);
    } finally {
      closeSync(fd);
    }
    // `mode` on open only applies when the file is created; re-assert it so a
    // pre-existing file from an older build can't stay world-readable.
    try {
      chmodSync(file, 0o600);
    } catch {
      // best-effort on platforms without POSIX perms (Windows)
    }

    if (!opened) {
      opened = true;
      row(`QR written to ${file} — opening it now; it refreshes in place as the code rotates`);
      try {
        await opener(file);
      } catch {
        attention(`couldn't open the image automatically — open it yourself: ${file}`);
      }
    }
  };
}

/**
 * Paints the QR, replacing the previous one in place.
 *
 * WhatsApp rotates the pairing QR every ~20s and the link loop polls for ~3
 * minutes, so a fresh QR arrives several times per attempt. Appending each one
 * stacked half a dozen 25-row blocks down the terminal and pushed the live one
 * off-screen — the QR looked enormous because there were several of them.
 *
 * Repainting is skipped when output isn't a TTY (nothing to rewind) and when
 * the QR doesn't fit the window, since the block scrolls in that case and the
 * cursor arithmetic would eat the wrong lines.
 */

export function createQrPainter(): (qr: string) => Promise<void> {
  let previousLines = 0;
  let warned = false;

  return async function paintQr(qr: string): Promise<void> {
    // Our own renderer (not QRCode.toString) so the code gets a real quiet zone;
    // the library's small terminal renderer only draws a 1-module border.
    const ascii = renderTerminalQr(qr);

    const advice = qrFitAdvice(qrBlockSize(ascii), {
      rows: process.stdout.rows,
      cols: process.stdout.columns,
    });
    if (advice && !warned) {
      attention(advice);
      warned = true;
    }

    const canRepaint = Boolean(process.stdout.isTTY) && !advice;
    const body = '\n' + ascii + '\n';
    process.stdout.write((canRepaint ? repaintPrefix(previousLines) : '') + body);
    // Count what we actually emitted, so the next rewind is exact.
    previousLines = canRepaint ? (body.match(/\n/g) ?? []).length : 0;
  };
}

/**
 * Decide whether an already-connected `link` should nudge the user toward
 * linking an ADDITIONAL number. True only for a bare `whatsappman link` (no
 * explicit label) that lands on a live number — the classic "I wanted to add a
 * second number but didn't know it needs its own label" case. An explicit
 * `link <label>` or a `relink` just reports the connected state as-is.
 * Pure + exported so the multi-number on-ramp is unit-testable without IPC.
 */
export function shouldSuggestAdditionalNumber(
  method: 'link' | 'relink',
  explicit: boolean,
  status: string,
): boolean {
  return method === 'link' && !explicit && status === 'connected';
}

/**
 * Link a WhatsApp number. Starts the daemon if needed, asks it to begin
 * pairing, renders the QR in the terminal, and polls until the number connects.
 * The actual QR scan is done by the user on their phone.
 */
export async function runLink(rawLabel: string | undefined, asImage = false): Promise<number> {
  // `explicit` distinguishes `link work` / `link --label work` (the user wants a
  // specific number) from a bare `link` (defaults to "default"). It changes what
  // we show when the target is already connected: an explicit label just reports
  // "already connected", but a bare `link` on a live default means the user most
  // likely wants to ADD another number — so we guide them to a labelled link.
  const explicit = rawLabel != null && rawLabel.trim() !== '';
  return linkFlow(normalizeLabel(rawLabel ?? 'default'), 'link', explicit, asImage);
}

/** Re-pair an expired/logged-out number with a fresh QR (keeps history). Picks
 *  the number from the list when no label is given — handy for the common
 *  "which one says NEEDS_RELINK?" case. */
export async function runRelink(rawLabel: string | undefined, asImage = false): Promise<number> {
  if (!rawLabel) {
    if (!requireTty('whatsappman relink')) return 1;
    intro('whatsappman — relink');
    const picked = await pickSession('relink');
    if (!picked) {
      outro('relink');
      return 1;
    }
    // Reuse the intro we just printed for the picker.
    return linkFlow(normalizeLabel(picked), 'relink', true, asImage, true);
  }
  return linkFlow(normalizeLabel(rawLabel), 'relink', true, asImage);
}

async function linkFlow(
  label: string,
  method: 'link' | 'relink',
  explicit: boolean,
  asImage = false,
  alreadyIntroed = false,
): Promise<number> {
  // Pairing renders a QR to scan — pointless (and would hang polling) without a
  // real terminal, so refuse early in an AI-tool shell / pipe.
  if (!requireTty(`whatsappman ${method}`)) return 1;

  if (!alreadyIntroed) intro(`whatsappman — ${method} "${label}"`);

  if (!isDaemonAlive()) {
    row('starting daemon…');
    const ok = await startDaemon();
    if (!ok) {
      fail('could not start the daemon — see ~/.whatsappman/logs/daemon.err.log');
      outro(method);
      return 1;
    }
  }

  let state: LinkState;
  try {
    state = await request<LinkState>(method, { label });
  } catch (err) {
    return failWith(err, method);
  }

  if (state.status === 'connected') {
    section('done');
    fact(`"${label}" is already connected`, true);
    // A bare `whatsappman link` (no label) that lands on an already-connected
    // number almost always means the user wanted to add ANOTHER number but did
    // not realise each one needs its own label. Point the way instead of
    // dead-ending — this is the multi-number on-ramp.
    if (shouldSuggestAdditionalNumber(method, explicit, state.status)) {
      row('');
      row('to link an ADDITIONAL number, give it its own label:');
      row('  whatsappman link --label <name>     (e.g. --label work)');
      row('then pick which one Claude sends from by default:');
      row('  whatsappman default <name>');
      row('see all linked numbers with:  whatsappman numbers');
    }
    outro(method);
    return 0;
  }

  section('scan this QR in WhatsApp → Settings → Linked Devices → Link a Device');
  // A pairing QR is 57 modules, so in the terminal it is unavoidably ~31x59
  // characters — big on any large font. Mention the alternative once, up here
  // where the in-place repaint below won't erase it. Both modes are equally
  // supported; which one suits the window is the user's call.
  if (!asImage) {
    const retry = method === 'relink' ? `whatsappman relink ${label} --image` : 'whatsappman link --image';
    row(`too big for your window? run: ${retry}`);
  }

  let lastQr: string | null = null;
  const paintQr = asImage ? createQrImagePainter(label) : createQrPainter();

  // The QR image is a live credential on disk — remove it however this ends.
  // `finally` covers the normal exits (linked, timed out, daemon error) but NOT
  // a signal, and Ctrl-C mid-scan is the likeliest exit of all, so SIGINT gets
  // its own handler. 130 is the conventional "terminated by SIGINT" status.
  const onInterrupt = () => {
    removeQrImage(label);
    process.exit(130);
  };
  if (asImage) process.once('SIGINT', onInterrupt);

  try {
    for (let i = 0; i < MAX_POLLS; i++) {
      if (state.qr && state.qr !== lastQr) {
        lastQr = state.qr;
        await paintQr(state.qr);
      }

      if (state.status === 'connected') {
        section('done');
        fact(`"${label}" linked and connected`, true);
        outro(method);
        return 0;
      }

      await sleep(POLL_INTERVAL_MS);
      try {
        state = await request<LinkState>('link_status', { label });
      } catch (err) {
        return failWith(err, method);
      }
    }

    attention(`timed out waiting for the QR to be scanned — run ${method} again to retry`);
    outro(method);
    return 1;
  } finally {
    if (asImage) {
      process.off('SIGINT', onInterrupt);
      removeQrImage(label);
    }
  }
}

function failWith(err: unknown, method: string): number {
  if (err instanceof WhatsAppManError) {
    fail(`${err.code}: ${err.message}`);
    for (const step of err.nextSteps ?? []) row(step);
  } else {
    fail(String((err as Error)?.message ?? err));
  }
  outro(method);
  return 1;
}
