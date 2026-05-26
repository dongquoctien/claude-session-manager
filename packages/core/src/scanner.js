import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { projectsDir, slugToLabel } from './paths.js';
import { parseHead } from './parser.js';
import { resolveTitle } from './title.js';
import { favoriteSet } from './state.js';

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
