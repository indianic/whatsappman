import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ErrorCode } from '../src/errors.js';

/**
 * Error-message quality.
 *
 * A whole day of debugging traced back to errors that were *correct* but told
 * you nothing to do: `BAD_REQUEST: malformed request` when a daemon predated
 * the CLI, "tag MISSING" after a tag was pushed, "NOT in sync" right after a
 * successful publish. Each sent someone hunting for a bug that wasn't there.
 *
 * These evals pin the property that mattered: when a failure has a known fix,
 * the error carries it.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** All source, as [relative path, contents]. */
function sources(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.ts')) out.push([rel, readFileSync(path.join(ROOT, rel), 'utf8')]);
    }
  };
  walk('src');
  return out;
}

/**
 * Codes that mean "you must do something" — the user cannot proceed until they
 * act. Every throw of these has to say what the action is. Codes NOT listed
 * here are either internal, or self-explanatory from the message alone.
 */
const ACTIONABLE = [
  ErrorCode.DAEMON_DOWN,
  ErrorCode.NEEDS_RELINK,
  ErrorCode.SESSION_NOT_FOUND,
  ErrorCode.NO_DEFAULT_SESSION,
  ErrorCode.UNKNOWN_METHOD,
] as const;

/** Every `new WhatsAppManError(...)` call, with the argument list it was given. */
function throwSites(): Array<{ file: string; code: string; args: string }> {
  const sites: Array<{ file: string; code: string; args: string }> = [];
  for (const [file, src] of sources()) {
    // Balance parens crudely but adequately: capture up to the closing `);` at
    // the start of a line, which is how this codebase formats these.
    const re = /new WhatsAppManError\(\s*ErrorCode\.([A-Z_]+)([\s\S]*?)\n\s*\)/g;
    for (const m of src.matchAll(re)) sites.push({ file, code: m[1], args: m[2] });
    // Single-line form.
    const re2 = /new WhatsAppManError\(ErrorCode\.([A-Z_]+),([^;]*?)\);/g;
    for (const m of src.matchAll(re2)) sites.push({ file, code: m[1], args: m[2] });
  }
  return sites;
}

test('the source parsed into a plausible set of error sites', () => {
  const sites = throwSites();
  assert.ok(sites.length >= 15, `only parsed ${sites.length} WhatsAppManError constructions`);
});

test('every actionable failure tells you what to do', () => {
  // `next_steps` is the third constructor argument. Without it the CLI prints
  // the code and message and stops — which is exactly the experience that made
  // "malformed request" cost an hour.
  const sites = throwSites();
  const bare: string[] = [];
  for (const s of sites) {
    if (!(ACTIONABLE as readonly string[]).includes(s.code)) continue;
    // A third argument is present if the args contain a bracketed list or a
    // variable passed after the message.
    const hasNextSteps = /\[[\s\S]*\]/.test(s.args) || /,\s*[a-zA-Z_][\w.]*\s*$/.test(s.args.trim());
    if (!hasNextSteps) bare.push(`${s.file} — ${s.code}`);
  }
  assert.deepEqual(bare, [], `actionable errors thrown with no next_steps: ${bare.join(' | ')}`);
});

test('the daemon names version skew instead of reporting a generic bad request', () => {
  // The specific regression: `method` is a z.enum, so an unknown method fails
  // schema validation BEFORE the handler lookup that would have raised
  // UNKNOWN_METHOD — surfacing to the user as a bare "malformed request" while
  // renaming a number. Both halves of the fix are pinned here.
  const server = readFileSync(path.join(ROOT, 'src/ipc/server.ts'), 'utf8');
  assert.match(server, /UNKNOWN_METHOD/, 'the daemon must be able to report UNKNOWN_METHOD');
  assert.match(server, /older build/i, 'the message must name the CLI/daemon build mismatch');
  assert.match(server, /whatsappman restart/, 'and must say how to fix it');

  const client = readFileSync(path.join(ROOT, 'src/ipc/client.ts'), 'utf8');
  assert.match(
    client,
    /malformed request/,
    'the client must also handle the bare message an ALREADY-RUNNING older daemon returns',
  );
  assert.match(client, /whatsappman restart/, 'and attach the same remedy');
});

test('no user-facing error message ends in a bare code with no sentence', () => {
  // Guards against `throw new WhatsAppManError(ErrorCode.X, 'X')` — technically
  // an error, practically a shrug.
  const bad: string[] = [];
  for (const s of throwSites()) {
    const msg = s.args.match(/['"`]([^'"`]{0,80})['"`]/)?.[1] ?? '';
    if (msg && msg === s.code) bad.push(`${s.file} — ${s.code}`);
    if (msg && msg.length > 0 && msg.length < 8) bad.push(`${s.file} — ${s.code}: "${msg}"`);
  }
  assert.deepEqual(bad, [], `messages that say nothing beyond the code: ${bad.join(' | ')}`);
});
