/**
 * Masking a terminal recording so it can be shared.
 *
 * Shared by the cast recorder and the log-to-image renderer. It lives in one
 * place deliberately: this is the code that decides whether a real phone number
 * ends up in a README, and two copies of it would drift.
 *
 * Everything here is LENGTH-PRESERVING, because the artefacts it protects exist
 * to show a column-aligned layout:
 *
 *     |  kalpesh      919925623349       connected      default
 *     |  demo         91XXXXXXXX49       connected      default
 *
 * A "[redacted]" of the wrong width shifts every column after it and produces a
 * recording of a layout bug that does not exist.
 */
import os from 'node:os';

const USERNAME = os.userInfo().username;

/** Replace `token` with `replacement`, keeping the column width it occupied. */
function maskToken(text, token, replacement) {
  if (!token || token === replacement) return text;
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const delta = token.length - replacement.length;
  // Two or more trailing spaces means a padded column, and the width has to be
  // held. ONE space is just a word separator — `kalpesh — connected` — and
  // padding it would print `demo    — connected`, inventing whitespace that was
  // never in the layout.
  const column = new RegExp(`${esc}( {2,})`, 'g');
  text = text.replace(column, (_m, sp) => replacement + ' '.repeat(Math.max(1, sp.length + delta)));
  // Anywhere else (a path, mid-sentence, end of line): a plain swap.
  return text.split(token).join(replacement);
}

/** Keep the first two and last two digits; mask the rest, same length. */
function maskDigits(d) {
  return d.length <= 4 ? 'X'.repeat(d.length) : d.slice(0, 2) + 'X'.repeat(d.length - 4) + d.slice(-2);
}

export function redact(text, enabled = true) {
  if (!enabled) return text;
  let out = text;

  // Phone numbers and the JIDs built from them. Bounded at 9+ digits so PIDs
  // (5) and the digit groups inside an ISO timestamp are left alone — a
  // timestamp is what makes `recent` legible, and it identifies nobody.
  out = out.replace(/\b\d{9,15}\b/g, (d) => maskDigits(d));

  // The OS username, which appears on its own as the session label, inside the
  // hostname (kalpesh.local), and inside the config path (/Users/kalpesh).
  out = maskToken(out, USERNAME, 'demo');

  // Any remaining home path, in case the daemon runs as a different user.
  out = out.replace(/\/(?:Users|home)\/[A-Za-z0-9._-]+/g, (m) =>
    m.slice(0, m.indexOf('/', 1) + 1) + 'demo',
  );
  return out;
}

/** Values that should never survive redaction — checked after the fact. */
export function leaks(text) {
  const found = [];
  for (const m of text.matchAll(/\b\d{9,15}\b/g)) if (!/X/.test(m[0])) found.push(m[0]);
  if (USERNAME.length > 2 && text.includes(USERNAME)) found.push(USERNAME);
  return [...new Set(found)];
}

