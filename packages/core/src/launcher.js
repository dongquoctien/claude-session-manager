import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';

/**
 * @typedef {Object} LaunchOptions
 * @property {string} cwd            working directory to open the terminal in
 * @property {string} sessionId      conversation to resume
 * @property {boolean} [fork]        use --fork-session (new id, keep history)
 * @property {boolean} [skipPermissions] add --dangerously-skip-permissions
 * @property {'wt'|'powershell'|'auto'} [terminal='auto']
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
 * Decide which terminal strategy to use.
 * @param {'wt'|'powershell'|'auto'} pref
 * @returns {'wt'|'powershell'}
 */
function pickTerminal(pref) {
  if (pref === 'wt') return 'wt';
  if (pref === 'powershell') return 'powershell';
  // auto
  return findWindowsTerminal() ? 'wt' : 'powershell';
}

/**
 * Build the argv for the chosen terminal. Returned as { cmd, args } so callers
 * can either spawn it or print it (dry-run) without re-deriving anything.
 *
 * @param {LaunchOptions} opts
 * @returns {{ cmd: string, args: string[], terminal: 'wt'|'powershell' }}
 */
export function buildLaunch(opts) {
  const {
    cwd,
    sessionId,
    fork = false,
    skipPermissions = false,
    terminal = 'auto',
    claudeBin = 'claude',
  } = opts;

  const claudeArgs = ['--resume', sessionId];
  if (fork) claudeArgs.push('--fork-session');
  if (skipPermissions) claudeArgs.push('--dangerously-skip-permissions');

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
      args: ['-d', cwd, '--', claudeBin, ...claudeArgs],
      terminal: 'wt',
    };
  }

  // PowerShell fallback: open a new window that cd's into cwd and runs claude,
  // staying open afterwards (-NoExit). Set-Location handles spaces/Unicode when
  // the path is passed as a single-quoted literal.
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
 * @param {string} s
 * @returns {string}
 */
function psSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Environment for the spawned terminal. The launched claude inherits whatever
 * env csm/agent run under; if that includes NO_COLOR (or the agent was started
 * with NO_COLOR=1), claude renders WITHOUT colors — flat/wrong vs a normal
 * launch (logo grey instead of orange, no status colors). We strip the
 * color-suppressing vars so claude does its own normal TTY color detection
 * inside Windows Terminal — exactly as if you ran it directly. We deliberately
 * do NOT force color on, to avoid emitting ANSI in a terminal that can't show
 * it; wt is a real TTY, so detection works.
 * @returns {NodeJS.ProcessEnv}
 */
function colorEnv() {
  const env = { ...process.env };
  delete env.NO_COLOR;
  delete env.CLICOLOR; // some tools treat CLICOLOR=0 as "no color"
  return env;
}

/**
 * Launch a terminal that resumes the given conversation. The new terminal is
 * fully detached so it keeps running after csm exits.
 *
 * @param {LaunchOptions} opts
 * @returns {{ terminal: string, cmd: string, args: string[] }}
 */
export function launch(opts) {
  if (process.platform !== 'win32') {
    throw new Error(
      `Launching is only implemented for Windows so far (got ${os.platform()}). ` +
      `macOS/Linux support is planned (Phase 4).`,
    );
  }
  if (!opts.cwd) throw new Error('Cannot launch: session has no recorded cwd.');
  if (!opts.sessionId) throw new Error('Cannot launch: missing sessionId.');

  const { cmd, args, terminal } = buildLaunch(opts);
  const child = spawn(cmd, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: colorEnv(),
  });
  child.unref();
  return { terminal, cmd, args };
}
