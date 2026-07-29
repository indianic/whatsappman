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

/** Fallback when package.json can't be read — the name we publish under. */
const DEFAULT_PACKAGE_NAME = '@integratex/whatsappman';

/**
 * The installed package *name*, read from package.json the same way — never a
 * hardcoded literal. Anything that npx-resolves or registry-queries this
 * package (`whatsappman update`, the update notifier, the editor MCP configs
 * written by `whatsappman register`) must use whichever name this install was
 * actually published as, so a rename or a re-scope can't leave them pointing at
 * a package that no longer exists.
 */
export function getPackageName(): string {
  try {
    const p = fileURLToPath(new URL('../package.json', import.meta.url));
    return JSON.parse(fs.readFileSync(p, 'utf8')).name ?? DEFAULT_PACKAGE_NAME;
  } catch {
    return DEFAULT_PACKAGE_NAME;
  }
}
