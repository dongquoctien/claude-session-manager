import fs from 'node:fs';
import { sessionsDir, readSessionRecords, liveSessionMap, verifyLiveSessions } from '@csm/core';

/**
 * Live "which conversations are open" feed for the web UI, deliberately kept
 * apart from the heavy metrics stream (`/api/stream` re-scans every
 * transcript). This only reads Claude Code's small process registry
 * (`~/.claude/sessions/<pid>.json`, ~0.1ms per read), which changes when a
 * process starts or exits and when its status flips (busy/idle/waiting).
 *
 * One hub per agent, shared by all clients:
 *  - starts watching when the first client subscribes, stops with the last;
 *  - fs.watch on the dir for instant updates, plus a slow poll that catches a
 *    process that died without removing its file and a dir that appears late;
 *  - pushes only when the snapshot actually changed;
 *  - verifies each new process's creation time once (PID-reuse guard), off the
 *    hot path, and re-pushes if that drops an entry.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dir]      sessions dir (default ~/.claude/sessions, read at start)
 * @param {number} [opts.pollMs]   safety poll interval (default 5000)
 * @param {number} [opts.debounceMs] coalesce bursts of fs events (default 150)
 * @param {boolean} [opts.verify]  run the PID-reuse check (default true)
 */
export function createLiveHub(opts = {}) {
  const pollMs = opts.pollMs ?? 5000;
  const debounceMs = opts.debounceMs ?? 150;
  const verify = opts.verify ?? true;

  /** @type {Set<(snapshot: Record<string, object>) => void>} */
  const subscribers = new Set();
  /** @type {Record<string, object>} */
  let snapshot = {};
  let snapshotJson = '';
  let dir = null;
  let watcher = null;
  let poller = null;
  let debounce = null;
  let verifying = false;

  function compute() {
    const records = readSessionRecords(dir);
    const map = liveSessionMap({ records });
    const next = {};
    for (const id of [...map.keys()].sort()) next[id] = map.get(id);
    const json = JSON.stringify(next);
    if (json !== snapshotJson) {
      snapshotJson = json;
      snapshot = next;
      for (const fn of subscribers) fn(snapshot);
    }
    if (verify) verifyInBackground(records);
  }

  function verifyInBackground(records) {
    if (verifying) return;
    verifying = true;
    verifyLiveSessions({ records })
      .then((rejected) => { if (rejected > 0 && subscribers.size) compute(); })
      .catch(() => {})
      .finally(() => { verifying = false; });
  }

  function schedule() {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { debounce = null; compute(); }, debounceMs);
  }

  function ensureWatcher() {
    if (watcher) return;
    try {
      watcher = fs.watch(dir, { persistent: false }, schedule);
      watcher.on('error', () => { closeWatcher(); }); // dir removed etc.: poll takes over
    } catch {
      watcher = null; // dir missing for now; the poll retries
    }
  }

  function closeWatcher() {
    if (watcher) { try { watcher.close(); } catch { /* already closed */ } }
    watcher = null;
  }

  function startWatching() {
    dir = opts.dir || sessionsDir();
    ensureWatcher();
    poller = setInterval(() => { ensureWatcher(); compute(); }, pollMs);
    if (poller.unref) poller.unref();
    compute();
  }

  function stopWatching() {
    closeWatcher();
    if (poller) clearInterval(poller);
    if (debounce) clearTimeout(debounce);
    poller = null;
    debounce = null;
    // Forget the last snapshot so the next first subscriber gets a fresh one
    // (compute() only pushes on change).
    snapshot = {};
    snapshotJson = '';
  }

  return {
    /**
     * Receive the current snapshot now and every change after. Returns an
     * unsubscribe function.
     * @param {(snapshot: Record<string, object>) => void} fn
     */
    subscribe(fn) {
      subscribers.add(fn);
      if (subscribers.size === 1) startWatching();
      else fn(snapshot);
      return () => {
        subscribers.delete(fn);
        if (subscribers.size === 0) stopWatching();
      };
    },
    /** Number of connected clients (testing / diagnostics). */
    get size() { return subscribers.size; },
  };
}
