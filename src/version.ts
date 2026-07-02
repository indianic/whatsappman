import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Package version, read from package.json at runtime (works from both dist/ and tsx/src). */
export function getVersion(): string {
  try {
    const p = fileURLToPath(new URL('../package.json', import.meta.url));
    return JSON.parse(fs.readFileSync(p, 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
