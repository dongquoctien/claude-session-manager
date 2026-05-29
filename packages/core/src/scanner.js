import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { projectsDir, slugToLabel } from './paths.js';
import { parseHead } from './parser.js';
import { resolveTitle } from './title.js';
import { favoriteSet } from './state.js';
import { MetricsCache, resolveActivity, isActive, bucketTokenSeries } from './metrics.js';

/**
 * @typedef {Object} Session
 * @property {string} id            sessionId (the .jsonl basename)
 * @property {string} title         resolved display title
 * @property {string} titleSource   where the title came from
 * @property {string|null} cwd      real working directory to open in
 * @property {string|null} branch   git branch (distinguishes worktrees)
 * @property {string|null} lastPrompt  most recent prompt (for preview)
 * @property {number} mtime         file mtime (ms epoch), for "x ago"
 * @property {number} size          file size in bytes
 * @property {string} projectSlug   the encoded folder name
 * @property {string} projectLabel  best-effort human label for the folder
 * @property {string} file          absolute path to the .jsonl
 * @property {boolean} cwdExists     whether `cwd` still exists on disk (orphan check)
 * @property {boolean} favorite      whether the user pinned this conversation
 */

const DEFAULT_CONCURRENCY = 24;

/**
 * Run an async mapper over items with a bounded number in flight.
 * @template T,R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Scan every conversation under ~/.claude/projects and return Session records
 * sorted by most-recently-modified first.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dir]            override projects dir (testing)
 * @param {number} [opts.concurrency]
 * @returns {Promise<Session[]>}
 */
export async function scanSessions(opts = {}) {
  const root = opts.dir || projectsDir();
  const concurrency = opts.concurrency || DEFAULT_CONCURRENCY;

  let slugs;
  try {
    slugs = (await fsp.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return []; // projects dir missing -> no sessions
  }

  // Collect every .jsonl across all project folders.
  /** @type {{file: string, slug: string}[]} */
  const files = [];
  for (const slug of slugs) {
    const folder = path.join(root, slug);
    let entries;
    try {
      entries = await fsp.readdir(folder, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        files.push({ file: path.join(folder, e.name), slug });
      }
    }
  }

  const cwdExistsCache = new Map();
  const favorites = favoriteSet();
  const sessions = await mapLimit(files, concurrency, async ({ file, slug }) => {
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      return null;
    }
    if (stat.size === 0) return null;

    const meta = await parseHead(file);
    const mtime = stat.mtimeMs;
    const { title, source } = resolveTitle(meta, mtime);
    const id = path.basename(file, '.jsonl');

    let cwdExists = false;
    if (meta.cwd) {
      if (cwdExistsCache.has(meta.cwd)) {
        cwdExists = cwdExistsCache.get(meta.cwd);
      } else {
        cwdExists = fs.existsSync(meta.cwd);
        cwdExistsCache.set(meta.cwd, cwdExists);
      }
    }

    /** @type {Session} */
    return {
      id,
      title,
      titleSource: source,
      cwd: meta.cwd,
      branch: meta.gitBranch,
      lastPrompt: meta.lastPrompt,
      mtime,
      size: stat.size,
      projectSlug: slug,
      projectLabel: meta.cwd || slugToLabel(slug),
      file,
      cwdExists,
      favorite: favorites.has(id),
    };
  });

  // Sort newest-first. Favorites are surfaced via a separate group in the UI,
  // so we keep the base order purely chronological here (single source of truth
  // for "recent"); callers/UI decide how to present favorites.
  return sessions
    .filter((s) => s !== null)
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * @typedef {import('./scanner.js').Session & {
 *   activity: string,
 *   active: boolean,
 *   status: string,
 *   model: string|null,
 *   tokens: { input:number, output:number, cacheCreation:number, cacheRead:number },
 *   totalTokens: number,
 *   costUSD: number,
 *   cacheHitRate: number,
 *   messages: number,
 *   durationMs: number,
 *   modifiedFiles: string[],
 *   recentMessages: {role:string,text:string,ts:number}[],
 * }} MonitorSession
 */

/** A module-level cache so repeated scans (the realtime loop) stay incremental. */
const sharedMetricsCache = new MetricsCache();

/**
 * Like {@link scanSessions} but enriches every session with realtime metrics
 * (tokens, estimated cost, cache hit-rate, activity/status, modified files).
 * Uses an incremental byte-offset cache, so calling it on a tight loop only
 * re-reads the bytes appended since the previous call.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dir]          override projects dir (testing)
 * @param {number} [opts.concurrency]
 * @param {MetricsCache} [opts.cache]  override the shared metrics cache (testing)
 * @param {number} [opts.now]          epoch ms used to resolve activity (testing)
 * @returns {Promise<{ sessions: MonitorSession[], systemStats: SystemStats }>}
 */
export async function scanMetrics(opts = {}) {
  const base = await scanSessions({ dir: opts.dir, concurrency: opts.concurrency });
  const cache = opts.cache || sharedMetricsCache;
  const now = opts.now || Date.now();

  const seen = new Set();
  const sessions = await mapLimit(base, opts.concurrency || DEFAULT_CONCURRENCY, async (s) => {
    seen.add(s.file);
    const m = await cache.get(s.file);
    const totalTokens = m.tokens.input + m.tokens.output + m.tokens.cacheCreation + m.tokens.cacheRead;
    const cacheDenom = m.tokens.cacheRead + m.tokens.input;
    return {
      ...s,
      activity: resolveActivity(m, now),
      active: isActive(m, now),
      status: m.status,
      model: m.model,
      tokens: m.tokens,
      totalTokens,
      costUSD: m.costUSD,
      cacheHitRate: cacheDenom > 0 ? m.tokens.cacheRead / cacheDenom : 0,
      messages: m.totalMessages,
      durationMs: m.firstActivityMs && m.lastActivityMs ? m.lastActivityMs - m.firstActivityMs : 0,
      modifiedFiles: m.modifiedFiles,
      recentMessages: m.recentMessages,
    };
  });

  cache.prune(seen);

  // Active sessions float to the top (most recent first); the rest follow by mtime.
  sessions.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b.mtime - a.mtime;
  });

  return { sessions, systemStats: computeSystemStats(sessions) };
}

/**
 * Tokens-over-time chart data for ONE conversation file, bucketed server-side
 * (so the live snapshot stays small — we never ship raw per-entry series to the
 * client). Reuses the shared incremental metrics cache.
 * @param {string} file  absolute path to the .jsonl
 * @param {Object} [opts]
 * @param {number} [opts.buckets=32]
 * @param {MetricsCache} [opts.cache]
 * @returns {Promise<{ ts: number[], tokens: number[] }>}
 */
export async function sessionTokenChart(file, opts = {}) {
  const cache = opts.cache || sharedMetricsCache;
  const m = await cache.get(file);
  return bucketTokenSeries(m.tokenSeries, opts.buckets || 32);
}

/**
 * @typedef {Object} SystemStats
 * @property {number} activeSessions
 * @property {number} totalSessions
 * @property {number} totalMessages
 * @property {number} tokensUsed
 * @property {number} totalCost
 * @property {number} avgDurationMs
 * @property {string|null} topModel
 * @property {{model:string, tokens:number, costUSD:number}[]} byModel  token/cost grouped by model, desc by tokens
 */

/** @param {MonitorSession[]} sessions @returns {SystemStats} */
function computeSystemStats(sessions) {
  let totalMessages = 0;
  let tokensUsed = 0;
  let totalCost = 0;
  let durationSum = 0;
  let durationCount = 0;
  let activeSessions = 0;
  /** @type {Map<string, { tokens: number, costUSD: number }>} */
  const modelTotals = new Map();

  for (const s of sessions) {
    totalMessages += s.messages;
    tokensUsed += s.totalTokens;
    totalCost += s.costUSD;
    if (s.durationMs > 0) { durationSum += s.durationMs; durationCount += 1; }
    if (s.active) activeSessions += 1;
    if (s.model) {
      const t = modelTotals.get(s.model) || { tokens: 0, costUSD: 0 };
      t.tokens += s.totalTokens;
      t.costUSD += s.costUSD;
      modelTotals.set(s.model, t);
    }
  }

  // Token/cost breakdown by model, biggest first (for the Monitor donut).
  const byModel = [...modelTotals.entries()]
    .map(([model, t]) => ({ model, tokens: t.tokens, costUSD: t.costUSD }))
    .sort((a, b) => b.tokens - a.tokens);

  const topModel = byModel.length ? byModel[0].model : null;

  return {
    activeSessions,
    totalSessions: sessions.length,
    totalMessages,
    tokensUsed,
    totalCost,
    avgDurationMs: durationCount > 0 ? durationSum / durationCount : 0,
    topModel,
    byModel,
  };
}

/**
 * Of several recordings of the SAME conversation UUID (the worktree case —
 * Claude Code leaves the session file under both the main repo's slug and the
 * worktree's slug), pick the one most worth resuming: a live folder beats a
 * `(missing)` one, then the bigger file (the real transcript beats a tiny
 * worktree stub), then the most recently touched.
 * @param {Session[]} dupes
 * @returns {Session}
 */
function preferReal(dupes) {
  return [...dupes].sort((a, b) => {
    if (a.cwdExists !== b.cwdExists) return a.cwdExists ? -1 : 1;
    if (a.size !== b.size) return b.size - a.size;
    return b.mtime - a.mtime;
  })[0];
}

/**
 * Find one session by exact id, or by unambiguous id prefix.
 *
 * The same UUID can legitimately appear under two project slugs (a session
 * started in a git worktree, then continued in the main repo). So `id` is NOT
 * a unique key. When a query lands on several recordings of the *same* UUID we
 * auto-prefer the live/real one (see {@link preferReal}); we only report
 * `ambiguous` when the matches are genuinely *different* conversations. Pass
 * `opts.slug` (exact or substring) to pin a specific copy.
 *
 * @param {Session[]} sessions
 * @param {string} idOrPrefix
 * @param {Object} [opts]
 * @param {string} [opts.slug]  restrict to sessions whose projectSlug matches
 *                              (exact, else case-insensitive substring)
 * @returns {{ match: Session|null, ambiguous: Session[] }}
 */
export function findSession(sessions, idOrPrefix, opts = {}) {
  let pool = sessions;
  if (opts.slug) {
    const exactSlug = pool.filter((s) => s.projectSlug === opts.slug);
    const slugQ = opts.slug.toLowerCase();
    pool = exactSlug.length
      ? exactSlug
      : pool.filter((s) => s.projectSlug.toLowerCase().includes(slugQ));
  }

  // Exact-id matches first; then fall back to prefix matches.
  let hits = pool.filter((s) => s.id === idOrPrefix);
  if (hits.length === 0) hits = pool.filter((s) => s.id.startsWith(idOrPrefix));

  if (hits.length === 0) return { match: null, ambiguous: [] };
  if (hits.length === 1) return { match: hits[0], ambiguous: [] };

  // Multiple hits: only truly ambiguous if they're different conversations.
  const distinctIds = new Set(hits.map((s) => s.id));
  if (distinctIds.size === 1) return { match: preferReal(hits), ambiguous: [] };
  return { match: null, ambiguous: hits };
}

/**
 * Simple case-insensitive substring search across title, project and branch.
 * @param {Session[]} sessions
 * @param {string} query
 * @returns {Session[]}
 */
export function searchSessions(sessions, query) {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  const terms = q.split(/\s+/);
  return sessions.filter((s) => {
    const hay = `${s.title} ${s.projectLabel} ${s.branch || ''} ${s.id}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/**
 * Apply structured filters shared by CLI and agent.
 * @param {Session[]} sessions
 * @param {Object} [opts]
 * @param {number} [opts.recentDays]   keep only sessions touched within N days
 * @param {string} [opts.branch]       keep only sessions on this exact branch
 * @param {boolean} [opts.favoritesOnly] keep only favorited sessions
 * @param {boolean} [opts.hideOrphans] drop sessions whose cwd is gone
 * @returns {Session[]}
 */
export function filterSessions(sessions, opts = {}) {
  let out = sessions;
  if (opts.favoritesOnly) out = out.filter((s) => s.favorite);
  if (opts.hideOrphans) out = out.filter((s) => s.cwdExists);
  if (opts.branch) out = out.filter((s) => s.branch === opts.branch);
  if (Number.isFinite(opts.recentDays) && opts.recentDays > 0) {
    const cutoff = Date.now() - opts.recentDays * 86400_000;
    out = out.filter((s) => s.mtime >= cutoff);
  }
  return out;
}
