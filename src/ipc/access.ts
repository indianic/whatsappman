import crypto from 'node:crypto';
import fs from 'node:fs';
import { tokenPath } from '../config/paths.js';

/**
 * Capability token — layer 3 of the daemon's access control (see
 * docs/SECURITY.md). A 256-bit random token is minted at daemon startup and
 * written to daemon.token (0600). Every IPC request must present it, so only a
 * process that can read the owner's 0600 files can talk to the daemon. Rotated
 * on every restart.
 *
 * Note on the peer-UID boundary: connecting to the Unix socket already requires
 * write permission on the 0600 socket file inside the 0700 config dir, so the
 * filesystem enforces same-user access. An explicit getpeereid()/SO_PEERCRED
 * check (defense-in-depth against a loosened-perms scenario) needs a native
 * binding and is a documented Phase-8 addition, not wired here.
 */

/** Mint a fresh token and persist it 0600. Called by the daemon at startup. */
export function rotateToken(): string {
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath(), token, { mode: 0o600 });
  try {
    fs.chmodSync(tokenPath(), 0o600);
  } catch {
    // best-effort on non-POSIX
  }
  return token;
}

/** Read the current token, or null if the daemon isn't running / no token file. */
export function readToken(): string | null {
  try {
    const t = fs.readFileSync(tokenPath(), 'utf8').trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** Constant-time comparison of a presented token against the current one. */
export function verifyToken(provided: string): boolean {
  const actual = readToken();
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Remove the token file (called on clean daemon shutdown). */
export function clearToken(): void {
  try {
    fs.rmSync(tokenPath(), { force: true });
  } catch {
    // best-effort
  }
}
