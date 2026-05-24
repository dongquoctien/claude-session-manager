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
};

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
