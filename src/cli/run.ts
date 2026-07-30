import { spawn } from 'node:child_process';
import { intro, outro, section, row, fact, fail } from './tree.js';
import { request } from '../ipc/client.js';
import { WhatsAppManError } from '../errors.js';
import { formatDuration } from '../digest.js';

/** How much trailing output to attach when a command fails. Enough to see the
 *  error, small enough to stay a WhatsApp message. */
const TAIL_LINES = 12;
const TAIL_CHARS = 1200;

export interface RunOutcome {
  command: string;
  code: number | null;
  signal: string | null;
  durationMs: number;
  tail: string;
  cwd: string;
  host: string;
}

/**
 * Re-quote argv for display in the notification, so the message shows what you
 * meant (`sh -c "exit 3"`), not an ambiguous flattened string (`sh -c exit 3`).
 * Display only — never fed back to a shell. Pure, for tests.
 */
export function displayCommand(parts: string[]): string {
  return parts
    .map((p) => (/[\s"'$`\\|&;<>()*?]/.test(p) ? `"${p.replace(/(["\\$`])/g, '\\$1')}"` : p))
    .join(' ');
}

/**
 * Whether to run the command through a shell. Pure + exported so the platform
 * rule is testable from any OS — otherwise the Windows branch could only ever
 * be verified by owning a Windows machine.
 *
 * Your shell already parsed and quoted argv, so with several arguments we spawn
 * them verbatim — no shell, no re-parsing. Joining them into one string and
 * re-running it through a shell silently drops quoting: `run -- sh -c "exit 3"`
 * would become `sh -c exit 3`, a different command that exits 0.
 *
 * Two cases still need a shell:
 *  - a SINGLE argument is the deliberate shell form (`run -- "a && b"`)
 *  - Windows always, because npm/npx/yarn/tsc are `.cmd` shims there and
 *    CreateProcess cannot execute a batch file directly — a shell-less spawn
 *    dies with ENOENT, breaking `run -- npm test`, the most likely thing
 *    anyone types.
 */
export function shouldUseShell(parts: string[], platform: string = process.platform): boolean {
  return parts.length === 1 || platform === 'win32';
}

/** Keep only the last N lines / chars of captured output. Pure, for tests. */
export function lastLines(text: string, lines = TAIL_LINES, chars = TAIL_CHARS): string {
  const trimmed = text.replace(/\s+$/, '');
  if (!trimmed) return '';
  let out = trimmed.split('\n').slice(-lines).join('\n');
  if (out.length > chars) out = `…${out.slice(-chars)}`;
  return out;
}

/**
 * The message a finished command produces. Success stays one line; failure
 * carries the output tail, because "it failed" without the error is a
 * notification you have to walk to your desk to act on.
 *
 * Pure so the wording/threshold rules are testable without spawning anything.
 */
export function formatRunOutcome(o: RunOutcome, opts: { quiet?: boolean } = {}): string {
  const ok = o.code === 0 && !o.signal;
  const dur = formatDuration(o.durationMs);
  const head = ok
    ? `✅ \`${o.command}\` finished in ${dur}`
    : `❌ \`${o.command}\` failed in ${dur}`;

  const detail: string[] = [];
  if (!ok) {
    detail.push(o.signal ? `killed by ${o.signal}` : `exit ${o.code}`);
  }
  detail.push(`${o.host}:${o.cwd}`);

  const lines = [head, detail.join(' · ')];
  if (!ok && !opts.quiet && o.tail) {
    lines.push('', '```', o.tail, '```');
  }
  return lines.join('\n');
}

export interface RunOptions {
  to?: string;
  from?: string;
  quiet?: boolean;
  /** Notify only when the command fails — the "page me if it breaks" mode. */
  onFail?: boolean;
}

/**
 * `whatsappman run -- <command>` — run something, then WhatsApp how it went.
 *
 * The single highest-traffic pattern in docs/USE-CASES.md: a long job finishes
 * (#138, #246, #249), a batch reports its exit status (#250), a deploy or build
 * succeeds or fails (#1, #2, #13). Doing that by hand means remembering to
 * append `&& whatsappman send …` *and* an `||` branch for the failure — so most
 * people only ever wire up the happy path and never hear about failures.
 *
 * Output streams to your terminal as usual; the exit code is propagated so this
 * stays safe to drop into an existing script or CI step.
 */
export async function runCommand(argv: string[], opts: RunOptions): Promise<number> {
  const parts = argv.filter((a) => a !== '');
  if (parts.length === 0) {
    intro('whatsappman — run');
    fail('usage: whatsappman run [--to <recipient>] -- <command …>');
    outro('run');
    return 1;
  }
  const command = displayCommand(parts);

  const startedAt = Date.now();
  const useShell = shouldUseShell(parts, process.platform);
  const child = useShell
    ? spawn(parts.length === 1 ? parts[0] : displayCommand(parts), {
        shell: true,
        stdio: ['inherit', 'pipe', 'pipe'],
      })
    : spawn(parts[0], parts.slice(1), { stdio: ['inherit', 'pipe', 'pipe'] });

  let buffered = '';
  const capture = (chunk: Buffer, out: NodeJS.WriteStream) => {
    out.write(chunk);
    buffered += chunk.toString();
    // Bound memory on a chatty job; only the tail is ever sent.
    if (buffered.length > TAIL_CHARS * 8) buffered = buffered.slice(-TAIL_CHARS * 4);
  };
  child.stdout?.on('data', (c: Buffer) => capture(c, process.stdout));
  child.stderr?.on('data', (c: Buffer) => capture(c, process.stderr));

  const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('close', (c, s) => resolve({ code: c, signal: s }));
    child.on('error', () => resolve({ code: 127, signal: null }));
  });

  const outcome: RunOutcome = {
    command,
    code,
    signal,
    durationMs: Date.now() - startedAt,
    tail: lastLines(buffered),
    cwd: process.cwd(),
    host: (await import('node:os')).hostname(),
  };
  const ok = code === 0 && !signal;
  const text = formatRunOutcome(outcome, { quiet: opts.quiet });

  intro('whatsappman — run');
  section('result');
  fact(`${ok ? 'success' : 'failed'} in ${formatDuration(outcome.durationMs)}`, ok);

  if (opts.onFail && ok) {
    row('notify-on-fail: succeeded, nothing sent');
    outro('run');
    return code ?? 0;
  }
  if (!opts.to) {
    row('no --to given, nothing sent');
    row('send it next time: whatsappman run --to "<recipient>" -- <command>');
    outro('run');
    return code ?? 0;
  }

  try {
    const res = await request<{ label: string; toName: string }>('send_text', {
      from: opts.from,
      to: opts.to,
      text,
      raw: true,
    });
    row(`notified ${res.toName} via "${res.label}"`);
  } catch (err) {
    // Never let a notification failure mask the command's own result.
    if (err instanceof WhatsAppManError) fail(`${err.code}: ${err.message}`);
    else fail(String((err as Error)?.message ?? err));
  }
  outro('run');
  return code ?? 0;
}
