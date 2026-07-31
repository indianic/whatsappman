#!/usr/bin/env node
/**
 * Render a terminal log to a PNG, faithfully — colours and all.
 *
 *   node smoke/log-to-png.mjs <log-file> <out.png> ["Title"]
 *
 * Why this exists: `screencapture` is the obvious way to photograph a Terminal
 * window, and on any recent macOS it needs **Screen Recording** permission. A
 * process that does not have it does not fail loudly — it writes a black image,
 * or nothing at all, which is a worse outcome than no screenshot because it
 * looks like the run itself broke.
 *
 * So this is the fallback that always works: take the text the run already
 * captured, convert its ANSI to HTML with the same converter the cast player
 * uses, and photograph THAT with headless Chrome — which we launch ourselves
 * and which needs no permission from anybody.
 *
 * It is not a photograph of the window; it is a faithful rendering of what the
 * window showed. For reviewing what happened, that is the same information —
 * and unlike a real screenshot it is deterministic, croppable, and works in CI
 * where there is no window to photograph at all.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ansiToHtml } from './ansi-html.mjs';
import { redact, leaks } from './redact.mjs';

const args = process.argv.slice(2).filter((a) => a !== '--redact');
const REDACT = process.argv.includes('--redact');
const [logFile, outFile, titleArg] = args;
if (!logFile || !outFile) {
  console.error('usage: node smoke/log-to-png.mjs <log-file> <out.png> ["Title"]');
  process.exit(2);
}
if (!existsSync(logFile)) {
  console.error(`no such log: ${logFile}`);
  process.exit(2);
}

const title = titleArg || 'whatsappman — command audit';
// Masked before it is rendered, so the raw values never reach the image.
const raw = redact(readFileSync(logFile, 'utf8'), REDACT);
if (REDACT) {
  const left = leaks(raw);
  if (left.length) {
    console.error(`redaction incomplete — still present: ${left.join(', ')}`);
    process.exit(1);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((p) => existsSync(p));
}

const chrome = findChrome();
if (!chrome) {
  console.error('No Chrome found. Set CHROME_PATH.');
  process.exit(2);
}

// A terminal-looking page. Fixed width in ch units so the column alignment the
// CLI works hard for survives into the image.
const html = `<!doctype html><meta charset=utf-8><title>${title}</title>
<style>
 body{margin:0;padding:28px;background:#0b141a;color:#e6edf3;
      font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
 h1{font:600 14px system-ui,sans-serif;margin:0 0 14px;color:#25D366}
 .win{background:#111b21;border:1px solid #223039;border-radius:12px;overflow:hidden}
 .bar{background:#1a252c;padding:9px 14px;display:flex;gap:7px;align-items:center;
      border-bottom:1px solid #223039}
 .dot{width:11px;height:11px;border-radius:50%}
 .name{margin-left:8px;font:11.5px system-ui,sans-serif;color:#8b98a5}
 pre{margin:0;padding:16px 18px;white-space:pre;overflow:visible}
</style>
<h1>${title}</h1>
<div class="win">
  <div class="bar">
    <span class="dot" style="background:#ff5f57"></span>
    <span class="dot" style="background:#febc2e"></span>
    <span class="dot" style="background:#28c840"></span>
    <span class="name">whatsappman</span>
  </div>
  <pre>${ansiToHtml(raw)}</pre>
</div>`;

const tmpHtml = path.join(path.dirname(outFile), '.log-render.html');
mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(tmpHtml, html);

const port = 9350 + (process.pid % 400);
const browser = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    `--user-data-dir=/tmp/wam-logshot-${process.pid}`,
    `--remote-debugging-port=${port}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

try {
  // Attach.
  let send, close;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.onopen = res;
          ws.onerror = rej;
        });
        let id = 0;
        const pending = new Map();
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m.result);
            pending.delete(m.id);
          }
        };
        send = (method, params = {}) =>
          new Promise((res) => {
            const i = ++id;
            pending.set(i, res);
            ws.send(JSON.stringify({ id: i, method, params }));
          });
        close = () => ws.close();
        break;
      }
    } catch {
      /* not ready */
    }
    if (Date.now() > deadline) throw new Error('could not attach to Chrome');
    await sleep(300);
  }

  await send('Page.enable');
  await send('Runtime.enable');
  // Wide enough that no CLI line wraps; height is corrected below.
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: `file://${path.resolve(tmpHtml)}` });
  await sleep(900);

  // Resize to the real content height so nothing is cropped and there is no
  // dead space under a short log.
  const metrics = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `({w: Math.ceil(document.documentElement.scrollWidth), h: Math.ceil(document.documentElement.scrollHeight)})`,
  });
  const { w, h } = metrics.result?.value ?? { w: 1100, h: 900 };
  await send('Emulation.setDeviceMetricsOverride', {
    width: Math.min(2200, Math.max(700, w)),
    height: Math.min(20000, Math.max(300, h)),
    deviceScaleFactor: 2,
    mobile: false,
  });
  await sleep(250);

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  if (!shot?.data) throw new Error('Chrome returned no image data');
  writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
  close();
  console.log(`${outFile}  (${Math.round(Buffer.from(shot.data, 'base64').length / 1024)}kB, ${w}x${h})`);
} finally {
  browser.kill();
}
