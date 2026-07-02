/**
 * Entry dispatcher. One binary, three modes, chosen by argv (see docs/CLI.md):
 *   - `daemon start`         → run the always-on daemon (invoked by the OS job
 *                              or `whatsappman start`'s detached spawn)
 *   - no args, over pipes    → start the stdio MCP server (how MCP hosts run us)
 *   - no args, at a TTY      → show the command list (a bare JSON-RPC server
 *                              silently waiting on stdin is never what a human
 *                              wanted)
 *   - anything else          → the CLI
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Daemon mode — only `daemon start` runs the long-lived process. Other
  // `daemon <sub>` commands (install/uninstall/status) are handled by the CLI.
  if (args[0] === 'daemon' && args[1] === 'start') {
    const { runDaemon } = await import('./daemon/main.js');
    await runDaemon();
    return; // daemon keeps the event loop alive
  }

  // No args: MCP server when piped, help when interactive.
  if (args.length === 0) {
    if (process.stdin.isTTY) {
      const { cliMain } = await import('./cli/index.js');
      process.exit(await cliMain(['help']));
    }
    const { runMcpServer } = await import('./mcp/server.js');
    await runMcpServer();
    return; // MCP server keeps the event loop alive over stdio
  }

  // CLI.
  const { cliMain } = await import('./cli/index.js');
  process.exit(await cliMain(args));
}

main().catch((err) => {
  process.stderr.write(String((err as Error)?.stack ?? err) + '\n');
  process.exit(1);
});
