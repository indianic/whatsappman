import { fail, row, outro } from './tree.js';

/** True when a human can actually answer prompts / scan a QR at a real terminal. */
export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Gate for terminal-only commands (ported from mailman). `whatsappman link`
 * renders a QR and polls for a scan; run through an AI-tool command runner or a
 * pipe (not a TTY) it would print an unscannable QR and hang. Fail fast with an
 * actionable message instead. Returns true if OK to proceed, false if it
 * printed the guard message (caller should return non-zero).
 */
export function requireTty(what: string): boolean {
  if (isInteractiveTerminal()) return true;
  fail(`${what} needs a real terminal.`);
  row("this shell isn't one (AI-tool command runners, pipes, and CI are not TTYs).");
  row('open your terminal app and run it there directly.');
  outro(what);
  return false;
}
