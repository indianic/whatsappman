import { intro, outro, section, row, fact, fail, attention } from './tree.js';
import { request } from '../ipc/client.js';
import { WhatsAppManError } from '../errors.js';
import {
  listSessions,
  parseSession,
  formatDigest,
  encodeProjectDir,
  projectNameFromDir,
  DEFAULT_MAX_SESSIONS,
  type SessionDigest,
  type SessionRef,
} from '../digest.js';

export interface SummaryOptions {
  all?: boolean;
  project?: string;
  last?: number;
  days?: number;
  max?: number;
  to?: string;
  from?: string;
  cwd?: string;
}

/**
 * Resolve a friendly project name ("whatsappman") to the encoded transcript
 * folder. Matches the folder's trailing segment first, then any substring, so
 * you never have to type `-Users-kalpesh-Sites-…` yourself.
 */
export function resolveProjectDir(candidates: string[], query: string): string | null {
  const q = query.toLowerCase();
  const exact = candidates.find((d) => projectNameFromDir(d).toLowerCase() === q);
  if (exact) return exact;
  const encoded = candidates.find((d) => d.toLowerCase() === q);
  if (encoded) return encoded;
  const partial = candidates.filter((d) => d.toLowerCase().includes(q));
  return partial.length ? partial[0] : null;
}

/** Heading for the digest, e.g. "Work summary — 30 Jul 2026". */
export function summaryHeading(days: number | undefined, now = new Date()): string {
  const date = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  if (days === 1) return `Work summary — ${date}`;
  if (days) return `Work summary — last ${days} days`;
  return `Work summary — ${date}`;
}

/**
 * `whatsappman summary` — a factual digest of your AI coding sessions: what you
 * worked on, for how long, across which projects. Prints locally by default;
 * `--to` sends it over WhatsApp (the daily-standup case).
 *
 * Built entirely from local transcripts with no model call, and it carries only
 * titles, counts and durations — never prompt or reply text. See src/digest.ts.
 */
export async function runSummary(opts: SummaryOptions): Promise<number> {
  intro('whatsappman — summary');

  const max = opts.max ?? DEFAULT_MAX_SESSIONS;
  let projectDir: string | undefined;

  if (!opts.all) {
    if (opts.project) {
      const dirs = [...new Set(listSessions({ home: undefined }).map((s) => s.projectDir))];
      const hit = resolveProjectDir(dirs, opts.project);
      if (!hit) {
        fail(`no sessions found for a project matching "${opts.project}"`);
        row('run "whatsappman summary --all" to see every project');
        outro('summary');
        return 1;
      }
      projectDir = hit;
    } else {
      // Default: the project you're standing in.
      projectDir = encodeProjectDir(opts.cwd ?? process.cwd());
    }
  }

  let refs: SessionRef[] = listSessions({ projectDir, days: opts.days });

  if (refs.length === 0) {
    section('nothing to summarise');
    if (projectDir) {
      row(`no AI coding sessions found for "${projectNameFromDir(projectDir)}"`);
      row('try: whatsappman summary --all --days 1');
    } else {
      row('no AI coding sessions found in that window');
    }
    outro('summary');
    return 1;
  }

  // --last trims the newest N; without it a scoped run defaults to the latest
  // session, while a --days/--all run keeps everything in the window.
  const wantLast = opts.last ?? (opts.days || opts.all ? undefined : 1);
  if (wantLast != null) refs = refs.slice(0, wantLast);

  const truncated = refs.length > max;
  if (truncated) refs = refs.slice(0, max);

  const digests: SessionDigest[] = [];
  for (const ref of refs) {
    try {
      digests.push(await parseSession(ref));
    } catch {
      /* unreadable transcript: skip it rather than fail the whole digest */
    }
  }

  const text = formatDigest(digests, {
    heading: summaryHeading(opts.days),
    byProject: Boolean(opts.all) || new Set(digests.map((d) => d.project)).size > 1,
    truncatedNote: truncated ? `(showing the newest ${max} sessions — pass --max to widen)` : null,
  });

  section('digest');
  for (const line of text.split('\n')) row(line);

  if (!opts.to) {
    row('');
    row('send it: whatsappman summary --to "<recipient>" [--from <label>]');
    outro('summary');
    return 0;
  }

  try {
    // raw: the digest is already WhatsApp markup (*bold*); skip the Markdown
    // conversion so it lands exactly as rendered above.
    const res = await request<{ label: string; toName: string; messageId: string }>('send_text', {
      from: opts.from,
      to: opts.to,
      text,
      raw: true,
    });
    section('sent');
    fact(`digest sent to ${res.toName} via "${res.label}"`, true);
    outro('summary');
    return 0;
  } catch (err) {
    if (err instanceof WhatsAppManError) {
      fail(`${err.code}: ${err.message}`);
      for (const step of err.nextSteps ?? []) row(step);
    } else {
      fail(String((err as Error)?.message ?? err));
    }
    attention('the digest above was NOT sent');
    outro('summary');
    return 1;
  }
}
