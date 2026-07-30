import { intro, outro, section, row, fail } from './tree.js';
import { request } from '../ipc/client.js';
import { WhatsAppManError } from '../errors.js';
import { selectOne, askText, canPrompt } from './prompts.js';
import type { Settings } from '../config/schema.js';

const NUMERIC_KEYS = ['draftTtlMinutes', 'defaultDelayMs', 'maxBulkRecipients'];
const BOOL_KEYS = ['alwaysConfirm', 'notifications'];
const STRING_KEYS = ['defaultCountryCode'];
export const SETTABLE = [...NUMERIC_KEYS, ...BOOL_KEYS, ...STRING_KEYS];

/** One-line explanation per key, so the picker teaches instead of just listing. */
const SETTING_HELP: Record<string, string> = {
  draftTtlMinutes: 'how long a draft stays confirmable',
  defaultDelayMs: 'pause between bulk sends (anti-ban)',
  maxBulkRecipients: 'cap on recipients per bulk send',
  alwaysConfirm: 'always require confirmation',
  notifications: 'desktop notifications',
  defaultCountryCode: 'country code applied to bare numbers',
};

export function isBoolSetting(key: string): boolean {
  return BOOL_KEYS.includes(key);
}

/** Menu rows for `settings set` with no key: each key, what it does, and what
 *  it is set to right now. Pure, for tests. */
export function settingChoices(current: Settings): Array<{ value: string; label: string; hint: string }> {
  return SETTABLE.map((key) => ({
    value: key,
    label: `${key.padEnd(18)} ${String((current as unknown as Record<string, unknown>)[key])}`,
    hint: SETTING_HELP[key] ?? '',
  }));
}

export type CoerceResult =
  | { ok: true; value: number | boolean | string }
  | { ok: false; error: string };

/**
 * Coerce a raw CLI string into the typed value for a settings key. Pure +
 * exported so the parsing rules are unit-testable without the IPC round-trip.
 * `key` is assumed already validated against SETTABLE by the caller.
 * - bool keys: true/1/yes/on (case-insensitive) → true, anything else → false
 * - defaultCountryCode: strip a leading "+", must be 1-4 digits
 * - numeric keys: must parse to a finite number
 */
export function coerceSettingValue(key: string, rawValue: string): CoerceResult {
  if (BOOL_KEYS.includes(key)) {
    return { ok: true, value: /^(true|1|yes|on)$/i.test(rawValue) };
  }
  if (STRING_KEYS.includes(key)) {
    const value = rawValue.replace(/^\+/, '');
    if (!/^\d{1,4}$/.test(value)) {
      return { ok: false, error: `"${key}" expects 1-4 digits (a country code like 91), got "${rawValue}"` };
    }
    return { ok: true, value };
  }
  // Number('') and Number('  ') are 0 (finite) — reject blanks explicitly so an
  // empty value doesn't silently become 0.
  const trimmed = rawValue.trim();
  const value = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(value)) {
    return { ok: false, error: `"${key}" expects a number, got "${rawValue}"` };
  }
  return { ok: true, value };
}

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
      let key = args[2];
      let rawValue = args[3];

      // No key / no value: pick them instead of dead-ending on a usage line.
      // Nobody remembers `defaultDelayMs` or what it is currently set to.
      if (!key || rawValue === undefined) {
        if (!canPrompt('usage: whatsappman settings set <key> <value>')) {
          row(`keys: ${SETTABLE.join(', ')}`);
          outro('settings');
          return 1;
        }
        const current = await request<Settings>('get_settings');
        if (!key) {
          const picked = await selectOne('Which setting?', settingChoices(current));
          if (!picked) {
            outro('settings');
            return 1;
          }
          key = picked;
        }
        if (rawValue === undefined) {
          const now = String((current as unknown as Record<string, unknown>)[key]);
          const answer = isBoolSetting(key)
            ? await selectOne(`${key} — currently ${now}`, [
                { value: 'true', label: 'true' },
                { value: 'false', label: 'false' },
              ])
            : await askText(`${key} — currently ${now}`, { initialValue: now });
          if (!answer) {
            outro('settings');
            return 1;
          }
          rawValue = answer;
        }
      }

      if (!SETTABLE.includes(key)) {
        fail(`unknown setting "${key}"`);
        row(`keys: ${SETTABLE.join(', ')}`);
        outro('settings');
        return 1;
      }
      const coerced = coerceSettingValue(key, rawValue);
      if (!coerced.ok) {
        fail(coerced.error);
        outro('settings');
        return 1;
      }
      const value = coerced.value;
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
