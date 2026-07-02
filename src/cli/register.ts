import { execFileSync } from 'node:child_process';
import { intro, outro, section, row, fact, attention } from './tree.js';

/**
 * Register the whatsappman MCP server with AI editors. Deliberately safe: it
 * prints the exact command + JSON snippet rather than mutating arbitrary editor
 * config files. `register --write` runs `claude mcp add` when the Claude CLI is
 * present. (A fuller multi-tool config writer, like mailman's, can come later.)
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

export function runRegister(write: boolean): number {
  intro('whatsappman — register');

  if (write && claudeCliAvailable()) {
    try {
      execFileSync('claude', ['mcp', 'add', 'whatsappman', '--', 'npx', '-y', PKG], {
        stdio: 'inherit',
      });
      section('done');
      fact('registered with Claude Code via `claude mcp add`', true);
      outro('register');
      return 0;
    } catch {
      attention('`claude mcp add` failed — falling back to printing the command');
    }
  }

  section('Claude Code');
  row(ADD_CMD);
  section('generic MCP config (Cursor / Windsurf / others)');
  row('"whatsappman": {');
  row('  "command": "npx",');
  row(`  "args": ["-y", "${PKG}"]`);
  row('}');
  attention('run the command above (or paste the JSON) in your AI tool, then restart it');
  outro('register');
  return 0;
}
