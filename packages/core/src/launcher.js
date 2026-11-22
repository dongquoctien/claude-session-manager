import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';

/**
 * @typedef {Object} LaunchOptions
 * @property {string} cwd            working directory to open the terminal in
 * @property {string} sessionId      conversation to resume — or, with
 *           `newSession`, the id the new conversation is created with
 * @property {boolean} [newSession]  start a NEW conversation (`--session-id`)
 *           instead of resuming one
 * @property {string} [name]         display name for a new conversation (`--name`)
 * @property {boolean} [fork]        use --fork-session (new id, keep history)
 * @property {boolean} [skipPermissions] add --dangerously-skip-permissions
 * @property {'wt'|'powershell'|'macos'|'linux'|'auto'} [terminal='auto']
 * @property {string} [claudeBin='claude']
 */

let _wtPathCache; // undefined = not probed, string|null = result

/** @returns {string|null} absolute path to wt.exe, or null */
export function findWindowsTerminal() {
  if (_wtPathCache !== undefined) return _wtPathCache;
  if (process.platform !== 'win32') {
    _wtPathCache = null;
    return null;
  }
  // `where.exe` resolving wt.exe is authoritative. Note: wt.exe under
  // %LOCALAPPDATA%\Microsoft\WindowsApps is an App Execution Alias (a 0-byte
  // reparse point), so fs.existsSync() returns false even though it runs.
  // We therefore trust `where.exe`'s exit status + path, not a stat check.
  const probe = spawnSync('where.exe', ['wt.exe'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    _wtPathCache = null;
    return null;
  }
  const line = (probe.stdout || '').split(/\r?\n/).find((l) => l.trim());
  _wtPathCache = line ? line.trim() : null;
  return _wtPathCache;
}

/**
 * Decide which terminal strategy to use for the current platform.
 * @param {'wt'|'powershell'|'auto'} pref
 * @returns {'wt'|'powershell'|'macos'|'linux'}
 */
function pickTerminal(pref) {
  // Explicit choices (also lets callers/tests force a platform strategy).
  if (pref === 'wt' || pref === 'powershell' || pref === 'macos' || pref === 'linux') {
    return pref;
  }
  // auto: derive from the current platform.
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  return findWindowsTerminal() ? 'wt' : 'powershell';
}

/**
 * claude's own arguments.
 *  - resume:      `--resume <id> [--fork-session]`
 *  - new session: `--session-id <id> [--name <name>]` — csm picks the id up
 *    front, so it can find the new process in the registry right away (to
 *    place its window, and to show it as running) before any transcript exists.
 * @param {Pick<LaunchOptions, 'sessionId'|'newSession'|'name'|'fork'|'skipPermissions'>} opts
 * @returns {string[]}
 */
export function claudeArgsFor({ sessionId, newSession = false, name, fork = false, skipPermissions = false }) {
  const args = newSession ? ['--session-id', sessionId] : ['--resume', sessionId];
  if (newSession && name) args.push('--name', name);
  if (fork && !newSession) args.push('--fork-session');
  if (skipPermissions) args.push('--dangerously-skip-permissions');
  return args;
}

/**
 * Escape `;` for wt.exe. wt splits its WHOLE command line on `;` into
 * separate commands (new tabs) — even after `--` — so a `;` in a folder or a
 * session name would start a second command. `\;` is wt's escape for a
 * literal one (verified: `x\;y` reaches the program as `x;y`, and a start
 * folder `semi;colon` opens correctly).
 * @param {string} s @returns {string}
 */
export function wtEscape(s) {
  return String(s).replace(/;/g, '\\;');
}

/**
 * Build the argv for the chosen terminal. Returned as { cmd, args } so callers
 * can either spawn it or print it (dry-run) without re-deriving anything.
 *
 * @param {LaunchOptions} opts
 * @returns {{ cmd: string, args: string[], terminal: string }}
 */
export function buildLaunch(opts) {
  const {
    cwd,
    terminal = 'auto',
    claudeBin = 'claude',
  } = opts;

  const claudeArgs = claudeArgsFor(opts);

  const kind = pickTerminal(terminal);

  if (kind === 'wt') {
    // wt.exe -d "<cwd>" -- claude --resume <id>
    //
    // The `--` separator is essential: without it, wt parses claude's own
    // flags (--resume, --fork-session, ...) as if they were wt options. wt
    // doesn't know them, so it silently mangles the command line and claude
    // ends up launched WITHOUT --resume — which is exactly why a session
    // opened this way didn't match a real /resume. `--` tells wt "everything
    // after here is the command to run, stop parsing my options".
    const wt = findWindowsTerminal() || 'wt.exe';
    return {
      cmd: wt,
      args: ['-d', cwd, '--', claudeBin, ...claudeArgs].map(wtEscape),
      terminal: 'wt',
    };
  }

  if (kind === 'macos') {
    // Drive Terminal.app via AppleScript. Build a POSIX shell line that cd's
    // into cwd then runs claude, both quoted for the shell.
    const shellLine = `cd ${shQuote(cwd)} && ${shQuote(claudeBin)} ${claudeArgs.map(shQuote).join(' ')}`;
    const script = `tell application "Terminal" to do script ${asQuote(shellLine)}\ntell application "Terminal" to activate`;
    return { cmd: 'osascript', args: ['-e', script], terminal: 'macos' };
  }

  if (kind === 'linux') {
    // x-terminal-emulator is the Debian/Ubuntu alternatives symlink to the
    // user's default terminal; `-e` runs a command. We wrap in bash -lc so the
    // cd + claude run as one command and the user's PATH/login env applies.
    const shellLine = `cd ${shQuote(cwd)} && ${shQuote(claudeBin)} ${claudeArgs.map(shQuote).join(' ')}; exec bash`;
    return {
      cmd: 'x-terminal-emulator',
      args: ['-e', 'bash', '-lc', shellLine],
      terminal: 'linux',
    };
  }

  // PowerShell fallback (Windows without wt): open a new window that cd's into
  // cwd and runs claude, staying open afterwards (-NoExit). Set-Location
  // handles spaces/Unicode when the path is a single-quoted literal.
  const psCommand = `Set-Location -LiteralPath ${psSingleQuote(cwd)}; & ${psSingleQuote(claudeBin)} ${claudeArgs.map(psSingleQuote).join(' ')}`;
  return {
    cmd: 'powershell.exe',
    args: ['-NoExit', '-NoProfile', '-Command', psCommand],
    terminal: 'powershell',
  };
}

/**
 * Quote a value as a PowerShell single-quoted string literal
 * (single quotes inside are doubled).
 * @param {string} s @returns {string}
 */
function psSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Quote a value as a POSIX shell single-quoted literal.
 * @param {string} s @returns {string}
 */
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote a value as an AppleScript string literal (for osascript).
 * @param {string} s @returns {string}
 */
function asQuote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Variables a running Claude Code session sets for its own child processes.
 * If csm itself runs inside a Claude session (e.g. `csm open` or `npm run web`
 * started from Claude's shell), a resumed conversation would inherit them and
 * run as that session's *child*: Claude Code then turns transcript saving off
 * ("inherited CLAUDE_CODE_CHILD_SESSION marker") and never registers it in
 * ~/.claude/sessions — and the parent's messaging token would leak along. Only
 * these per-session markers are removed; user configuration such as
 * CLAUDE_CODE_GIT_BASH_PATH or CLAUDE_CODE_USE_BEDROCK is kept.
 * Windows Terminal hands the caller's environment to the new tab, so stripping
 * them here is enough (verified).
 */
const PARENT_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
];

/**
 * Environment for the spawned terminal: the agent's env minus
 *  - color suppressors: with NO_COLOR (or CLICOLOR=0) claude renders WITHOUT
 *    colors — flat/wrong vs a normal launch. We deliberately do NOT force color
 *    on; wt is a real TTY, so claude's own detection works;
 *  - the parent-Claude-session markers ({@link PARENT_SESSION_VARS}).
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
export function launchEnv(base = process.env) {
  const env = { ...base };
  delete env.NO_COLOR;
  delete env.CLICOLOR; // some tools treat CLICOLOR=0 as "no color"
  for (const k of PARENT_SESSION_VARS) delete env[k];
  return env;
}

/**
 * Launch a terminal that resumes the given conversation — or, with
 * `newSession`, starts a new one under the given id. The new terminal is
 * fully detached so it keeps running after csm exits.
 *
 * @param {LaunchOptions} opts
 * @returns {{ terminal: string, cmd: string, args: string[] }}
 */
export function launch(opts) {
  const supported = ['win32', 'darwin', 'linux'];
  if (!supported.includes(process.platform)) {
    throw new Error(`Launching is not supported on ${os.platform()}.`);
  }
  if (!opts.cwd) throw new Error('Cannot launch: session has no recorded cwd.');
  if (!opts.sessionId) throw new Error('Cannot launch: missing sessionId.');

  const { cmd, args, terminal } = buildLaunch(opts);
  const child = spawn(cmd, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: launchEnv(),
  });
  child.unref();
  return { terminal, cmd, args };
}
