import fs from 'node:fs';
import path from 'node:path';
import { sessionsDir } from './paths.js';

/**
 * Claude Code's `/rename` slash command does NOT write the new title into the
 * conversation `.jsonl` (where we read `aiTitle` etc.). Instead it stores a
 * `name` field in a per-process metadata file under `~/.claude/sessions/`.
 *
 * Those files are keyed by PID (`<pid>.json`), not by sessionId, and look like:
 *
 *   {"pid":33560,"sessionId":"aa90bdc5-…","name":"Exclusive Dashboard",…}
 *
 * Two consequences we handle here:
 *  - We must read every file and key the result by the `sessionId` INSIDE it,
 *    not by the filename.
 *  - PIDs get recycled, so several files may name different sessions, and a
 *    stale file may even still carry an old sessionId. We can't fully detect
 *    that, but we do prefer the most-recently-updated record per sessionId
 *    (via `updatedAt`/`startedAt`), so the latest rename wins.
 *
 * This is best-effort, live-process metadata — older sessions whose PID file
 * has been overwritten simply won't have a name here, and we fall back to the
 * normal title tiers. We never throw on a missing/garbage file.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dir]  override the sessions dir (testing)
 * @returns {Map<string, string>}  sessionId -> custom name (non-empty, trimmed)
 */
export function sessionNameMap(opts = {}) {
  const dir = opts.dir || sessionsDir();
  /** @type {Map<string, { name: string, at: number }>} */
  const best = new Map();

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return new Map(); // sessions dir missing -> no custom names
  }

  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, e.name), 'utf8');
    } catch {
      continue;
    }
    let d;
    try {
      d = JSON.parse(raw);
    } catch {
      continue; // partial write / garbage — skip
    }
    if (!d || typeof d !== 'object') continue;
    if (typeof d.sessionId !== 'string' || !d.sessionId) continue;
    if (typeof d.name !== 'string') continue;
    const name = d.name.trim();
    if (!name) continue;

    // Most-recent record per sessionId wins (latest rename). updatedAt is the
    // freshest signal; fall back to startedAt; else treat as oldest.
    const at = numField(d.updatedAt) ?? numField(d.startedAt) ?? 0;
    const prev = best.get(d.sessionId);
    if (!prev || at >= prev.at) best.set(d.sessionId, { name, at });
  }

  const out = new Map();
  for (const [id, v] of best) out.set(id, v.name);
  return out;
}

/** @param {*} v @returns {number|null} */
function numField(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
