import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Writes/merges the `whatsappman` MCP server entry into each supported editor's
 * config file — the "one command wires up every tool" ergonomics ported from
 * the sibling @indianic/mailman. See docs/SKILLS.md for the registration story.
 *
 * The launch block carries **no secrets**: WhatsApp creds live under
 * `~/.whatsappman/` (held by the daemon), never in editor config. So there's no
 * API key to prompt for, nothing to lock to 0600, and the block is identical
 * for every editor — just `npx -y @indianic/whatsappman`.
 */

export const SERVER_KEY = 'whatsappman';
const NPM_PACKAGE = '@indianic/whatsappman';

export type Scope = 'global' | 'project';
export type EditorFormat = 'json' | 'toml';

export interface EditorTarget {
  id: string;
  label: string;
  format: EditorFormat;
  /** These editors only ever read a user-level (global) config — project scope is ignored for them. */
  userLevelOnly?: boolean;
  path: (scope: Scope, cwd: string, home: string) => string;
}

// Paths mirror the conventions @indianic/contextbrain + mailman use, so every
// tool lands in the file a user already knows.
export const EDITORS: EditorTarget[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    format: 'json',
    path: (scope, cwd, home) => (scope === 'global' ? join(home, '.claude.json') : join(cwd, '.mcp.json')),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    format: 'json',
    path: (scope, cwd, home) => (scope === 'global' ? join(home, '.cursor', 'mcp.json') : join(cwd, '.cursor', 'mcp.json')),
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    format: 'json',
    userLevelOnly: true,
    path: (_s, _c, home) => join(home, '.gemini', 'settings.json'),
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    format: 'json',
    userLevelOnly: true,
    path: (_s, _c, home) => join(home, '.codeium', 'windsurf', 'mcp_config.json'),
  },
  {
    id: 'codex',
    label: 'Codex',
    format: 'toml',
    userLevelOnly: true,
    path: (_s, _c, home) => join(home, '.codex', 'config.toml'),
  },
];

/** The secretless launch block every JSON-format editor gets. */
export function jsonServerBlock(): { command: string; args: string[] } {
  return { command: 'npx', args: ['-y', NPM_PACKAGE] };
}

/**
 * Pure: given a parsed editor config object, return a copy with the
 * `whatsappman` entry merged into `mcpServers` (created if missing), leaving
 * every other server and top-level key untouched. Idempotent — re-running
 * overwrites only our own entry.
 */
export function mergeJsonMcpServers(cfg: Record<string, unknown>): Record<string, unknown> {
  const next = { ...cfg };
  const servers =
    next.mcpServers && typeof next.mcpServers === 'object' ? { ...(next.mcpServers as Record<string, unknown>) } : {};
  servers[SERVER_KEY] = jsonServerBlock();
  next.mcpServers = servers;
  return next;
}

/**
 * Pure: given the current TOML text of a Codex config, strip any prior
 * `[mcp_servers.whatsappman]` block(s) and append a fresh one — so re-runs
 * replace rather than duplicate, without disturbing unrelated
 * `[mcp_servers.*]` entries.
 */
export function mergeCodexToml(existing: string): string {
  const stripped = existing
    .replace(/\n*\[mcp_servers\.whatsappman\][^[]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  const block = `[mcp_servers.${SERVER_KEY}]\ncommand = "npx"\nargs = ["-y", "${NPM_PACKAGE}"]\n`;
  return ((stripped ? stripped + '\n\n' : '') + block).trimStart();
}

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, 'utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`${file} exists but isn't valid JSON — fix or remove it, then re-run.`);
  }
}

export interface WriteResult {
  label: string;
  file: string;
  action: 'created' | 'updated';
}

/**
 * Resolve the target file for one editor + scope and write the merged config.
 * No credential-file hardening (these files hold no whatsappman secret, and are
 * often shared with other tools), so we leave their permissions alone.
 */
export function writeEditorConfig(
  editor: EditorTarget,
  scope: Scope,
  cwd: string = process.cwd(),
  home: string = homedir(),
): WriteResult {
  const effectiveScope: Scope = editor.userLevelOnly ? 'global' : scope;
  const file = editor.path(effectiveScope, cwd, home);
  const existed = existsSync(file);

  mkdirSync(dirname(file), { recursive: true });

  if (editor.format === 'toml') {
    const existing = existed ? readFileSync(file, 'utf8') : '';
    writeFileSync(file, mergeCodexToml(existing) + '\n', 'utf8');
  } else {
    const merged = mergeJsonMcpServers(readJson(file));
    writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  }

  return { label: editor.label, file, action: existed ? 'updated' : 'created' };
}

/** Parse a `--tools claude,cursor` / `all` spec into known editor ids (unknown names dropped). */
export function resolveTools(spec: string | undefined): string[] {
  if (!spec || spec === 'all') return EDITORS.map((e) => e.id);
  return spec
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => EDITORS.some((e) => e.id === s));
}
