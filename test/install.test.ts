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

test('schtasks XML runs at logon, restarts on failure, and runs node with the launcher', () => {
  const xml = install.buildSchtasksXml({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    launcher: 'C:\\Users\\u\\.whatsappman\\bin\\whatsappmand-test',
  });
  assert.match(xml, /encoding="UTF-16"/); // schtasks /XML requires UTF-16
  assert.match(xml, /<LogonTrigger>/); // start at logon (RunAtLoad parity)
  assert.match(xml, /<RestartOnFailure>[\s\S]*<Count>3<\/Count>/); // KeepAlive parity
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/); // never time out — it's a daemon
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/); // never elevated
  assert.match(xml, /<Command>C:\\Program Files\\nodejs\\node\.exe<\/Command>/);
  // Launcher path is quoted (spaces) and the quotes are XML-escaped.
  assert.match(xml, /<Arguments>&quot;C:\\Users\\u\\\.whatsappman\\bin\\whatsappmand-test&quot;<\/Arguments>/);
});

test('schtasks XML escapes XML-significant characters in paths', () => {
  const xml = install.buildSchtasksXml({ nodePath: 'C:\\a & b\\node.exe', launcher: 'C:\\<x>' });
  assert.match(xml, /<Command>C:\\a &amp; b\\node\.exe<\/Command>/);
  assert.match(xml, /&lt;x&gt;/);
  assert.doesNotMatch(xml, /<Command>C:\\a & b/); // raw & must not survive
});

test('buildSchtasksCreateArgs registers the XML under the per-instance task name with /F', () => {
  const args = install.buildSchtasksCreateArgs('C:\\tmp\\task.xml', 'whatsappman-host');
  assert.deepEqual(args, ['/Create', '/TN', 'whatsappman-host', '/XML', 'C:\\tmp\\task.xml', '/F']);
});

test('schtasks task name + xml path mirror the instance id', () => {
  assert.equal(install.schtasksTaskName('Kalpesh.local'), 'whatsappman-kalpesh-local');
  assert.ok(install.schtasksXmlPath().endsWith('.xml'));
  assert.ok(install.schtasksXmlPath().includes('whatsappman-'));
});

test('supervisorStartPlan routes start through each supervisor (keeps crash-supervision)', () => {
  const launchd = install.supervisorStartPlan('launchd', 'Kalpesh.local');
  assert.equal(launchd?.length, 1);
  assert.equal(launchd?.[0].cmd, 'launchctl');
  assert.equal(launchd?.[0].args[0], 'kickstart');
  assert.match(launchd?.[0].args[1] ?? '', /^gui\/\d+\/com\.indianic\.whatsappman\.kalpesh-local$/);

  assert.deepEqual(install.supervisorStartPlan('systemd'), [
    { cmd: 'systemctl', args: ['--user', 'start', 'whatsappman.service'] },
  ]);
  assert.deepEqual(install.supervisorStartPlan('openrc'), [
    { cmd: 'rc-service', args: ['whatsappman', 'start'] },
  ]);
  assert.deepEqual(install.supervisorStartPlan('schtasks', 'Kalpesh.local'), [
    { cmd: 'schtasks', args: ['/Run', '/TN', 'whatsappman-kalpesh-local'] },
  ]);
});

test('supervisorStartPlan returns null for nohup (caller falls back to detached spawn)', () => {
  assert.equal(install.supervisorStartPlan('nohup'), null);
});
