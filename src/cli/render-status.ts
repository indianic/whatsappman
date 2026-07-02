import { intro, outro, section, fact, row, attention, pad } from './tree.js';
import type { StatusReport, SessionSummary } from '../status.js';

function fmtUptime(sec: number | null): string {
  if (sec === null) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function sessionRow(s: SessionSummary): string {
  const label = pad(s.label, 12);
  const phone = pad(s.phone ?? '—', 18);
  const status = pad(s.status, 14);
  const def = s.isDefault ? 'default' : '';
  return `${label} ${phone} ${status} ${def}`.trimEnd();
}

/** Render just the linked-numbers table (the `whatsappman numbers` command). */
export function renderNumbers(sessions: SessionSummary[]): void {
  intro('whatsappman — numbers');
  section('numbers');
  if (sessions.length === 0) {
    row('none linked yet  ·  run: whatsappman link');
  } else {
    for (const s of sessions) {
      if (s.status === 'needs_relink' || s.status === 'logged_out') {
        attention(sessionRow(s));
      } else {
        row(sessionRow(s));
      }
    }
  }
  outro('numbers');
}

/** Render a StatusReport in the shared diamond tree. */
export function renderStatus(report: StatusReport): void {
  intro('whatsappman — status');

  section('daemon');
  if (report.daemon.running) {
    const up = fmtUptime(report.daemon.uptimeSec);
    const parts = [`running (pid ${report.daemon.pid})`];
    if (up) parts.push(`up ${up}`);
    parts.push(`host ${report.daemon.hostname}`);
    fact(parts.join(' · '), true);
  } else {
    fact('not running  ·  run: whatsappman start', false);
  }

  section('numbers');
  if (report.sessions.length === 0) {
    row('none linked yet  ·  run: whatsappman link');
  } else {
    for (const s of report.sessions) {
      if (s.status === 'needs_relink' || s.status === 'logged_out') {
        attention(sessionRow(s));
      } else {
        row(sessionRow(s));
      }
    }
  }

  section('scheduled');
  fact(`${report.pendingScheduled} pending`, true);

  outro('status');
}
