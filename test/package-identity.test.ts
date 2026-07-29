import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPackageName, getVersion } from '../src/version.js';

/**
 * Guards the *published identity* of the package.
 *
 * This exists because of a real, shipped regression: the README told users to
 * install `@integratex/whatsappman` while four source files still hardcoded
 * `@indianic/whatsappman`. Nothing caught it — `whatsappman update` queried a
 * package that didn't exist on the public registry, and `whatsappman register`
 * wrote editor MCP configs launching a package npx could never resolve, so the
 * MCP server simply failed to start for anyone who installed from npm.
 *
 * The invariant is not "the name is a particular string" but "everything that
 * resolves this package agrees with what package.json publishes".
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISHED_NAME = '@integratex/whatsappman';

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  publishConfig?: Record<string, unknown>;
  bin?: Record<string, string>;
};

test('package.json publishes under the public @integratex name', () => {
  assert.equal(pkg.name, PUBLISHED_NAME);
});

test('publishConfig targets the public registry — no private-registry pin', () => {
  assert.equal(pkg.publishConfig?.access, 'public', 'a scoped package needs access:public to publish');
  assert.ok(
    !('registry' in (pkg.publishConfig ?? {})),
    'no registry pin: npm\'s default (registry.npmjs.org) must be used, not a retired private host',
  );
});

test('getPackageName() reflects package.json, so registry lookups can never drift', () => {
  assert.equal(getPackageName(), pkg.name);
  assert.equal(getVersion(), pkg.version);
});

/** Every source file, recursively — src/ only; dist/ is generated. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

test('no source file hardcodes a scoped whatsappman package name', () => {
  // Anything that npx-resolves or registry-queries the package must go through
  // getPackageName(). A literal here is exactly how the last breakage happened.
  const offenders: string[] = [];
  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    const body = readFileSync(file, 'utf8');
    for (const [i, line] of body.split('\n').entries()) {
      // The fallback constant in version.ts is the one legitimate literal —
      // it's what getPackageName() itself degrades to.
      if (file.endsWith(`${path.sep}version.ts`)) continue;
      if (/['"`]@[a-z0-9-]+\/whatsappman['"`]/.test(line)) {
        offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `use getPackageName() instead of a literal at: ${offenders.join(', ')}`);
});

test('both bin aliases point at the same launcher', () => {
  const bins = Object.values(pkg.bin ?? {});
  assert.equal(bins.length, 2, 'whatsappman + mcp-whatsappman');
  assert.equal(new Set(bins).size, 1, 'both aliases must resolve to one binary');
});
