import { intro, outro, section, row, fail } from './tree.js';
import { request } from '../ipc/client.js';
import { WhatsAppManError } from '../errors.js';
import type { Settings } from '../config/schema.js';

const NUMERIC_KEYS = ['draftTtlMinutes', 'defaultDelayMs', 'maxBulkRecipients'];
const BOOL_KEYS = ['alwaysConfirm', 'notifications'];
const STRING_KEYS = ['defaultCountryCode'];
const SETTABLE = [...NUMERIC_KEYS, ...BOOL_KEYS, ...STRING_KEYS];

function printSettings(s: Settings): void {
  section('settings');
  row(`draftTtlMinutes    ${s.draftTtlMinutes}`);
  row(`defaultDelayMs     ${s.defaultDelayMs}`);
  row(`maxBulkRecipients  ${s.maxBulkRecipients}`);
  row(`alwaysConfirm      ${s.alwaysConfirm}`);
  row(`notifications      ${s.notifications}`);
  row(`defaultCountryCode ${s.defaultCountryCode}`);
}

export async function runSettings(args: string[]): Promise<number> {
  const sub = args[1];
  intro('whatsappman — settings');

  try {
    if (!sub || sub === 'get') {
      printSettings(await request<Settings>('get_settings'));
      outro('settings');
      return 0;
    }

    if (sub === 'set') {
      const key = args[2];
      const rawValue = args[3];
      if (!key || rawValue === undefined) {
        fail('usage: whatsappman settings set <key> <value>');
        row(`keys: ${SETTABLE.join(', ')}`);
        outro('settings');
        return 1;
      }
      if (!SETTABLE.includes(key)) {
        fail(`unknown setting "${key}"`);
        row(`keys: ${SETTABLE.join(', ')}`);
        outro('settings');
        return 1;
      }
      let value: number | boolean | string;
      if (BOOL_KEYS.includes(key)) {
        value = /^(true|1|yes|on)$/i.test(rawValue);
      } else if (STRING_KEYS.includes(key)) {
        // defaultCountryCode: bare digits only (strip a leading +), 1–4 digits.
        value = rawValue.replace(/^\+/, '');
        if (!/^\d{1,4}$/.test(value)) {
          fail(`"${key}" expects 1-4 digits (a country code like 91), got "${rawValue}"`);
          outro('settings');
          return 1;
        }
      } else {
        value = Number(rawValue);
        if (!Number.isFinite(value)) {
          fail(`"${key}" expects a number, got "${rawValue}"`);
          outro('settings');
          return 1;
        }
      }
      const updated = await request<Settings>('update_settings', { [key]: value });
      section('updated');
      row(`${key} = ${String(value)}`);
      printSettings(updated);
      outro('settings');
      return 0;
    }

    fail('usage: whatsappman settings get | set <key> <value>');
    outro('settings');
    return 1;
  } catch (err) {
    if (err instanceof WhatsAppManError) {
      fail(`${err.code}: ${err.message}`);
      for (const step of err.nextSteps ?? []) row(step);
    } else throw err;
    outro('settings');
    return 1;
  }
}
