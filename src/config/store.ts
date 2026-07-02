import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Atomic, crash-safe JSON persistence, mirroring mailman's store.ts:
 *   - write to a temp file, fsync, then fs.rename() (atomic on POSIX)
 *   - keep a `.bak` copy of the previous good file before overwrite
 *   - on a parse failure at load, fall back to `.bak` and warn
 *
 * The daemon is the only writer in normal operation (clients mutate via IPC),
 * so there's no cross-process write race to guard beyond this.
 */

export function readJson<S extends z.ZodTypeAny>(file: string, schema: S): z.output<S> | null {
  const tryParse = (p: string): z.output<S> | null => {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  };

  try {
    const primary = tryParse(file);
    if (primary !== null) return primary;
  } catch {
    // fall through to .bak
  }

  const bak = `${file}.bak`;
  try {
    const fromBak = tryParse(bak);
    if (fromBak !== null) {
      process.stderr.write(`whatsappman: recovered ${path.basename(file)} from .bak\n`);
      return fromBak;
    }
  } catch {
    // give up cleanly
  }
  return null;
}

export function writeJson(file: string, value: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Keep a backup of the last good version before overwriting.
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
    } catch {
      // non-fatal — a failed backup shouldn't block the write
    }
  }

  const tmp = `${file}.tmp-${process.pid}`;
  const json = JSON.stringify(value, null, 2);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort on non-POSIX
  }
}
