#!/usr/bin/env node
// Thin shim. All real logic lives in dist/index.js, which dispatches by argv
// (MCP server over stdio | daemon | CLI). Keeping this file trivial means the
// published `whatsappman`/`mcp-whatsappman` bin never needs regenerating.

// Friendly Node-version gate BEFORE importing the ESM build — on Node < 18 the
// dynamic import fails with a cryptic ERR_UNSUPPORTED_ESM_URL_SCHEME stack.
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 18) {
  process.stderr.write(
    'whatsappman requires Node >= 18 (you have ' + process.versions.node + '). ' +
      'Please upgrade Node and try again.\n',
  );
  process.exit(1);
}

import('../dist/index.js').catch((err) => {
  // If dist is missing, the package wasn't built — give a clear hint rather
  // than a raw module-not-found stack.
  if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
    process.stderr.write(
      'whatsappman: build output missing (dist/). Run `npm run build` first.\n',
    );
    process.exit(1);
  }
  process.stderr.write(String(err?.stack || err) + '\n');
  process.exit(1);
});
