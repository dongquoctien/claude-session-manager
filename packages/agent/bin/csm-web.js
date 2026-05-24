#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { start, DEFAULT_PORT } from '../src/server.js';

function parseArgs(argv) {
  const flags = { port: DEFAULT_PORT, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') flags.port = Number(argv[++i]);
    else if (a === '--no-open') flags.open = false;
    else if (a === '-h' || a === '--help') flags.help = true;
  }
  return flags;
}

const HELP = `csm-web — local web UI for Claude Session Manager

Usage:
  csm-web [--port <n>] [--no-open]

Options:
  --port <n>    Port to listen on (default ${DEFAULT_PORT})
  --no-open     Don't auto-open the browser
`;

/** Open a URL in the default browser, cross-platform. */
function openBrowser(url) {
  const platform = process.platform;
  if (platform === 'win32') {
    // `start` is a cmd builtin; empty title arg avoids quoting pitfalls.
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } else if (platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }

  let info;
  try {
    info = await start({ port: flags.port });
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      process.stderr.write(
        `Port ${flags.port} is already in use. Try: csm-web --port ${flags.port + 1}\n`,
      );
      process.exit(1);
    }
    throw err;
  }

  process.stdout.write(
    `\n  Claude Session Manager — web UI\n` +
    `  ${info.url}\n\n` +
    `  Listening on 127.0.0.1:${info.port} (local only). Press Ctrl+C to stop.\n\n`,
  );

  if (flags.open) openBrowser(info.url);

  const shutdown = () => {
    info.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(1);
});
