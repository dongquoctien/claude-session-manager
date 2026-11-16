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
 */

/**
 * Open a conversation the right way: if a `claude` process already has it
 * open, switch to that window (and tab); otherwise resume it in a new
 * terminal. `fork` always launches — it creates a new session id, so it can't
 * clash with the running one.
 *
 * Live state is read fresh here (not from a cached scan) because this decides
 * whether a process gets spawned.
 *
 * @param {import('./scanner.js').Session} session
 * @param {Omit<import('./launcher.js').LaunchOptions, 'cwd'|'sessionId'> & { dryRun?: boolean }} [opts]
 * @param {Object} [deps]  injection points (testing)
 * @param {import('./liveSessions.js').LiveInfo|null} [deps.live]  skip the registry read
 * @param {string} [deps.sessionsDir]
 * @param {typeof focusSessionWindow} [deps.focus]
 * @param {typeof launch} [deps.launch]
 * @returns {Promise<OpenResult>}
 */
export async function openSession(session, opts = {}, deps = {}) {
  const { dryRun = false, ...launchRest } = opts;
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
  return { action: 'launched', live: null, ...launched };
}
