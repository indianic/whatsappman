import fs from 'node:fs';
import path from 'node:path';
import { sessionsDir } from './paths.js';
import { readJson, writeJson } from './store.js';
import { sessionMetaSchema, type SessionMeta } from './schema.js';
import { WhatsAppManError, ErrorCode } from '../errors.js';

/**
 * On-disk session storage. Each linked number is a folder under
 * sessions/<label>/ holding Baileys auth creds (auth/) and meta.json. No DB —
 * the filesystem is the store. See docs/PLAN.md.
 */

const LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Validate + normalize a session label (lowercased). Throws on invalid input. */
export function normalizeLabel(raw: string): string {
  const label = raw.trim().toLowerCase();
  if (!LABEL_RE.test(label)) {
    throw new WhatsAppManError(
      ErrorCode.BAD_REQUEST,
      `invalid label "${raw}" — use 1-32 chars of a-z, 0-9, "-", "_"`,
    );
  }
  return label;
}

export function sessionDir(label: string): string {
  return path.join(sessionsDir(), label);
}

export function authDir(label: string): string {
  return path.join(sessionDir(label), 'auth');
}

export function metaPath(label: string): string {
  return path.join(sessionDir(label), 'meta.json');
}

/** All session labels present on disk (folders under sessions/). */
export function listSessionLabels(): string[] {
  try {
    return fs
      .readdirSync(sessionsDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => LABEL_RE.test(name))
      .sort();
  } catch {
    return [];
  }
}

export function readMeta(label: string): SessionMeta | null {
  return readJson(metaPath(label), sessionMetaSchema);
}

export function writeMeta(meta: SessionMeta): void {
  fs.mkdirSync(sessionDir(meta.label), { recursive: true, mode: 0o700 });
  writeJson(metaPath(meta.label), meta);
}

/** Does this label already have persisted auth creds? (i.e. it's been linked) */
export function hasCreds(label: string): boolean {
  try {
    return fs.existsSync(path.join(authDir(label), 'creds.json'));
  } catch {
    return false;
  }
}

export function deleteSessionDir(label: string): void {
  fs.rmSync(sessionDir(label), { recursive: true, force: true });
}

/** Create the meta for a brand-new session in the qr_pending state. */
export function initialMeta(label: string): SessionMeta {
  return {
    schemaVersion: 1,
    label,
    phone: null,
    status: 'qr_pending',
    linkedAt: null,
    lastConnectedAt: null,
  };
}
