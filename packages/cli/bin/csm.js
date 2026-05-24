#!/usr/bin/env node
import {
  scanSessions,
  searchSessions,
  filterSessions,
  findSession,
  buildLaunch,
  launch,
  toggleFavorite,
  projectsDir,
  projectsDirExists,
} from '@csm/core';
import { renderGrouped, renderRow, c, timeAgo, humanSize } from '../src/format.js';

const HELP = `csm — Claude Session Manager

Usage:
  csm list [query...]        List conversations (optionally filtered)
  csm search <query...>      Alias for list with a query
  csm open <id|prefix>       Open a terminal and resume that conversation
  csm fav <id|prefix>        Toggle favorite (pin) for a conversation
  csm help                   Show this help

Options:
  --json                     Output JSON (for list/search)
  --limit <n>                Limit number of rows (default: all)
  --fav                      (list) Only favorites
  --recent [days]            (list) Only the last N days (default 7)
  --branch <name>            (list) Only this git branch
  --hide-missing             (list) Hide conversations whose folder is gone
  --dry-run                  (open) Print the command instead of running it
  --fork                     (open) Resume with --fork-session (new session id)
  --safe                     (open) Do NOT pass --dangerously-skip-permissions
                             (it is added by default for friction-free resume)
  --terminal <wt|powershell> (open) Force a terminal (default: auto)

Examples:
  csm list                   Show everything, grouped by folder
  csm list news-tok          Filter to conversations matching "news-tok"
  csm list --fav             Only pinned conversations
  csm list --recent 3        Touched in the last 3 days
  csm open 0ef59423          Resume by id prefix
  csm fav 0ef59423           Pin/unpin a conversation
`;

/** Minimal flag parser. Returns { _, flags }. */
function parseArgs(argv) {
  const _ = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--fork') flags.fork = true;
    else if (a === '--safe') flags.safe = true;
    else if (a === '--fav') flags.fav = true;
    else if (a === '--hide-missing') flags.hideMissing = true;
    else if (a === '--branch') flags.branch = argv[++i];
    else if (a === '--recent') {
      // optional numeric arg; default 7
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n)) { flags.recent = n; i++; }
      else flags.recent = 7;
    }
    else if (a === '--limit') flags.limit = Number(argv[++i]);
    else if (a === '--terminal') flags.terminal = argv[++i];
    else _.push(a);
  }
  return { _, flags };
}

function die(msg, code = 1) {
  process.stderr.write(c.red(msg) + '\n');
  process.exit(code);
}

async function getSessions() {
  if (!projectsDirExists()) {
    die(`No Claude projects directory found at:\n  ${projectsDir()}`);
  }
  return scanSessions();
}

async function cmdList(args, flags) {
  let sessions = await getSessions();
  const query = args.join(' ').trim();
  if (query) sessions = searchSessions(sessions, query);
  sessions = filterSessions(sessions, {
    favoritesOnly: !!flags.fav,
    hideOrphans: !!flags.hideMissing,
    branch: flags.branch,
    recentDays: flags.recent,
  });
  if (flags.limit && Number.isFinite(flags.limit)) {
    sessions = sessions.slice(0, flags.limit);
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify(sessions, null, 2) + '\n');
    return;
  }

  if (sessions.length === 0) {
    process.stdout.write(
      query ? `No conversations match "${query}".\n` : 'No conversations found.\n',
    );
    return;
  }

  process.stdout.write(renderGrouped(sessions) + '\n\n');
  const hint = query ? ` matching "${query}"` : '';
  process.stdout.write(
    c.dim(`${sessions.length} conversation(s)${hint}. `) +
    c.dim(`Open one with: `) + c.green(`csm open <id>`) + '\n',
  );
}

async function cmdOpen(args, flags) {
  const idArg = args[0];
  if (!idArg) die('Usage: csm open <id|prefix>');

  const sessions = await getSessions();
  const { match, ambiguous } = findSession(sessions, idArg);

  if (!match && ambiguous.length === 0) {
    die(`No conversation found for "${idArg}".`);
  }
  if (!match && ambiguous.length > 0) {
    process.stderr.write(c.yellow(`"${idArg}" is ambiguous — ${ambiguous.length} matches:\n`));
    for (const s of ambiguous.slice(0, 10)) {
      process.stderr.write(renderRow(s) + '\n');
    }
    process.exit(2);
  }

  if (!match.cwd) {
    die(`Conversation ${match.id.slice(0, 8)} has no recorded folder; cannot open.`);
  }
  if (!match.cwdExists) {
    process.stderr.write(
      c.yellow(`Warning: folder no longer exists:\n  ${match.cwd}\nClaude may fail to resume.\n`),
    );
  }

  const launchOpts = {
    cwd: match.cwd,
    sessionId: match.id,
    fork: !!flags.fork,
    skipPermissions: !flags.safe, // on by default; --safe opts out
    terminal: flags.terminal || 'auto',
  };

  if (flags.dryRun) {
    const { cmd, args: a, terminal } = buildLaunch(launchOpts);
    process.stdout.write(c.dim(`[dry-run] terminal=${terminal}\n`));
    process.stdout.write(`${cmd} ${a.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ')}\n`);
    return;
  }

  const { terminal } = launch(launchOpts);
  process.stdout.write(
    c.green('Opening ') + c.bold(match.title) + '\n' +
    c.dim(`  ${match.cwd}`) + (match.branch ? c.dim(`  (${match.branch})`) : '') + '\n' +
    c.dim(`  via ${terminal} · resume ${match.id.slice(0, 8)}`) + '\n',
  );
}

async function cmdFav(args) {
  const idArg = args[0];
  if (!idArg) die('Usage: csm fav <id|prefix>');
  const sessions = await getSessions();
  const { match, ambiguous } = findSession(sessions, idArg);
  if (!match && ambiguous.length === 0) die(`No conversation found for "${idArg}".`);
  if (!match && ambiguous.length > 0) {
    process.stderr.write(c.yellow(`"${idArg}" is ambiguous — ${ambiguous.length} matches.\n`));
    process.exit(2);
  }
  const favorited = await toggleFavorite(match.id);
  process.stdout.write(
    (favorited ? c.yellow('★ Pinned ') : c.dim('☆ Unpinned ')) + c.bold(match.title) + '\n',
  );
}

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmd = _[0];
  const rest = _.slice(1);

  switch (cmd) {
    case undefined:
    case 'list':
      return cmdList(rest, flags);
    case 'search':
      return cmdList(rest, flags);
    case 'open':
      return cmdOpen(rest, flags);
    case 'fav':
    case 'favorite':
      return cmdFav(rest);
    case 'help':
    case '-h':
    case '--help':
      process.stdout.write(HELP);
      return;
    default:
      // Bare `csm <query>` -> treat as list filter for convenience.
      return cmdList(_, flags);
  }
}

main().catch((err) => {
  die(`Error: ${err && err.message ? err.message : String(err)}`);
});
