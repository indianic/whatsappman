import { request } from '../ipc/client.js';
import { fail, pad } from './tree.js';
import { selectOne, canPrompt } from './prompts.js';
import type { SessionSummary } from '../status.js';

/** Render one session as a menu row: label, phone, status, aligned. */
export function sessionChoiceLabel(s: SessionSummary): string {
  return `${pad(s.label, 14)} ${pad(s.phone ?? '—', 16)} ${s.status}`;
}

/**
 * Interactively choose one linked number from the existing list, so a
 * label-taking command (delete/default/reconnect/disconnect) run with NO label
 * shows the numbers and lets you pick — instead of dead-ending on
 * "usage: … <label>". Returns the chosen label, or null (cancelled / nothing to
 * pick / not a TTY). Prints its own reason in every null case; the caller just
 * needs to outro. Must be called inside an existing intro().
 *
 * `autoSingle` skips the prompt when exactly one number is linked (there is
 * nothing to choose) — handy for `default`, pointless friction for `delete`.
 */
export async function pickSession(
  action: string,
  opts: { autoSingle?: boolean; command?: string } = {},
): Promise<string | null> {
  // `action` is the human verb for the prompt ("choose a number to set as
  // default"); `command` is the actual CLI word for the usage hint — they differ
  // for `default` (verb "set as default", command "default").
  const command = opts.command ?? action;
  if (!canPrompt(`no label given — pass one, e.g. whatsappman ${command} <label>`)) return null;

  let sessions: SessionSummary[];
  try {
    ({ sessions } = await request<{ sessions: SessionSummary[] }>('list_sessions'));
  } catch (err) {
    fail(String((err as Error)?.message ?? err));
    return null;
  }

  if (sessions.length === 0) {
    fail('no numbers linked yet — run: whatsappman link');
    return null;
  }
  if (sessions.length === 1 && opts.autoSingle) return sessions[0].label;

  // A real arrow-key selector: ↑/↓ to move, Enter to choose, Esc/Ctrl-C to
  // cancel. Typing an index is what a prompt does when it can't render a menu —
  // and the whole CLI already wears clack's diamond-tree look (see tree.ts),
  // so the menu belongs to the same visual language.
  return selectOne(
    `Choose a number to ${action}`,
    sessions.map((s) => ({
      value: s.label,
      label: sessionChoiceLabel(s),
      hint: s.isDefault ? 'default' : undefined,
    })),
  );
}
