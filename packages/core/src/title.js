/**
 * Collapse whitespace/newlines and trim a candidate title to one short line.
 * @param {string} s
 * @param {number} [max=80]
 * @returns {string}
 */
export function oneLine(s, max = 80) {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Resolve a human-readable title for a conversation using a 4-tier fallback,
 * since ~30% of conversations have no aiTitle.
 *
 *   1. aiTitle        (best — AI-generated)
 *   2. lastPrompt     (most recent prompt, truncated)
 *   3. firstUserText  (first human message, truncated)
 *   4. "Untitled · <date>"
 *
 * @param {import('./parser.js').RawMeta} meta
 * @param {Date|number} mtime fallback date for tier 4
 * @returns {{ title: string, source: 'aiTitle'|'lastPrompt'|'firstUser'|'fallback' }}
 */
export function resolveTitle(meta, mtime) {
  if (meta.aiTitle) {
    return { title: oneLine(meta.aiTitle), source: 'aiTitle' };
  }
  if (meta.lastPrompt) {
    return { title: oneLine(meta.lastPrompt), source: 'lastPrompt' };
  }
  if (meta.firstUserText) {
    return { title: oneLine(meta.firstUserText), source: 'firstUser' };
  }
  const d = mtime instanceof Date ? mtime : new Date(mtime);
  const date = Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  return { title: `Untitled · ${date}`.trim(), source: 'fallback' };
}
