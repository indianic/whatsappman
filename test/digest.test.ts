import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeProjectDir,
  projectNameFromDir,
  formatDuration,
  summarizeEntries,
  formatDigest,
  type SessionDigest,
} from '../src/digest.ts';

const META = { sessionId: 'abc12345-0000', transcript: '/tmp/p/abc12345-0000.jsonl' };
const at = (min: number) => new Date(Date.UTC(2026, 6, 30, 9, min, 0)).toISOString();

test('encodeProjectDir maps both / and . to - (Claude Code folder rule)', () => {
  assert.equal(encodeProjectDir('/Users/k/Sites/App'), '-Users-k-Sites-App');
  // A dotted path segment is why a naive slash-only replace finds nothing.
  assert.equal(encodeProjectDir('/Users/k/.phasepilot/runner'), '-Users-k--phasepilot-runner');
  assert.equal(encodeProjectDir('/srv/pay.indianic.net'), '-srv-pay-indianic-net');
});

test('encodeProjectDir folds Windows separators and the drive colon', () => {
  // Encoding only / and . left a Windows cwd almost unchanged, so it matched no
  // project folder and `summary` silently found nothing on Windows.
  assert.equal(encodeProjectDir('C:\\Users\\k\\App'), 'C--Users-k-App');
  assert.equal(encodeProjectDir('D:\\src\\pay.local'), 'D--src-pay-local');
  assert.ok(!encodeProjectDir('C:\\Users\\k\\App').includes('\\'), 'no separator may survive');
  assert.ok(!encodeProjectDir('C:\\Users\\k\\App').includes(':'), 'no drive colon may survive');
});

test('projectNameFromDir takes the trailing segment', () => {
  assert.equal(projectNameFromDir('-Users-k-Sites-WhatsAppMan'), 'WhatsAppMan');
  assert.equal(projectNameFromDir(''), '');
});

test('formatDuration is compact across scales', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(90_000), '2m');
  assert.equal(formatDuration(3_600_000), '1h 00m');
  assert.equal(formatDuration(20_100_000), '5h 35m');
});

test('summarizeEntries counts typed prompts, not tool results or plumbing', () => {
  const d = summarizeEntries(
    [
      { type: 'user', timestamp: at(0), message: { content: 'do the thing' }, cwd: '/Users/k/App', gitBranch: 'main' },
      // tool_result turns are the harness answering a tool call, not a prompt
      { type: 'user', timestamp: at(1), message: { content: [{ type: 'tool_result' }] } },
      // slash-command plumbing is not something the user typed as a prompt
      { type: 'user', timestamp: at(2), message: { content: '<local-command-stdout>ok</local-command-stdout>' } },
      // sub-agent traffic would inflate every count
      { type: 'user', isSidechain: true, timestamp: at(3), message: { content: 'subagent prompt' } },
      { type: 'user', timestamp: at(4), message: { content: [{ type: 'text', text: 'second prompt' }] } },
    ],
    META,
  );
  assert.equal(d.prompts, 2, 'only the two genuine prompts count');
  assert.equal(d.cwd, '/Users/k/App');
  assert.equal(d.branch, 'main');
  assert.equal(d.project, 'App');
});

test('summarizeEntries tallies tool calls and files touched (Edit/Write only)', () => {
  const d = summarizeEntries(
    [
      {
        type: 'assistant',
        timestamp: at(0),
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', input: {} },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/a/x.ts' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/a/x.ts' } }, // dedupes
            { type: 'tool_use', name: 'Write', input: { file_path: '/a/y.ts' } },
            { type: 'tool_use', name: 'Read', input: { file_path: '/a/z.ts' } }, // read != touched
          ],
        },
      },
    ],
    META,
  );
  assert.equal(d.toolCalls, 5);
  assert.deepEqual(d.filesTouched.sort(), ['/a/x.ts', '/a/y.ts']);
  assert.deepEqual(d.topTools[0], ['Edit', 2], 'busiest tool first');
});

test('active time excludes long idle gaps but span does not', () => {
  const d = summarizeEntries(
    [
      { type: 'user', timestamp: at(0), message: { content: 'a' } },
      { type: 'user', timestamp: at(5), message: { content: 'b' } }, // +5m worked
      { type: 'user', timestamp: at(300), message: { content: 'c' } }, // +295m away (lunch/overnight)
      { type: 'user', timestamp: at(303), message: { content: 'd' } }, // +3m worked
    ],
    META,
  );
  assert.equal(d.spanMs, 303 * 60_000, 'span is wall-clock first→last');
  assert.equal(d.activeMs, 8 * 60_000, 'active counts only the sub-10m gaps (5m + 3m)');
});

test('a digest carries NO message content — the privacy guarantee for sending', () => {
  // A transcript holds every prompt and reply; this digest gets WhatsApp'd, so
  // nothing from a message body may survive into it.
  const SECRET = 'AKIA-super-secret-key-do-not-leak';
  const d = summarizeEntries(
    [
      { type: 'user', timestamp: at(0), message: { content: `deploy with ${SECRET}` }, cwd: '/Users/k/App' },
      { type: 'assistant', timestamp: at(1), message: { content: [{ type: 'text', text: `sure, ${SECRET}` }] } },
      { type: 'ai-title', aiTitle: 'Deploy the API' },
    ],
    META,
  );
  const serialized = JSON.stringify(d);
  assert.ok(!serialized.includes(SECRET), 'no prompt/reply text may reach the digest');
  assert.ok(!serialized.includes('deploy with'), 'no message body may reach the digest');
  assert.equal(d.title, 'Deploy the API', 'the generated title IS carried — a label, not content');
  assert.ok(!formatDigest([d]).includes(SECRET), 'nor may it reach the rendered message');
});

const mk = (over: Partial<SessionDigest>): SessionDigest => ({
  sessionId: 'sid',
  project: 'App',
  cwd: '/Users/k/App',
  branch: 'main',
  title: 'Some work',
  startedAt: at(0),
  endedAt: at(10),
  spanMs: 600_000,
  activeMs: 600_000,
  prompts: 3,
  toolCalls: 9,
  topTools: [['Bash', 9]],
  filesTouched: ['/a/x.ts'],
  transcript: '/tmp/x.jsonl',
  ...over,
});

test('formatDigest reports an empty window honestly', () => {
  assert.match(formatDigest([]), /No AI coding sessions found/);
});

test('formatDigest totals count EVERY session even when the listing is capped', () => {
  // 8 sessions in one project, listing capped at 3: the totals must still say 8,
  // otherwise capping would quietly make the numbers lie.
  const many = Array.from({ length: 8 }, (_, i) =>
    mk({ sessionId: `s${i}`, title: `task ${i}`, activeMs: (i + 1) * 60_000, prompts: 1 }),
  );
  const out = formatDigest(many, { byProject: true, perProject: 3 });
  assert.match(out, /1 project · 8 sessions/, 'totals cover all 8');
  assert.match(out, /…and 5 shorter sessions/, 'the 5 unlisted are acknowledged, not dropped silently');
  assert.match(out, /task 7/, 'the longest session is listed');
  assert.ok(!out.includes('task 0'), 'the shortest is collapsed into the "and N more" line');
});

test('formatDigest groups by project, busiest first', () => {
  const out = formatDigest(
    [mk({ project: 'small', activeMs: 60_000 }), mk({ project: 'big', activeMs: 3_600_000 })],
    { byProject: true },
  );
  assert.ok(out.indexOf('*big*') < out.indexOf('*small*'), 'busiest project leads the standup');
});

test('formatDigest emits a heading and WhatsApp bold markup', () => {
  const out = formatDigest([mk({})], { heading: 'Work summary — 30 Jul 2026' });
  assert.match(out, /^\*Work summary — 30 Jul 2026\*/);
});

/**
 * Discovery + streaming against a real transcript tree. summarizeEntries is
 * covered above with synthetic entries; these cover the parts that touch the
 * filesystem, where a wrong glob or a partial last line means `summary` quietly
 * reports nothing.
 */
test('listSessions finds transcripts, honours --days, and parseSession streams one', async () => {
  const os = await import('node:os');
  const fsp = await import('node:fs');
  const p = await import('node:path');
  const { listSessions, parseSession, transcriptRoots } = await import('../src/digest.ts');

  const home = fsp.mkdtempSync(p.join(os.tmpdir(), 'wam-digest-'));
  const proj = p.join(home, '.claude', 'projects', '-Users-k-App');
  fsp.mkdirSync(proj, { recursive: true });

  const line = (o: unknown) => JSON.stringify(o) + '\n';
  const t = (min: number) => new Date(Date.UTC(2026, 6, 30, 9, min)).toISOString();
  fsp.writeFileSync(
    p.join(proj, 'sess-a.jsonl'),
    line({ type: 'ai-title', aiTitle: 'Fix the parser' }) +
      line({ type: 'user', timestamp: t(0), cwd: '/Users/k/App', gitBranch: 'main', message: { content: 'go' } }) +
      line({
        type: 'assistant',
        timestamp: t(2),
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/Users/k/App/x.ts' } }] },
      }) +
      '{ this line is truncated and must not kill the parse',
  );
  // A second, older session for the --days window.
  fsp.writeFileSync(p.join(proj, 'sess-old.jsonl'), line({ type: 'user', timestamp: t(0), message: { content: 'old' } }));
  const old = new Date(Date.UTC(2020, 0, 1));
  fsp.utimesSync(p.join(proj, 'sess-old.jsonl'), old, old);

  assert.deepEqual(transcriptRoots(home), [p.join(home, '.claude', 'projects')], 'only existing roots');

  const all = listSessions({ home, projectDir: '-Users-k-App' });
  assert.equal(all.length, 2, 'both transcripts are discovered');
  assert.equal(all[0].sessionId, 'sess-a', 'newest first');

  const recent = listSessions({ home, projectDir: '-Users-k-App', days: 7, now: Date.UTC(2026, 6, 30, 12) });
  assert.deepEqual(recent.map((r) => r.sessionId), ['sess-a'], '--days excludes the stale one');

  const d = await parseSession(all[0]);
  assert.equal(d.title, 'Fix the parser');
  assert.equal(d.branch, 'main');
  assert.equal(d.prompts, 1);
  assert.equal(d.toolCalls, 1);
  assert.deepEqual(d.filesTouched, ['/Users/k/App/x.ts']);
  // The truncated final line is normal for a session still being written.
  assert.ok(d.spanMs > 0, 'a partial last line must not abort the parse');

  fsp.rmSync(home, { recursive: true, force: true });
});

test('listSessions returns nothing (not a crash) when no transcripts exist', async () => {
  const os = await import('node:os');
  const fsp = await import('node:fs');
  const p = await import('node:path');
  const { listSessions } = await import('../src/digest.ts');
  const home = fsp.mkdtempSync(p.join(os.tmpdir(), 'wam-digest-empty-'));
  assert.deepEqual(listSessions({ home }), [], 'a machine that has never run Claude Code is fine');
  fsp.rmSync(home, { recursive: true, force: true });
});
