import fs from 'node:fs';
import path from 'node:path';
import { sessionsDir } from './paths.js';
import { runPowerShell } from './powershell.js';

/**
 * Which conversations are open RIGHT NOW, read from Claude Code's own registry
 * of running processes: `~/.claude/sessions/<pid>.json`. Verified on real
 * data (see CLAUDE.md):
 *  - every running interactive `claude` has one file, deleted on exit;
 *  - it carries `sessionId`, `status` (`busy` | `idle` | `waiting`),
 *    `waitingFor`, `statusUpdatedAt`, `kind`, `entrypoint`;
 *  - `procStart` is the process creation time as a Windows FILETIME, equal to
 *    the real creation time to the 100ns.
 *
 * A file can outlive its process (crash, kill -9), and Windows reuses PIDs.
 * Two guards:
 *  - cheap, every read: the PID must be alive (`process.kill(pid, 0)`);
 *  - once per new process: its creation time must equal `procStart`
 *    ({@link verifyLiveSessions}, Windows, one PowerShell call, cached). A
 *    mismatch means the PID now belongs to something else, and the entry is
 *    dropped for as long as that file stays.
 */

/**
 * @typedef {Object} LiveInfo
 * @property {number} pid
 * @property {string|null} procStart  creation time (Windows FILETIME), as recorded
 * @property {'busy'|'waiting'|'idle'|'unknown'} status
 * @property {string|null} waitingFor  what a `waiting` session waits on, if given
 * @property {number|null} since       when `status` last changed (ms epoch)
 * @property {number|null} startedAt   process start (ms epoch)
 * @property {string|null} kind        e.g. `interactive`
 * @property {string|null} entrypoint  e.g. `cli`
 */

const STATUSES = new Set(['busy', 'waiting', 'idle']);

/**
 * Read and parse every `<pid>.json` in the sessions dir. Missing dir, partial
 * writes and garbage are skipped; never throws. Shared by the name and live
 * readers so a scan reads the directory once.
 * @param {string} [dir]
 * @returns {object[]}
 */
export function readSessionRecords(dir = sessionsDir()) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8'));
      if (d && typeof d === 'object') out.push(d);
    } catch {
      // partial write / garbage / vanished mid-read — skip
    }
  }
  return out;
}

/**
 * Whether a process with this PID exists. EPERM means it exists but belongs
 * to another user/elevation level, which still counts as alive.
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === 'EPERM');
  }
}

/** @param {*} v @returns {number|null} */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** @param {*} v @returns {string|null} */
const str = (v) => (typeof v === 'string' && v ? v : null);

/** @param {object} r @returns {boolean} */
function usable(r) {
  return typeof r.sessionId === 'string' && !!r.sessionId && Number.isInteger(r.pid) && r.pid > 0;
}

/** @param {object} r @returns {string} */
const verdictKey = (r) => `${r.pid}:${r.procStart}`;

/**
 * Creation-time verdicts, `${pid}:${procStart}` -> true (same process) /
 * false (PID reused). Module-level so a long-running agent verifies each
 * process once; pruned to the current files on every verify.
 * @type {Map<string, boolean>}
 */
const verdicts = new Map();

/**
 * Map sessionId -> {@link LiveInfo} for every conversation whose process is
 * running. Synchronous and cheap (~0.1ms): reads the small registry files and
 * checks each PID. If the same conversation is open in two processes, the
 * most recently started one wins.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dir]         sessions dir override (testing)
 * @param {object[]} [opts.records]   pre-read records (to share one read)
 * @param {(pid: number) => boolean} [opts.isAlive]  liveness check (testing)
 * @returns {Map<string, LiveInfo>}
 */
export function liveSessionMap(opts = {}) {
  const records = opts.records || readSessionRecords(opts.dir);
  const alive = opts.isAlive || isPidAlive;
  /** @type {Map<string, LiveInfo>} */
  const out = new Map();
  for (const r of records) {
    if (!usable(r)) continue;
    if (r.procStart && verdicts.get(verdictKey(r)) === false) continue;
    if (!alive(r.pid)) continue;
    /** @type {LiveInfo} */
    const info = {
      pid: r.pid,
      procStart: str(r.procStart),
      status: STATUSES.has(r.status) ? r.status : 'unknown',
      waitingFor: str(r.waitingFor),
      since: num(r.statusUpdatedAt) ?? num(r.updatedAt) ?? num(r.startedAt),
      startedAt: num(r.startedAt),
      kind: str(r.kind),
      entrypoint: str(r.entrypoint),
    };
    const prev = out.get(r.sessionId);
    if (!prev || (info.startedAt ?? 0) >= (prev.startedAt ?? 0)) out.set(r.sessionId, info);
  }
  return out;
}

/**
 * Creation time of each PID as a Windows FILETIME string, via one PowerShell
 * call. A PID that is gone is absent from the map; one whose start time can't
 * be read (another user's elevated process) maps to null.
 * @param {number[]} pids
 * @returns {Promise<Map<number, string|null>>}
 */
async function queryStartTimes(pids) {
  const list = pids.filter((p) => Number.isInteger(p) && p > 0).join(',');
  const script = `$ErrorActionPreference='SilentlyContinue'
Get-Process -Id ${list} | ForEach-Object { try { "$($_.Id) $($_.StartTime.ToFileTimeUtc())" } catch { "$($_.Id) ?" } }`;
  const { stdout } = await runPowerShell(script, { timeoutMs: 10_000 });
  /** @type {Map<number, string|null>} */
  const out = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+) (\d+|\?)$/);
    if (m) out.set(Number(m[1]), m[2] === '?' ? null : m[2]);
  }
  return out;
}

/**
 * Check every not-yet-verified live process against its recorded `procStart`
 * and remember the verdict, so {@link liveSessionMap} drops entries whose PID
 * was reused. Spawns PowerShell only when there is something new to verify —
 * in practice once per new Claude process. Windows only (elsewhere `procStart`
 * is not a FILETIME and the PID check alone is used).
 *
 * @param {Object} [opts]
 * @param {string} [opts.dir]
 * @param {object[]} [opts.records]
 * @param {(pids: number[]) => Promise<Map<number, string|null>>} [opts.query]  testing
 * @param {(pid: number) => boolean} [opts.isAlive]  testing
 * @returns {Promise<number>}  how many entries were newly rejected
 */
export async function verifyLiveSessions(opts = {}) {
  const records = (opts.records || readSessionRecords(opts.dir)).filter(usable);
  const alive = opts.isAlive || isPidAlive;

  const current = new Set(records.map(verdictKey));
  for (const k of verdicts.keys()) if (!current.has(k)) verdicts.delete(k);

  const pending = records.filter((r) => r.procStart && !verdicts.has(verdictKey(r)) && alive(r.pid));
  if (pending.length === 0) return 0;
  if (!opts.query && process.platform !== 'win32') return 0;

  const times = await (opts.query || queryStartTimes)(pending.map((r) => r.pid));
  let rejected = 0;
  for (const r of pending) {
    if (!times.has(r.pid)) continue; // exited meanwhile: the PID check handles it
    const t = times.get(r.pid);
    if (t === null) continue; // unreadable: leave unverified, trust the PID check
    let same;
    try {
      const diff = BigInt(t) - BigInt(r.procStart);
      same = (diff < 0n ? -diff : diff) <= 10_000n; // within 1ms (FILETIME is 100ns)
    } catch {
      continue; // procStart not a FILETIME (other platform/version): can't judge
    }
    verdicts.set(verdictKey(r), same);
    if (!same) rejected += 1;
  }
  return rejected;
}

/** Forget all creation-time verdicts (testing). */
export function resetLiveVerdicts() {
  verdicts.clear();
}
