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
 * Resolve a human-readable title for a conversation using a 5-tier fallback,
 * since ~30% of conversations have no aiTitle.
 *
 *   1. customName    (user's own `/rename`, from ~/.claude/sessions — beats all)
 *   2. aiTitle       (AI-generated)
 *   3. lastPrompt    (most recent prompt, truncated)
 *   4. firstUserText (first human message, truncated)
 *   5. "Untitled · <date>"
 *
 * `customName` is passed in by the scanner (it lives outside the .jsonl, keyed
 * by sessionId — see {@link import('./sessionNames.js')}), so it's an explicit
 * argument rather than a field on `meta`.
 *
 * @param {import('./parser.js').RawMeta} meta
 * @param {Date|number} mtime fallback date for the last tier
 * @param {string|null} [customName]  user-set name via Claude Code's /rename
 * @returns {{ title: string, source: 'customName'|'aiTitle'|'lastPrompt'|'firstUser'|'fallback' }}
 */
export function resolveTitle(meta, mtime, customName = null) {
  if (customName) {
    const t = oneLine(customName);
    if (t) return { title: t, source: 'customName' };
  }
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
