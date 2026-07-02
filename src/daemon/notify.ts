import { execFile } from 'node:child_process';
import { readSettings } from '../config/state.js';

/**
 * Best-effort OS desktop notifications for actionable daemon events (a number
 * dropping to needs_relink, a scheduled send firing). The daemon runs in the
 * background, so without this the user has no way to learn a send will fail
 * until they try one. Default-on; disable with `settings set notifications
 * false` or WHATSAPPMAN_NOTIFICATIONS=0.
 *
 * Everything here is best-effort and NEVER throws: if the OS mechanism is
 * absent (no `notify-send` on a headless Linux box) or not permitted (see the
 * macOS Script Editor caveat below), the notification silently no-ops — it must
 * never break a send or crash the daemon.
 *
 * ── macOS permission caveat ──────────────────────────────────────────────
 * We fire macOS notifications via `osascript -e 'display notification …'`.
 * macOS attributes those to the **Script Editor** app, NOT to whatsappman. If
 * Script Editor's notifications are turned off, the call succeeds but nothing
 * appears — a silent no-op that looks like a bug. To enable them:
 *   System Settings → Notifications → Script Editor → Allow Notifications (on).
 * (This is the exact gotcha that makes "notifications don't work on my Mac"
 * almost always a permission toggle, not a whatsappman bug.)
 */

export function notificationsEnabled(): boolean {
  const env = process.env.WHATSAPPMAN_NOTIFICATIONS;
  if (env != null && /^(0|false|no|off)$/i.test(env.trim())) return false;
  try {
    return readSettings().notifications !== false;
  } catch {
    return true; // default-on if settings can't be read
  }
}

/** AppleScript string-literal escaping (double-quoted). */
function escAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** PowerShell single-quoted string escaping (double the quote). */
function escPowerShell(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * The exact command that fires a notification on a given platform. Pure, so the
 * per-OS mechanism + escaping is unit-testable without actually notifying.
 *   - macOS   → osascript 'display notification' (shown as Script Editor)
 *   - Windows → PowerShell WinRT toast (best-effort; no external module)
 *   - other   → notify-send (libnotify; Linux/BSD)
 */
export function buildNotifyCommand(
  platform: NodeJS.Platform,
  title: string,
  body: string,
): { cmd: string; args: string[] } {
  if (platform === 'darwin') {
    const script = `display notification "${escAppleScript(body)}" with title "${escAppleScript(title)}"`;
    return { cmd: 'osascript', args: ['-e', script] };
  }
  if (platform === 'win32') {
    const t = escPowerShell(title);
    const b = escPowerShell(body);
    const ps = [
      `$ErrorActionPreference='Stop';`,
      `$null=[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime];`,
      `$tpl=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);`,
      `$n=$tpl.GetElementsByTagName('text');`,
      `$null=$n[0].AppendChild($tpl.CreateTextNode('${t}'));`,
      `$null=$n[1].AppendChild($tpl.CreateTextNode('${b}'));`,
      `$toast=[Windows.UI.Notifications.ToastNotification]::new($tpl);`,
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('whatsappman').Show($toast);`,
    ].join(' ');
    return { cmd: 'powershell', args: ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps] };
  }
  // Linux / BSD / everything else.
  return { cmd: 'notify-send', args: [title, body] };
}

/** Fire a desktop notification. Best-effort; never throws, never blocks. */
export function notify(title: string, body: string): void {
  if (!notificationsEnabled()) return;
  try {
    const { cmd, args } = buildNotifyCommand(process.platform, title, body);
    const child = execFile(cmd, args, { timeout: 5000 }, () => {
      /* swallow all errors — a missing binary / denied permission is a no-op */
    });
    child.on('error', () => {
      /* ENOENT etc. — ignore */
    });
    child.unref?.();
  } catch {
    // never let a notification failure surface
  }
}
