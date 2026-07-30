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
