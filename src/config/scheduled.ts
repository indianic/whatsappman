import { scheduledPath } from './paths.js';
import { readJson, writeJson } from './store.js';
import { scheduledFileSchema, type ScheduledEntry } from './schema.js';

/**
 * Persistence for scheduled sends. The daemon is the only writer (atomic +
 * .bak via store.ts). Reloaded on boot so a "send at 9am" survives a restart.
 * See docs/PLAN.md (Scheduling — in the daemon, no OS ticker).
 */

export function readScheduled(): ScheduledEntry[] {
  return readJson(scheduledPath(), scheduledFileSchema)?.entries ?? [];
}

export function writeScheduled(entries: ScheduledEntry[]): void {
  writeJson(scheduledPath(), { schemaVersion: 1, entries });
}

export function addScheduled(entry: ScheduledEntry): void {
  const entries = readScheduled();
  entries.push(entry);
  writeScheduled(entries);
}

export function updateScheduled(id: string, patch: Partial<ScheduledEntry>): void {
  const entries = readScheduled();
  const i = entries.findIndex((e) => e.id === id);
  if (i === -1) return;
  entries[i] = { ...entries[i], ...patch };
  writeScheduled(entries);
}
