import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

/**
 * Work digests from AI coding sessions.
 *
 * Claude Code writes one JSONL transcript per session under
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` (and `~/.iclaude/…`).
 * This module turns those into a factual digest — what you worked on, for how
 * long, across which projects — so `whatsappman summary` can send a real
 * standup instead of you writing one.
 *
 * Two rules shape everything here:
 *
 * 1. **Metadata only, never message bodies.** A transcript contains every
 *    prompt, reply and file you touched; some of that is secret. A digest that
 *    gets WhatsApp'd must carry only counts, durations, the session's own
 *    generated title, and file *names* — never prompt or response text. This
 *    mirrors the privacy guard in audit.ts (counts, never content).
 *
 * 2. **No model call.** Summarising is arithmetic over the transcript, not an
 *    LLM round-trip. WhatsAppMan promises "no third-party API, runs on your
 *    machine"; shipping a digest that phoned an LLM would break that promise.
 *    The prose-writing job belongs to whichever assistant is already reading
 *    this digest.
 */

/** Gap longer than this counts as "away", not work. Keeps a session left open
 *  overnight from claiming 14 hours of active time. */
const IDLE_GAP_MS = 10 * 60 * 1000;

/** Parsing every matched transcript can mean hundreds of MB; cap it and say so
 *  rather than silently truncating (or hanging). */
export const DEFAULT_MAX_SESSIONS = 40;

export interface SessionDigest {
  sessionId: string;
  /** Human project name — the last segment of the session's cwd. */
  project: string;
  cwd: string | null;
  branch: string | null;
  /** The session's own generated title. Safe to show: a label, not content. */
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Wall-clock first→last. */
  spanMs: number;
  /** Sum of gaps under IDLE_GAP_MS — closer to time actually worked. */
  activeMs: number;
  /** Prompts you typed (tool results and slash-command plumbing excluded). */
  prompts: number;
  toolCalls: number;
  /** [name, count] sorted by count desc. */
  topTools: Array<[string, number]>;
  /** File paths written/edited, deduped. Names only — never contents. */
  filesTouched: string[];
  transcript: string;
}

export interface SessionRef {
  file: string;
  projectDir: string;
  sessionId: string;
  mtimeMs: number;
}

/** Transcript roots that exist on this machine. Both CLIs use the same layout. */
export function transcriptRoots(home = os.homedir()): string[] {
  return [path.join(home, '.claude', 'projects'), path.join(home, '.iclaude', 'projects')].filter(
    (d) => {
      try {
        return fs.statSync(d).isDirectory();
      } catch {
        return false;
      }
    },
  );
}

/**
 * Claude Code names a project folder after its cwd with each path-ish character
 * replaced by `-` (so `/Users/k/.foo/bar` → `-Users-k--foo-bar`). Pure, and the
 * one rule that makes "summarise THIS project" work.
 *
 * Windows paths need `\` and the drive colon folded too — `C:\Users\k\App` →
 * `C--Users-k-App`. Encoding only `/` and `.` left a Windows cwd essentially
 * unchanged, so it matched no folder and `whatsappman summary` silently found
 * nothing for the project you were standing in.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/\\.:]/g, '-');
}

/** Best-effort human name for an encoded project dir (its last segment). */
export function projectNameFromDir(dir: string): string {
  const parts = dir.split('-').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : dir;
}

export interface ListOptions {
  /** Encoded project dir to restrict to (see encodeProjectDir). */
  projectDir?: string;
  /** Only sessions touched in the last N days. */
  days?: number;
  home?: string;
  now?: number;
}

/** All matching transcripts, newest first. Stats only — nothing is parsed. */
export function listSessions(opts: ListOptions = {}): SessionRef[] {
  const now = opts.now ?? Date.now();
  const cutoff = opts.days != null ? now - opts.days * 86_400_000 : null;
  const out: SessionRef[] = [];

  for (const root of transcriptRoots(opts.home)) {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      if (opts.projectDir && dir !== opts.projectDir) continue;
      let files: string[];
      try {
        files = fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const f of files) {
        const file = path.join(root, dir, f);
        let mtimeMs: number;
        try {
          mtimeMs = fs.statSync(file).mtimeMs;
        } catch {
          continue;
        }
        if (cutoff != null && mtimeMs < cutoff) continue;
        out.push({ file, projectDir: dir, sessionId: path.basename(f, '.jsonl'), mtimeMs });
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** One parsed transcript line, narrowed to the fields a digest needs. */
interface Entry {
  type?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  aiTitle?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: {
    content?: unknown;
  };
}

/** Slash-command plumbing shows up as a user turn but isn't something you typed. */
function isPlumbing(text: string): boolean {
  return /^<(local-command|command-name|command-message|command-args)/.test(text.trimStart());
}

/**
 * Fold parsed transcript entries into a digest. Separated from file reading so
 * the accounting rules are unit-testable on synthetic entries.
 */
export function summarizeEntries(entries: Entry[], meta: { sessionId: string; transcript: string }): SessionDigest {
  const times: number[] = [];
  const tools = new Map<string, number>();
  const files = new Set<string>();
  let title: string | null = null;
  let cwd: string | null = null;
  let branch: string | null = null;
  let prompts = 0;
  let toolCalls = 0;

  for (const e of entries) {
    if (e.timestamp) {
      const t = Date.parse(e.timestamp);
      if (!Number.isNaN(t)) times.push(t);
    }
    if (e.aiTitle) title = e.aiTitle;
    if (e.cwd) cwd = e.cwd;
    if (e.gitBranch) branch = e.gitBranch;
    // Sub-agent traffic is work you didn't type; it would inflate every count.
    if (e.isSidechain || e.isMeta) continue;

    if (e.type === 'user') {
      const c = e.message?.content;
      if (typeof c === 'string') {
        if (c.trim() && !isPlumbing(c)) prompts++;
      } else if (Array.isArray(c)) {
        // A user turn carrying tool_result blocks is the harness replying to a
        // tool call, not a prompt.
        const blocks = c as Array<{ type?: string; text?: string }>;
        const isToolResult = blocks.some((b) => b?.type === 'tool_result');
        const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
        if (!isToolResult && text.trim() && !isPlumbing(text)) prompts++;
      }
    } else if (e.type === 'assistant') {
      const c = e.message?.content;
      if (Array.isArray(c)) {
        for (const b of c as Array<{ type?: string; name?: string; input?: Record<string, unknown> }>) {
          if (b?.type !== 'tool_use') continue;
          toolCalls++;
          const name = b.name ?? 'unknown';
          tools.set(name, (tools.get(name) ?? 0) + 1);
          const fp = b.input?.file_path ?? b.input?.notebook_path;
          if ((name === 'Edit' || name === 'Write' || name === 'NotebookEdit') && typeof fp === 'string') {
            files.add(fp);
          }
        }
      }
    }
  }

  times.sort((a, b) => a - b);
  let activeMs = 0;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > 0 && gap <= IDLE_GAP_MS) activeMs += gap;
  }

  return {
    sessionId: meta.sessionId,
    project: cwd ? path.basename(cwd) : projectNameFromDir(path.basename(path.dirname(meta.transcript))),
    cwd,
    branch,
    title,
    startedAt: times.length ? new Date(times[0]).toISOString() : null,
    endedAt: times.length ? new Date(times[times.length - 1]).toISOString() : null,
    spanMs: times.length ? times[times.length - 1] - times[0] : 0,
    activeMs,
    prompts,
    toolCalls,
    topTools: [...tools.entries()].sort((a, b) => b[1] - a[1]),
    filesTouched: [...files],
    transcript: meta.transcript,
  };
}

/** Stream one transcript and fold it into a digest. Malformed lines are skipped
 *  — a half-written last line is normal for a session still in progress. */
export async function parseSession(ref: SessionRef): Promise<SessionDigest> {
  const entries: Entry[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(ref.file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as Entry);
    } catch {
      /* skip: partial or non-JSON line */
    }
  }
  return summarizeEntries(entries, { sessionId: ref.sessionId, transcript: ref.file });
}

/** "2h 05m" / "45m" / "30s" — compact enough for a WhatsApp line. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export interface FormatOptions {
  /** Heading, e.g. "Work summary — 30 Jul 2026". */
  heading?: string;
  /** Group by project (the multi-project rollup). Off = a flat session list. */
  byProject?: boolean;
  /** Note appended when the session list was capped. */
  truncatedNote?: string | null;
  /**
   * Longest N sessions listed per project; the rest collapse into an "…and N
   * more" line. A busy day can hold 20 sessions in one project, most of them
   * seconds long (a code review, a one-liner) — listing every one turns a
   * standup into a wall of noise. Totals above always count ALL sessions, so
   * capping the listing never makes the numbers lie.
   */
  perProject?: number;
}

const DEFAULT_PER_PROJECT = 5;

/**
 * Render digests as WhatsApp-ready text. Markdown `*bold*` survives the
 * Markdown→WhatsApp conversion in the send path. Carries titles, counts and
 * durations only — by construction there is no message content to leak.
 */
export function formatDigest(digests: SessionDigest[], opts: FormatOptions = {}): string {
  if (digests.length === 0) return 'No AI coding sessions found for that window.';

  const lines: string[] = [];
  const totalActive = digests.reduce((n, d) => n + d.activeMs, 0);
  const projects = new Set(digests.map((d) => d.project));
  const prompts = digests.reduce((n, d) => n + d.prompts, 0);
  const tools = digests.reduce((n, d) => n + d.toolCalls, 0);
  const files = new Set(digests.flatMap((d) => d.filesTouched));

  if (opts.heading) lines.push(`*${opts.heading}*`);
  lines.push(
    `${projects.size} project${projects.size === 1 ? '' : 's'} · ${digests.length} session${digests.length === 1 ? '' : 's'} · ${formatDuration(totalActive)} active`,
  );
  lines.push(`${prompts} prompts · ${tools} tool calls · ${files.size} files touched`);
  lines.push('');

  const render = (d: SessionDigest, indent: string) => {
    const head = d.title ?? `session ${d.sessionId.slice(0, 8)}`;
    lines.push(`${indent}• ${head}`);
    const bits = [formatDuration(d.activeMs), `${d.prompts} prompts`];
    if (d.filesTouched.length) bits.push(`${d.filesTouched.length} files`);
    if (d.branch) bits.push(d.branch);
    lines.push(`${indent}  ${bits.join(' · ')}`);
  };

  if (opts.byProject) {
    const groups = new Map<string, SessionDigest[]>();
    for (const d of digests) {
      const g = groups.get(d.project) ?? [];
      g.push(d);
      groups.set(d.project, g);
    }
    // Busiest project first — that's the headline of any standup.
    const ordered = [...groups.entries()].sort(
      (a, b) => b[1].reduce((n, d) => n + d.activeMs, 0) - a[1].reduce((n, d) => n + d.activeMs, 0),
    );
    const cap = opts.perProject ?? DEFAULT_PER_PROJECT;
    for (const [project, group] of ordered) {
      const active = group.reduce((n, d) => n + d.activeMs, 0);
      lines.push(`*${project}* — ${group.length} session${group.length === 1 ? '' : 's'}, ${formatDuration(active)}`);
      // Longest first: the headline work, not whatever ran most recently.
      const sorted = [...group].sort((a, b) => b.activeMs - a.activeMs);
      for (const d of sorted.slice(0, cap)) render(d, ' ');
      const rest = sorted.length - cap;
      if (rest > 0) lines.push(`  …and ${rest} shorter session${rest === 1 ? '' : 's'}`);
      lines.push('');
    }
  } else {
    for (const d of digests) render(d, '');
  }

  if (opts.truncatedNote) lines.push(opts.truncatedNote);
  return lines.join('\n').trimEnd();
}
