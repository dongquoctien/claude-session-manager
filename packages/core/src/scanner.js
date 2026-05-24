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
 * Find one session by exact id, or by unambiguous id prefix.
 * @param {Session[]} sessions
 * @param {string} idOrPrefix
 * @returns {{ match: Session|null, ambiguous: Session[] }}
 */
export function findSession(sessions, idOrPrefix) {
  const exact = sessions.find((s) => s.id === idOrPrefix);
  if (exact) return { match: exact, ambiguous: [] };
  const pref = sessions.filter((s) => s.id.startsWith(idOrPrefix));
  if (pref.length === 1) return { match: pref[0], ambiguous: [] };
  if (pref.length > 1) return { match: null, ambiguous: pref };
  return { match: null, ambiguous: [] };
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
