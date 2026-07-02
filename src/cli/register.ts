import { execFileSync } from 'node:child_process';
import { intro, outro, section, row, fact, attention, fail } from './tree.js';
import { EDITORS, resolveTools, writeEditorConfig, type Scope } from './editor-config.js';

/**
 * Register the whatsappman MCP server with AI editors.
 *
 * - `register` (no flags): prints the exact command + per-tool config so the
 *   user can wire it up by hand — mutates nothing.
 * - `register --write [--tools a,b,c] [--project]`: writes/merges the
 *   `whatsappman` MCP entry into each selected editor's config file (Claude
 *   Code, Cursor, Gemini CLI, Windsurf, Codex). Claude Code prefers the
 *   official `claude mcp add` when the CLI is present; the rest are written
 *   directly (idempotent merge — see editor-config.ts).
 */

const PKG = '@indianic/whatsappman';
const ADD_CMD = `claude mcp add whatsappman -- npx -y ${PKG}`;

function claudeCliAvailable(): boolean {
  try {
    execFileSync('which', ['claude'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Wire Claude Code via the official CLI; returns false if it isn't available/failed so the caller can fall back. */
function tryClaudeCli(): boolean {
  if (!claudeCliAvailable()) return false;
  try {
    execFileSync('claude', ['mcp', 'add', 'whatsappman', '--', 'npx', '-y', PKG], { stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

export function runRegister(write: boolean, toolsSpec?: string, scope: Scope = 'global'): number {
  intro('whatsappman — register');

  if (write) {
    const ids = resolveTools(toolsSpec);
    if (ids.length === 0) {
      fail(`no known tools in "${toolsSpec}" — valid: ${EDITORS.map((e) => e.id).join(', ')} (or "all")`);
      outro('register');
      return 1;
    }

    section('editor config');
    let wrote = 0;
    for (const id of ids) {
      const editor = EDITORS.find((e) => e.id === id)!;
      try {
        // Claude Code: use the official CLI when we can — it owns ~/.claude.json.
        if (id === 'claude' && tryClaudeCli()) {
          row('Claude Code: registered via `claude mcp add`');
          wrote++;
          continue;
        }
        const result = writeEditorConfig(editor, scope);
        row(`${result.label}: ${result.action} ${result.file}`);
        wrote++;
      } catch (err) {
        fail(`${editor.label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (wrote > 0) {
      fact(`registered with ${wrote} tool${wrote === 1 ? '' : 's'} — restart the tool to pick it up`, true);
      outro('register');
      return 0;
    }
    outro('register');
    return 1;
  }

  // Print-only path (mutates nothing).
  section('Claude Code');
  row(ADD_CMD);
  section('generic MCP config (Cursor / Windsurf / Gemini / others)');
  row('"whatsappman": {');
  row('  "command": "npx",');
  row(`  "args": ["-y", "${PKG}"]`);
  row('}');
  section('write it for me');
  row('whatsappman register --write               (all supported tools)');
  row('whatsappman register --write --tools cursor,codex');
  attention('or run the command / paste the JSON above, then restart your AI tool');
  outro('register');
  return 0;
}
