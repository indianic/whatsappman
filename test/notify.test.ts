import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-notify-'));
process.env.WHATSAPPMAN_DIR = dir;

const { buildNotifyCommand, notificationsEnabled } = await import('../src/daemon/notify.ts');
const { writeSettings } = await import('../src/config/state.ts');
const { DEFAULT_SETTINGS } = await import('../src/config/schema.ts');

test('macOS uses osascript display notification with title + body', () => {
  const { cmd, args } = buildNotifyCommand('darwin', 'Hi', 'Body here');
  assert.equal(cmd, 'osascript');
  assert.equal(args[0], '-e');
  assert.match(args[1], /display notification "Body here" with title "Hi"/);
});

test('macOS escapes double quotes and backslashes in the AppleScript literal', () => {
  const { args } = buildNotifyCommand('darwin', 'A"B', 'C\\D');
  assert.match(args[1], /title "A\\"B"/);
  assert.match(args[1], /notification "C\\\\D"/);
});

test('Linux uses notify-send with title/body as separate argv (no escaping needed)', () => {
  const { cmd, args } = buildNotifyCommand('linux', 'T', 'B');
  assert.equal(cmd, 'notify-send');
  assert.deepEqual(args, ['T', 'B']);
});

test('Windows uses PowerShell and escapes single quotes for its string literals', () => {
  const { cmd, args } = buildNotifyCommand('win32', "it's", 'ok');
  assert.equal(cmd, 'powershell');
  assert.ok(args.includes('-Command'));
  const script = args[args.length - 1];
  assert.match(script, /ToastNotificationManager/);
  assert.match(script, /it''s/); // single quote doubled for PS
});

test('notificationsEnabled defaults on, respects the settings flag', () => {
  writeSettings({ ...DEFAULT_SETTINGS, notifications: true });
  delete process.env.WHATSAPPMAN_NOTIFICATIONS;
  assert.equal(notificationsEnabled(), true);

  writeSettings({ ...DEFAULT_SETTINGS, notifications: false });
  assert.equal(notificationsEnabled(), false);
});

test('WHATSAPPMAN_NOTIFICATIONS=0 overrides settings to off', () => {
  writeSettings({ ...DEFAULT_SETTINGS, notifications: true });
  for (const v of ['0', 'false', 'no', 'off']) {
    process.env.WHATSAPPMAN_NOTIFICATIONS = v;
    assert.equal(notificationsEnabled(), false, `env "${v}" should disable`);
  }
  process.env.WHATSAPPMAN_NOTIFICATIONS = '1';
  assert.equal(notificationsEnabled(), true);
  delete process.env.WHATSAPPMAN_NOTIFICATIONS;
});
