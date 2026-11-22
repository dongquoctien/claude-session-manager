import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, buildLaunch } from './launcher.js';
import { placeWhenLive } from './open.js';

/** Longest display name passed to `claude --name`. */
export const MAX_NAME_LENGTH = 80;

/**
 * @typedef {Object} NewSessionResult
 * @property {'launched'|'launch'} action  launch = what a dryRun would do
 * @property {string} id         the new conversation's id (`--session-id`)
 * @property {string} cwd        the folder it runs in (resolved)
 * @property {string} name       display name ('' when none)
 * @property {boolean} [dryRun]
 * @property {boolean} [placing] its window will be moved beside the floating
 *           Sessions list once it has started
 * @property {string} [terminal]
 * @property {string} [cmd]
 * @property {string[]} [args]
 */

/**
 * Tidy what the user typed or pasted as a folder: trim, drop the quotes that
 * Explorer's "Copy as path" adds, expand a leading `~`.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeFolderInput(raw) {
  let s = typeof raw === 'string' ? raw.trim() : '';
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    s = s.slice(1, -1).trim();
  }
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) {
    s = path.join(os.homedir(), s.slice(1));
  }
  return s;
}

/**
 * Is `p` a full path? On Windows that means a drive (`D:\…`) or a UNC share
 * (`\\server\share`) — a bare `\folder` would silently mean "on whatever
 * drive the agent runs from".
 * @param {string} p
 * @param {NodeJS.Platform} [platform]
 */
export function isFullPath(p, platform = process.platform) {
  if (platform === 'win32') return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(p);
  return path.posix.isAbsolute(p);
}

/**
 * Check a folder chosen for a new session: full path, exists, is a directory.
 * @param {unknown} raw
 * @param {{ platform?: NodeJS.Platform }} [opts]
 * @returns {{ ok: true, path: string } | { ok: false, error: string }}
 */
export function resolveFolder(raw, opts = {}) {
  const p = normalizeFolderInput(raw);
  if (!p) return { ok: false, error: 'Choose a folder first.' };
  if (!isFullPath(p, opts.platform)) {
    return { ok: false, error: `Use the folder's full path (e.g. ${process.platform === 'win32' ? 'D:\\Github\\my-app' : '/home/me/my-app'}).` };
  }
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return { ok: false, error: `Folder not found: ${p}` };
  }
  if (!st.isDirectory()) return { ok: false, error: `Not a folder: ${p}` };
  return { ok: true, path: path.resolve(p) };
}

/**
 * Clean a display name for `claude --name`: one line, no control characters,
 * no double quotes (Windows re-quotes the command line on its way through
 * wt.exe and a `"` does not survive it — verified), capped length.
 * @param {unknown} raw
 * @returns {string}
 */
export function cleanSessionName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001f\u007f"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
}

/**
 * Folders the user has worked in, most recently active first: one entry per
 * distinct `cwd` across the scanned conversations, skipping folders that no
 * longer exist. Feeds the "Recent folders" picker of the New session dialog.
 *
 * @param {import('./scanner.js').Session[]} sessions
 * @param {{ limit?: number, platform?: NodeJS.Platform }} [opts]
 * @returns {{ path: string, lastActive: number, count: number }[]}
 */
export function recentFolders(sessions, opts = {}) {
  const limit = opts.limit ?? 50;
  const caseless = (opts.platform || process.platform) === 'win32';
  /** @type {Map<string, { path: string, lastActive: number, count: number }>} */
  const byKey = new Map();
  for (const s of sessions || []) {
    if (!s || !s.cwd || s.cwdExists === false) continue;
    // D:\proj, D:\proj\ and d:\Proj are one folder on Windows.
    const trimmed = s.cwd.length > 3 ? s.cwd.replace(/[\\/]+$/, '') : s.cwd;
    const key = caseless ? trimmed.toLowerCase() : trimmed;
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, { path: trimmed, lastActive: s.mtime || 0, count: 1 });
    } else {
      cur.count += 1;
      if ((s.mtime || 0) > cur.lastActive) {
        cur.lastActive = s.mtime || 0;
        cur.path = trimmed; // spelling of the most recent use
      }
    }
  }
  return [...byKey.values()].sort((a, b) => b.lastActive - a.lastActive).slice(0, limit);
}

/**
 * Start a NEW Claude Code conversation in `cwd`, in a new terminal — what
 * `cd <folder>` + `claude [--dangerously-skip-permissions]` does by hand.
 *
 * csm chooses the session id (`--session-id`), so the process can be found in
 * the registry the moment it starts: with `place` (Sessions list floating)
 * its window is moved beside the list, exactly like Open.
 *
 * @param {{ cwd: unknown, name?: unknown, skipPermissions?: boolean,
 *           terminal?: import('./launcher.js').LaunchOptions['terminal'],
 *           place?: boolean, dryRun?: boolean }} opts
 * @param {Object} [deps]  injection points (testing)
 * @param {() => string} [deps.uuid]
 * @param {typeof launch} [deps.launch]
 * @param {typeof placeWhenLive} [deps.placeWhenLive]
 * @param {string} [deps.sessionsDir]
 * @returns {Promise<NewSessionResult>}  rejects with `err.code === 'BAD_FOLDER'`
 *          when the folder is unusable (nothing is started)
 */
export async function startNewSession(opts = {}, deps = {}) {
  const folder = resolveFolder(opts.cwd);
  if (!folder.ok) {
    const err = new Error(folder.error);
    err.code = 'BAD_FOLDER';
    throw err;
  }
  const id = (deps.uuid || crypto.randomUUID)();
  const name = cleanSessionName(opts.name);
  /** @type {import('./launcher.js').LaunchOptions} */
  const launchOpts = {
    cwd: folder.path,
    sessionId: id,
    newSession: true,
    name: name || undefined,
    skipPermissions: !!opts.skipPermissions,
    terminal: opts.terminal || 'auto',
  };
  const base = { id, cwd: folder.path, name };
  if (opts.dryRun) return { action: 'launch', dryRun: true, ...base, ...buildLaunch(launchOpts) };

  const launched = (deps.launch || launch)(launchOpts);
  if (opts.place) {
    // A fresh claude titles its tab "Claude Code" until it has a name.
    (deps.placeWhenLive || placeWhenLive)({ id, title: name || 'Claude Code' }, deps).catch(() => {});
    return { action: 'launched', ...base, placing: true, ...launched };
  }
  return { action: 'launched', ...base, ...launched };
}
