import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installHint } from '../src/cli/doctor.ts';

/**
 * `doctor --fix` prints a per-platform install command. Two of the three
 * branches can never run on the machine writing them, so they are pinned here —
 * the same reason `shouldUseShell` was extracted in run.ts.
 */

test('the git hint names a real installer for each platform', () => {
  assert.match(installHint('git', 'darwin'), /xcode-select --install|brew install git/);
  assert.match(installHint('git', 'win32'), /winget install .*Git\.Git|git-scm\.com/);
  assert.match(installHint('git', 'linux'), /apt install git|dnf install git/);
});

test('the Windows hint never suggests a POSIX package manager', () => {
  // The failure this guards: telling a Windows user to run `sudo apt install`.
  const win = installHint('git', 'win32');
  assert.ok(!/\bapt\b|\bdnf\b|\bbrew\b|sudo/.test(win), `Windows hint leaked a POSIX installer: ${win}`);
});

test('the macOS hint never suggests apt or winget', () => {
  const mac = installHint('git', 'darwin');
  assert.ok(!/\bapt\b|\bdnf\b|winget/.test(mac), `macOS hint leaked a foreign installer: ${mac}`);
});

test('the Linux hint never suggests brew or winget', () => {
  const linux = installHint('git', 'linux');
  assert.ok(!/winget|brew/.test(linux), `Linux hint leaked a foreign installer: ${linux}`);
});

test('node/npm hints point somewhere real on every platform', () => {
  for (const tool of ['node', 'npm', 'npx']) {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const hint = installHint(tool, platform);
      assert.ok(hint.length > 0, `${tool}/${platform} has no hint`);
      assert.match(hint, /nodejs\.org|brew install node|winget install/, `${tool}/${platform}: ${hint}`);
    }
  }
});

test('an unknown tool still returns actionable text, never an empty string', () => {
  // A blank line under "how to fix" is worse than a generic sentence.
  const hint = installHint('some-future-dep', 'linux');
  assert.ok(hint.includes('some-future-dep'));
  assert.ok(hint.length > 10);
});

/**
 * The launcher check. `daemon install` bakes an ABSOLUTE path to dist/index.js
 * into the generated launcher, so a rename, a reinstall under a different
 * scope, or a moved checkout leaves an OS job that exists, reports healthy, and
 * dies at every login with ERR_MODULE_NOT_FOUND. That is not hypothetical: this
 * machine's launcher still pointed at the retired `@indianic` scope, so reboot
 * recovery was silently gone and `doctor` said "OS autostart installed".
 */
const { launcherTarget } = await import('../src/cli/doctor.ts');

test('launcherTarget extracts the dist path the OS job will load', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const p = await import('node:path');
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), 'wam-launcher-'));
  const file = p.join(dir, 'launcher');
  try {
    fs.writeFileSync(
      file,
      `#!/usr/bin/env node\nprocess.argv.splice(2, 0, 'daemon', 'start');\nimport("file:///opt/homebrew/lib/node_modules/@integratex/whatsappman/dist/index.js").catch(() => {});\n`,
    );
    assert.equal(
      launcherTarget(file),
      '/opt/homebrew/lib/node_modules/@integratex/whatsappman/dist/index.js',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('launcherTarget surfaces a stale path rather than hiding it', async () => {
  // The real failure, verbatim: a launcher left pointing at the retired scope.
  // The point is that it is RETURNED, so doctor can existence-check it — a
  // parser that quietly returned null here would have hidden the outage.
  const os = await import('node:os');
  const fs = await import('node:fs');
  const p = await import('node:path');
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), 'wam-launcher-stale-'));
  const file = p.join(dir, 'launcher');
  try {
    fs.writeFileSync(file, `import("file:///opt/homebrew/lib/node_modules/@indianic/whatsappman/dist/index.js").catch(() => {});`);
    const target = launcherTarget(file);
    assert.match(target ?? '', /@indianic/, 'the stale path must be reported, not swallowed');
    assert.equal(fs.existsSync(target), false, 'and it must be checkable for existence');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('launcherTarget returns null for a missing or unparseable launcher', () => {
  assert.equal(launcherTarget('/nonexistent/launcher'), null);
});
