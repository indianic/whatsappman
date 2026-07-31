import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The privacy claim, enforced instead of asserted.
 *
 * Everything this product is sold on reduces to one promise: *your machine
 * only — no API, no server, no database.* It is also the reason it is
 * defensible to point an AI at someone's WhatsApp account at all. If message
 * content ever lands on disk in plaintext, the promise is broken retroactively
 * — for every message already sent, not just the next one.
 *
 * The send log is where that would happen. `src/audit.ts` says so in a comment:
 * *"metadata only (never message bodies or inbound content)"*. A comment stops
 * nobody. One `body: text` added to that interface while debugging, and every
 * message a user has ever sent is sitting in ~/.whatsappman/sent.jsonl forever,
 * with nothing failing and nothing to notice it.
 *
 * These evals make that edit fail.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const audit = read('src/audit.ts');

/** Field names that would carry user-authored content into a log line. */
const CONTENT_FIELDS = ['text', 'body', 'message', 'caption', 'content', 'payload', 'msg'];

/** The declared shape of one send-log line. */
const entryInterface = (() => {
  const m = audit.match(/export interface SentLogEntry \{([\s\S]*?)\n\}/);
  return m ? m[1] : '';
})();

test('the send-log entry shape parsed', () => {
  // Guard the guard: an unparsed interface would make the next test vacuous —
  // which on this particular eval means silently stopping enforcing privacy.
  assert.ok(entryInterface.length > 0, 'could not find SentLogEntry in src/audit.ts');
  assert.match(entryInterface, /messageId/, 'SentLogEntry no longer looks like a send-log entry');
});

test('the send log declares no field that could hold message content', () => {
  const declared = [...entryInterface.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
  const leaks = declared.filter((f) => CONTENT_FIELDS.includes(f.toLowerCase()));
  assert.deepEqual(
    leaks,
    [],
    `SentLogEntry gained content field(s): ${leaks.join(', ')} — this writes user message bodies to disk in plaintext`,
  );
});

test('no call site passes content into the send log', () => {
  // The interface is the contract, but an object literal with an extra property
  // is only a type error if the target type is closed at that position. Check
  // what is actually passed, too.
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.ts')) {
        const src = read(rel);
        for (const m of src.matchAll(/appendSent\(\{([\s\S]*?)\}\)/g)) {
          for (const p of [...m[1].matchAll(/^\s*(\w+):/gm)].map((x) => x[1])) {
            if (CONTENT_FIELDS.includes(p.toLowerCase())) offenders.push(`${rel}: ${p}`);
          }
        }
      }
    }
  };
  walk('src');
  assert.deepEqual(offenders, [], `appendSent called with message content: ${offenders.join(', ')}`);
});

test('the metadata-only promise is stated where the writer lives', () => {
  // The comment is not the enforcement — the tests above are. But it is what
  // tells the next person why the shape is deliberately awkward, and without it
  // someone "helpfully" adds the body back and only then hits a failing eval
  // with no explanation of the reasoning.
  assert.match(
    audit,
    /never message bodies/i,
    'src/audit.ts no longer states the metadata-only promise',
  );
});

test('the send log is written user-only', () => {
  // It records who was messaged and when. That is not content, but it is still
  // a contact graph, and on a shared machine 0o644 hands it to every account.
  assert.match(audit, /mode: 0o600/, 'the send log must be written with mode 0o600');
});

test('the send log cannot grow without bound', () => {
  // Unbounded metadata is still a slow leak: a log nobody rotates eventually
  // holds years of contact history, and is the file most likely to be swept up
  // by a backup tool or a support-bundle script.
  assert.match(audit, /MAX_LOG_BYTES/, 'the send log must have a size cap');
  assert.match(audit, /renameSync/, 'the send log must rotate rather than grow forever');
});

test('the documented security posture still claims metadata-only logging', () => {
  // docs/SECURITY.md is what a reviewer reads before allowing this on a work
  // machine. If the code stops being metadata-only, the doc must not keep
  // saying it is — and vice versa: dropping the claim silently would let the
  // behaviour drift without anyone re-reviewing it.
  const security = read('docs/SECURITY.md');
  assert.match(
    security,
    /metadata/i,
    'docs/SECURITY.md no longer describes what is logged — the claim reviewers rely on has gone',
  );
});

test('credentials are never rendered into user-facing output', () => {
  // The daemon token authenticates every IPC call. Printing it into a status
  // block, an error, or a support paste hands over full control of the session.
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.ts')) {
        const src = read(rel);
        // A render helper or a write that interpolates the token value itself.
        for (const m of src.matchAll(/(?:row|fact|fail|attention|stdout\.write)\([^)]*\$\{[^}]*\btoken\b[^}]*\}/g)) {
          if (!/tokenPath|TokenPath/.test(m[0])) offenders.push(`${rel}: ${m[0].slice(0, 60)}`);
        }
      }
    }
  };
  walk('src');
  assert.deepEqual(offenders, [], `daemon token interpolated into output: ${offenders.join(' | ')}`);
});
