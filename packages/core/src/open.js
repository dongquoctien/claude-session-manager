import { liveSessionMap } from './liveSessions.js';
import { focusSessionWindow } from './focus.js';
import { launch, buildLaunch } from './launcher.js';

/**
 * @typedef {Object} OpenResult
 * @property {'launched'|'focused'|'flashed'|'running'|'focus'|'launch'} action
 *   launched — a new terminal resumes the conversation
 *   focused  — it was already running; its window/tab is now in front
 *   flashed  — already running; Windows refused focus, its taskbar button flashes
 *   running  — already running, but its window can't be brought up (no console
 *              window, or not Windows). Nothing was started: a second process
 *              on the same transcript is never spawned behind the user's back
 *   focus / launch — what a dryRun would do
 * @property {boolean} [dryRun]
 * @property {import('./liveSessions.js').LiveInfo|null} [live]
 * @property {import('./focus.js').FocusResult} [focus]
 * @property {string} [terminal]
 * @property {string} [cmd]
 * @property {string[]} [args]
 * @property {boolean} [placing]  a new terminal will be moved beside the
 *           floating Sessions window once it has started
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * After a launch, wait for the new `claude` to register, then move its window
 * beside the floating Sessions window. Registration usually takes ~2s, but
 * claude writes its registry file only once startup is done — measured 27s
 * while some configured MCP servers were timing out — hence the long default
 * wait (polling the registry costs ~0.1ms per read).
 * Resolves with the focus result, or `{ result: 'timeout' }`. Never throws.
 *
 * @param {{ id: string, title: string }} session
 * @param {Object} [deps]
 * @param {(id: string) => import('./liveSessions.js').LiveInfo|null} [deps.readLive]
 * @param {string} [deps.sessionsDir]
 * @param {typeof focusSessionWindow} [deps.focus]
 * @param {{ timeoutMs?: number, intervalMs?: number, now?: () => number, placeRect?: object|null }} [opts]
 *   placeRect — put the window exactly there (floating layout), else beside the list
 * @returns {Promise<import('./focus.js').FocusResult|{ result: 'timeout' }>}
 */
export async function placeWhenLive(session, deps = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 400;
  const now = opts.now || Date.now;
  const started = now();
  const readLive = deps.readLive
    || ((id) => liveSessionMap({ dir: deps.sessionsDir }).get(id) || null);
  try {
    while (now() - started < timeoutMs) {
      const live = readLive(session.id);
      // Only the process we just launched (a dead one's file can linger).
      if (live && (live.startedAt == null || live.startedAt >= started - 5000)) {
        return await (deps.focus || focusSessionWindow)({
          pid: live.pid,
          procStart: live.procStart,
          titles: [session.title],
          place: true,
          ...(opts.placeRect ? { placeRect: opts.placeRect } : {}),
        });
      }
      await sleep(intervalMs);
    }
  } catch {
    // fall through: placement is best-effort
  }
  return { result: 'timeout' };
}

/**
 * After a launch with the Sessions list floating: move the new terminal beside
 * the list AS SOON AS its window exists, and bring it to the front.
 *
 * The new `claude` is found by the session id on its command line
 * (`--resume <id>` / `--session-id <id>`), so this does not wait for claude to
 * register in ~/.claude/sessions — which only happens once it has started up
 * (seconds with slow MCP servers or a huge transcript) and, in a folder it has
 * never seen, only after the user answered its "trust this folder?" question.
 * Placement used to wait for that, so the window first showed up at Windows
 * Terminal's default spot and jumped later. Fork works too: the forked
 * process still carries the original id, and only processes started after the
 * launch count.
 *
 * Falls back to {@link placeWhenLive} (registry) when the process can't be
 * found that way. Never throws.
 *
 * @param {{ id: string, title: string }} session
 * @param {Object} [deps]
 * @param {typeof focusSessionWindow} [deps.focus]
 * @param {typeof placeWhenLive} [deps.placeWhenLive]
 * @param {{ launchedAt?: number, searchMs?: number, placeRect?: object|null }} [opts]
 *   placeRect — put the window exactly there (floating layout), else beside the list
 * @returns {Promise<import('./focus.js').FocusResult|{ result: 'timeout' }>}
 */
export async function placeLaunched(session, deps = {}, opts = {}) {
  const launchedAt = opts.launchedAt ?? Date.now();
  try {
    const r = await (deps.focus || focusSessionWindow)({
      launchedId: session.id,
      launchedAfter: launchedAt - 2000, // clock slack; older processes never match
      searchMs: opts.searchMs ?? 8000,
      titles: [session.title],
      place: true,
      ...(opts.placeRect ? { placeRect: opts.placeRect } : {}),
    });
    if (r && (r.result === 'focused' || r.result === 'flashed' || r.result === 'no-window')) return r;
  } catch {
    // fall through to the registry
  }
  return (deps.placeWhenLive || placeWhenLive)(session, deps, opts.placeRect ? { placeRect: opts.placeRect } : {});
}

/**
 * Open a conversation the right way: if a `claude` process already has it
 * open, switch to that window (and tab); otherwise resume it in a new
 * terminal. `fork` always launches — it creates a new session id, so it can't
 * clash with the running one.
 *
 * Live state is read fresh here (not from a cached scan) because this decides
 * whether a process gets spawned.
 *
 * `place` (web UI with the Sessions list pinned): put the terminal in the
 * space beside that window — or exactly in `placeRect` (floating layout) —
 * right away when switching, and as soon as its window exists when launching
 * (in the background; the call doesn't wait for it).
 *
 * @param {import('./scanner.js').Session} session
 * @param {Omit<import('./launcher.js').LaunchOptions, 'cwd'|'sessionId'> & { dryRun?: boolean, place?: boolean,
 *          placeRect?: { x: number, y: number, w: number, h: number }|null }} [opts]
 * @param {Object} [deps]  injection points (testing)
 * @param {import('./liveSessions.js').LiveInfo|null} [deps.live]  skip the registry read
 * @param {string} [deps.sessionsDir]
 * @param {typeof focusSessionWindow} [deps.focus]
 * @param {typeof launch} [deps.launch]
 * @param {typeof placeLaunched} [deps.placeLaunched]
 * @returns {Promise<OpenResult>}
 */
export async function openSession(session, opts = {}, deps = {}) {
  const { dryRun = false, place = false, placeRect = null, ...launchRest } = opts;
  const where = place && placeRect ? { placeRect } : {};
  const launchOpts = { ...launchRest, cwd: session.cwd, sessionId: session.id };

  const live = deps.live !== undefined
    ? deps.live
    : liveSessionMap({ dir: deps.sessionsDir }).get(session.id) || null;

  if (live && !opts.fork) {
    if (dryRun) return { action: 'focus', dryRun: true, live };
    const focus = await (deps.focus || focusSessionWindow)({
      pid: live.pid,
      procStart: live.procStart,
      titles: [session.title],
      place,
      ...where,
    });
    if (focus.result === 'focused' || focus.result === 'flashed') {
      return { action: focus.result, live, focus };
    }
    // gone / stale: the registry entry outlived its process → not running.
    if (focus.result !== 'gone' && focus.result !== 'stale') {
      return { action: 'running', live, focus };
    }
  }

  if (dryRun) return { action: 'launch', dryRun: true, live: null, ...buildLaunch(launchOpts) };
  const launchedAt = Date.now();
  const launched = (deps.launch || launch)(launchOpts);
  if (place) {
    (deps.placeLaunched || placeLaunched)(session, deps, { launchedAt, ...where }).catch(() => {});
    return { action: 'launched', live: null, placing: true, ...launched };
  }
  return { action: 'launched', live: null, ...launched };
}
