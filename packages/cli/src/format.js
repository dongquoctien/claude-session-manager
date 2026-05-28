// Tiny formatting helpers for the CLI. No external deps; ANSI colors are
// disabled automatically when output is not a TTY or NO_COLOR is set.

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

/** @param {number} code @param {string} s */
const wrap = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  dim: (s) => wrap(2, s),
  bold: (s) => wrap(1, s),
  cyan: (s) => wrap(36, s),
  green: (s) => wrap(32, s),
  yellow: (s) => wrap(33, s),
  red: (s) => wrap(31, s),
  magenta: (s) => wrap(35, s),
  white: (s) => wrap('97', s), // bright white — for values that should stand out
};

/** Whether ANSI styling is active (mirrors the c.* helpers). */
export const colorEnabled = useColor;

/**
 * Paint a string with explicit SGR codes that DON'T reset until the very end —
 * needed for full-row backgrounds (zebra striping), where a per-cell reset
 * would tear a hole in the row's background.
 * @param {string} s
 * @param {number[]} codes  SGR numbers, e.g. [48,5,236] for a 256-color bg
 */
export function sgr(s, codes) {
  if (!useColor || !codes.length) return s;
  return `\x1b[${codes.join(';')}m${s}`;
}
const RESET = useColor ? '\x1b[0m' : '';
export { RESET };

/**
 * Color a cost value by magnitude so expensive sessions jump out.
 * @param {number} usd @param {string} text  pre-formatted "$x.xx"
 */
export function colorCost(usd, text) {
  if (usd >= 500) return c.red(text);
  if (usd >= 100) return c.yellow(text);
  return text;
}

/**
 * Color a cache-hit rate: only flag LOW rates (they cost real money), keep
 * the common 100% dim so the eye skips it.
 * @param {number} rate 0..1 @param {string} text  pre-formatted "xx%"
 */
export function colorCache(rate, text) {
  if (rate < 0.9) return c.red(text);
  if (rate < 0.98) return c.yellow(text);
  return c.dim(text);
}

/**
 * Color a token total by magnitude: big consumers brighter.
 * @param {number} tokens @param {string} text  pre-formatted "x.xM"
 */
export function colorTokens(tokens, text) {
  if (tokens >= 1e9) return c.bold(c.white(text));
  if (tokens >= 1e8) return c.white(text);
  return text;
}

/**
 * Human "x ago" from an epoch-ms timestamp.
 * @param {number} ms
 * @returns {string}
 */
export function timeAgo(ms) {
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** @param {number} bytes */
export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Compact token count: 1234 -> "1.2K", 11200000 -> "11.2M". @param {number} n */
export function humanTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/** USD with a leading $ and 2 decimals. @param {number} n */
export function humanCost(n) {
  return `$${n.toFixed(2)}`;
}

/** Duration from ms: "1h 43m", "5m", "12s". @param {number} ms */
export function humanDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

/** Color an activity label by kind. @param {string} activity */
export function colorActivity(activity) {
  switch (activity) {
    case 'idle': return c.dim(activity);
    case 'waiting': return c.yellow(activity);
    case 'thinking': return c.cyan(activity);
    case 'writing': return c.green(activity);
    case 'reading': return c.cyan(activity);
    case 'searching': return c.magenta(activity);
    case 'running': return c.green(activity);
    case 'browsing': return c.magenta(activity);
    case 'spawning': return c.yellow(activity);
    default: return activity;
  }
}

/**
 * Render a list of sessions grouped by project folder.
 * @param {import('@csm/core').Session[]} sessions
 */
export function renderGrouped(sessions) {
  /** @type {Map<string, import('@csm/core').Session[]>} */
  const groups = new Map();
  for (const s of sessions) {
    const key = s.projectLabel;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  // Order groups by their most-recent session.
  const ordered = [...groups.entries()].sort(
    (a, b) => Math.max(...b[1].map((s) => s.mtime)) - Math.max(...a[1].map((s) => s.mtime)),
  );

  const lines = [];
  for (const [label, items] of ordered) {
    const orphan = items[0] && !items[0].cwdExists ? c.red(' (missing)') : '';
    lines.push('');
    lines.push(c.bold(c.cyan(`▌ ${label}`)) + orphan);
    for (const s of items) {
      lines.push(renderRow(s));
    }
  }
  return lines.join('\n');
}

/** @param {import('@csm/core').Session} s */
export function renderRow(s) {
  const id = c.dim(s.id.slice(0, 8));
  const star = s.favorite ? c.yellow('★ ') : '';
  const branch = s.branch ? c.magenta(s.branch) : c.dim('—');
  const when = c.dim(timeAgo(s.mtime));
  const titleSrc =
    s.titleSource === 'aiTitle' ? '' : c.dim(` ·${s.titleSource}`);
  return `  ${id}  ${star}${s.title}${titleSrc}\n            ${branch}  ${when}`;
}
