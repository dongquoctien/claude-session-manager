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
 * @param {{ timeoutMs?: number, intervalMs?: number, now?: () => number }} [opts]
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
 * Open a conversation the right way: if a `claude` process already has it
 * open, switch to that window (and tab); otherwise resume it in a new
 * terminal. `fork` always launches — it creates a new session id, so it can't
 * clash with the running one.
 *
 * Live state is read fresh here (not from a cached scan) because this decides
 * whether a process gets spawned.
 *
 * `place` (web UI with the Sessions list floating): put the terminal in the
 * space beside that window — right away when switching, and once it has
 * started when launching (in the background; the call doesn't wait for it).
 *
 * @param {import('./scanner.js').Session} session
 * @param {Omit<import('./launcher.js').LaunchOptions, 'cwd'|'sessionId'> & { dryRun?: boolean, place?: boolean }} [opts]
 * @param {Object} [deps]  injection points (testing)
 * @param {import('./liveSessions.js').LiveInfo|null} [deps.live]  skip the registry read
 * @param {string} [deps.sessionsDir]
 * @param {typeof focusSessionWindow} [deps.focus]
 * @param {typeof launch} [deps.launch]
 * @param {typeof placeWhenLive} [deps.placeWhenLive]
 * @returns {Promise<OpenResult>}
 */
export async function openSession(session, opts = {}, deps = {}) {
  const { dryRun = false, place = false, ...launchRest } = opts;
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
  const launched = (deps.launch || launch)(launchOpts);
  if (place) {
    (deps.placeWhenLive || placeWhenLive)(session, deps).catch(() => {});
    return { action: 'launched', live: null, placing: true, ...launched };
  }
  return { action: 'launched', live: null, ...launched };
}
