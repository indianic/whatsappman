import { select, text, confirm, isCancel } from '@clack/prompts';
import { row, fail } from './tree.js';
import { isInteractiveTerminal } from './interactive.js';

/**
 * The one interactive layer every command prompts through.
 *
 * Three things it guarantees, which hand-rolled prompts kept getting subtly
 * different:
 *
 * 1. **You can always get out.** Esc or Ctrl-C cancels any prompt, every prompt
 *    says so, and cancelling always reports the same way. "How do I exit this?"
 *    should never be a question you have to leave the terminal to answer.
 * 2. **Cancel is never consent.** Every helper returns null/false when
 *    cancelled, so an aborted prompt can't be mistaken for approval — which
 *    matters most on `delete` and `reset`.
 * 3. **Non-TTY never blocks.** A menu nobody can answer would hang CI, a pipe,
 *    or an MCP host forever, so these refuse up front with an actionable
 *    message instead.
 */

/** Shown on every prompt so the way out is always on screen. */
export const CANCEL_HINT = 'esc to cancel';

/** Printed whenever a prompt is cancelled, so it reads the same everywhere. */
export function reportCancelled(): void {
  row('cancelled — nothing was changed');
}

/**
 * Guard for the interactive path. `what` is the CLI usage hint shown when there
 * is no terminal to prompt on (CI, pipes, MCP stdio).
 */
export function canPrompt(what: string): boolean {
  if (isInteractiveTerminal()) return true;
  fail(`${what} — or run it in a real terminal to be prompted.`);
  return false;
}

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
}

/** Arrow-key menu. Returns null if cancelled (already reported). */
export async function selectOne<T>(message: string, options: Choice<T>[]): Promise<T | null> {
  const answer = await select({
    message: `${message}  (${CANCEL_HINT})`,
    options: options as unknown as Array<{ value: unknown; label: string; hint?: string }>,
  });
  if (isCancel(answer)) {
    reportCancelled();
    return null;
  }
  return answer as T;
}

/** Single-line input. Returns null if cancelled or left empty. */
export async function askText(
  message: string,
  opts: { placeholder?: string; initialValue?: string } = {},
): Promise<string | null> {
  const answer = await text({
    message: `${message}  (${CANCEL_HINT})`,
    placeholder: opts.placeholder,
    initialValue: opts.initialValue,
  });
  if (isCancel(answer)) {
    reportCancelled();
    return null;
  }
  const value = String(answer ?? '').trim();
  if (!value) {
    reportCancelled();
    return null;
  }
  return value;
}

/**
 * Yes/no for an irreversible action. Defaults to NO and treats cancel as NO:
 * on a prompt that wipes credentials, the safe answer must be the one you get
 * by panicking.
 */
export async function confirmDestructive(message: string): Promise<boolean> {
  const answer = await confirm({ message: `${message}  (${CANCEL_HINT})`, initialValue: false });
  return !isCancel(answer) && answer === true;
}
