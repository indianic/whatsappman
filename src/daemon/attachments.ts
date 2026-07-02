import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mime from 'mime-types';
import { baseDir } from '../config/paths.js';
import { WhatsAppManError, ErrorCode } from '../errors.js';

/**
 * Resolve a local file path for an image/document attachment, with a security
 * guard against exfiltration. A caller could otherwise "send" ~/.ssh/id_rsa or a
 * .env to an attacker's number — so resolve to an absolute path, refuse
 * sensitive locations (ATTACHMENT_FORBIDDEN), enforce a size cap, and infer the
 * MIME type. The file is validated here (at draft time); the bytes are read
 * later at send time. See docs/SECURITY.md (attachment path handling).
 */

export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024; // 64 MB

export interface ResolvedAttachment {
  absPath: string;
  filename: string;
  mimetype: string;
  sizeBytes: number;
}

/** Directories/patterns that must never be attachable, regardless of perms. */
function isForbidden(absPath: string): boolean {
  const home = os.homedir();
  const lower = absPath.toLowerCase();
  const base = path.basename(absPath).toLowerCase();

  const forbiddenDirs = [
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg'),
    path.join(home, '.config', 'gcloud'),
    path.join(home, 'Library', 'Keychains'),
    baseDir(), // never leak whatsappman's own creds/state
  ];
  if (forbiddenDirs.some((d) => absPath === d || absPath.startsWith(d + path.sep))) return true;

  // Secret-ish files by name.
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (/\.(pem|key|keychain|keychain-db|p12|pfx)$/.test(lower)) return true;
  if (base === 'id_rsa' || base === 'id_ed25519' || base === 'id_ecdsa') return true;

  return false;
}

export function resolveAttachment(inputPath: string): ResolvedAttachment {
  const absPath = path.resolve(inputPath);

  if (isForbidden(absPath)) {
    throw new WhatsAppManError(
      ErrorCode.ATTACHMENT_FORBIDDEN,
      `refusing to attach a sensitive path: ${absPath}`,
    );
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    throw new WhatsAppManError(ErrorCode.ATTACHMENT_NOT_FOUND, `no file at ${absPath}`);
  }
  if (!stat.isFile()) {
    throw new WhatsAppManError(ErrorCode.ATTACHMENT_NOT_FOUND, `not a file: ${absPath}`);
  }
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    throw new WhatsAppManError(
      ErrorCode.ATTACHMENT_TOO_LARGE,
      `${absPath} is ${(stat.size / 1_048_576).toFixed(1)} MB — over the ${
        MAX_ATTACHMENT_BYTES / 1_048_576
      } MB limit`,
    );
  }

  const filename = path.basename(absPath);
  const mimetype = mime.lookup(absPath) || 'application/octet-stream';
  return { absPath, filename, mimetype, sizeBytes: stat.size };
}
