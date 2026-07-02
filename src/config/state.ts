import { statePath, settingsPath } from './paths.js';
import { readJson, writeJson } from './store.js';
import {
  stateSchema,
  settingsSchema,
  DEFAULT_SETTINGS,
  type State,
  type Settings,
} from './schema.js';

export function readState(): State | null {
  return readJson(statePath(), stateSchema);
}

export function writeState(state: State): void {
  writeJson(statePath(), state);
}

export function readSettings(): Settings {
  const s = readJson(settingsPath(), settingsSchema);
  return s ?? DEFAULT_SETTINGS;
}

export function writeSettings(settings: Settings): void {
  writeJson(settingsPath(), settings);
}
