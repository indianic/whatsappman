import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-install-'));
process.env.WHATSAPPMAN_DIR = dir;

const install = await import('../src/daemon/install.ts');

test('hostSlug + instanceId slugify the hostname', () => {
  assert.equal(install.hostSlug('Kalpesh.local'), 'kalpesh-local');
  assert.equal(install.hostSlug('WEIRD  Host!!'), 'weird-host');
  assert.equal(install.hostSlug(''), 'local');
  assert.equal(install.instanceId('Kalpesh.local'), 'whatsappman-kalpesh-local');
  assert.equal(install.launchdLabel('Kalpesh.local'), 'com.indianic.whatsappman.kalpesh-local');
});

test('jobPath bakes the running node bin dir + common dirs (launchd/systemd PATH gotcha)', () => {
  if (process.platform === 'win32') return;
  const p = install.jobPath('/opt/node/bin');
  assert.ok(p.startsWith('/opt/node/bin:'));
  assert.ok(p.includes('/opt/homebrew/bin'));
  assert.ok(p.includes('/usr/bin'));
});

test('launchd plist has RunAtLoad, KeepAlive-on-crash-only, throttle, and baked PATH', () => {
  const plist = install.buildLaunchdPlist({
    label: 'com.indianic.whatsappman.test',
    launcher: '/home/u/.whatsappman/bin/whatsappmand-test',
    pathStr: '/opt/node/bin:/usr/bin:/bin',
  });
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>/);
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(plist, /<key>Crashed<\/key><true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
  assert.match(plist, /\/opt\/node\/bin:\/usr\/bin:\/bin/);
});

test('systemd unit restarts on failure and installs to the default target', () => {
  const unit = install.buildSystemdUnit({ launcher: '/x/launcher', pathStr: '/p' });
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /ExecStart=\/x\/launcher/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.match(unit, /NoNewPrivileges=true/);
});

test('launcher script injects "daemon start" and imports the entry', () => {
  const script = install.buildLauncherScript('/abs/dist/index.js');
  assert.match(script, /#!\/usr\/bin\/env node/);
  assert.match(script, /'daemon', 'start'/);
  assert.match(script, /import\(/);
});

test('planInstall reports a mechanism + launcher without writing anything', () => {
  const plan = install.planInstall();
  assert.ok(['launchd', 'systemd', 'openrc', 'nohup', 'schtasks'].includes(plan.mechanism));
  assert.ok(plan.launcherPath.includes('whatsappmand-'));
  assert.ok(plan.launcherContent.length > 0);
  // Dry run must not create the launcher on disk.
  assert.equal(fs.existsSync(plan.launcherPath), false);
});
