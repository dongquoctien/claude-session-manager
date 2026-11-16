import fs from 'node:fs';
import readline from 'node:readline';

/**
 * Max lines to read from the head of a .jsonl before giving up looking for
 * metadata. Measured: aiTitle appears at line index <=182 across real data,
 * so 250 is a safe ceiling that still bounds work on 50MB+ files.
 */
const MAX_HEAD_LINES = 250;

/**
 * Bytes to read from the tail when looking for the most recent gitBranch and
 * `/rename` title. Measured on real data: Claude Code re-appends the
 * `custom-title` record every few turns, and the last one sat at most ~33KB
 * from EOF (26 renamed sessions, files up to 600MB), so 96KB has headroom.
 */
const TAIL_BYTES = 96 * 1024;

/**
 * The user's `/rename` title, from a `{"type":"custom-title","customTitle":…}`
 * record. Returns `undefined` when the line is not such a record, `null` when
 * it is but the title is blank (treated as "name cleared").
 * @param {*} d parsed .jsonl line
 * @returns {string|null|undefined}
 */
function customTitleOf(d) {
  if (!d || d.type !== 'custom-title' || typeof d.customTitle !== 'string') return undefined;
  return d.customTitle.trim() || null;
}

/**
 * Two things a conversation can change over its life, whose LATEST value
 * Claude Code's own /resume picker shows, and whose records can sit thousands
 * of lines in — far past the head scan:
 *  - the git branch (the user checks out other branches mid-session);
 *  - the `/rename` title (`custom-title` records; renaming again appends a new
 *    one, and Claude Code keeps re-appending the current one near the end).
 * So read just the tail of the file and return the last value of each seen
 * there. `branch` is null and `customTitle` is undefined when the tail has none.
 * @param {string} filePath
 * @param {number} fileSize
 * @returns {Promise<{ branch: string|null, customTitle: string|null|undefined }>}
 */
function readTail(filePath, fileSize) {
  return new Promise((resolve) => {
    /** @type {{ branch: string|null, customTitle: string|null|undefined }} */
    const found = { branch: null, customTitle: undefined };
    if (fileSize <= 0) return resolve(found);
    const start = Math.max(0, fileSize - TAIL_BYTES);
    let buf = '';
    let stream;
    try {
      stream = fs.createReadStream(filePath, { encoding: 'utf8', start });
    } catch {
      return resolve(found);
    }
    stream.on('data', (chunk) => { buf += chunk; });
    stream.on('error', () => resolve(found));
    stream.on('end', () => {
      // Scan complete lines; the first chunk may start mid-line, that's fine —
      // JSON.parse just fails on it and we skip. Walk lines in order so the
      // last valid value of each wins (most recent).
      for (const line of buf.split('\n')) {
        if (!line) continue;
        const hasBranch = line.indexOf('gitBranch') !== -1;
        const hasTitle = line.indexOf('"custom-title"') !== -1;
        if (!hasBranch && !hasTitle) continue;
        try {
          const d = JSON.parse(line);
          if (d && typeof d.gitBranch === 'string' && d.gitBranch) found.branch = d.gitBranch;
          const t = customTitleOf(d);
          if (t !== undefined) found.customTitle = t;
        } catch { /* partial/garbage line — skip */ }
      }
      resolve(found);
    });
  });
}

/**
 * @typedef {Object} RawMeta
 * @property {string|null} customTitle    the user's latest `/rename` title
 * @property {string|null} aiTitle
 * @property {string|null} cwd
 * @property {string|null} gitBranch
 * @property {string|null} lastPrompt
 * @property {string|null} summary
 * @property {string|null} firstUserText  first human message, for title fallback
 * @property {string|null} version         Claude Code version that wrote it
 */

/**
 * Stream the head of a conversation .jsonl and extract just the metadata we
 * need for the picker. Never loads the whole file. Tolerant of malformed
 * lines and unknown record types (forward-compatible).
 *
 * @param {string} filePath absolute path to <sessionId>.jsonl
 * @returns {Promise<RawMeta>}
 */
export function parseHead(filePath) {
  return new Promise((resolve) => {
    /** @type {RawMeta} */
    const meta = {
      customTitle: null,
      aiTitle: null,
      cwd: null,
      gitBranch: null,
      lastPrompt: null,
      summary: null,
      firstUserText: null,
      version: null,
    };

    let fileSize = 0;
    try {
      fileSize = fs.statSync(filePath).size;
    } catch { /* ignore */ }

    let stream;
    try {
      stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    } catch {
      resolve(meta);
      return;
    }

    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineNo = 0;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      rl.close();
      stream.destroy();
      // The branch and /rename title from the head are the OLDEST ones; the
      // conversation may have switched branches or been renamed later. Prefer
      // the latest values from the tail so we match Claude Code's /resume
      // picker. The head value stays as a fallback when the tail has none.
      readTail(filePath, fileSize).then((tail) => {
        if (tail.branch) meta.gitBranch = tail.branch;
        if (tail.customTitle !== undefined) meta.customTitle = tail.customTitle;
        resolve(meta);
      });
    };

    rl.on('line', (line) => {
      if (done) return;
      lineNo += 1;
      if (lineNo > MAX_HEAD_LINES) {
        finish();
        return;
      }
      if (!line) return;

      let d;
      try {
        d = JSON.parse(line);
      } catch {
        return; // skip malformed line, keep going
      }
      if (!d || typeof d !== 'object') return;

      // /rename title: keep the LATEST one seen (renaming appends a new record).
      // The tail read overrides this; the head copy covers a rename made at
      // startup in a file whose tail has none.
      const ct = customTitleOf(d);
      if (ct !== undefined) meta.customTitle = ct;

      // aiTitle (AI-generated name): capture the first one seen.
      if (meta.aiTitle == null && typeof d.aiTitle === 'string') {
        meta.aiTitle = d.aiTitle.trim() || null;
      }
      // lastPrompt: keep the LATEST one (most recent prompt), so don't lock it.
      if (typeof d.lastPrompt === 'string' && d.lastPrompt.trim()) {
        meta.lastPrompt = d.lastPrompt.trim();
      }
      if (meta.cwd == null && typeof d.cwd === 'string' && d.cwd) {
        meta.cwd = d.cwd;
      }
      if (meta.gitBranch == null && typeof d.gitBranch === 'string' && d.gitBranch) {
        meta.gitBranch = d.gitBranch;
      }
      if (meta.version == null && typeof d.version === 'string') {
        meta.version = d.version;
      }
      if (meta.summary == null && d.type === 'summary' && typeof d.summary === 'string') {
        meta.summary = d.summary.trim() || null;
      }
      if (meta.firstUserText == null && d.type === 'user') {
        const text = extractUserText(d.message);
        if (text) meta.firstUserText = text;
      }

      // Early exit once we have everything we render, INCLUDING lastPrompt
      // (used for the preview). lastPrompt usually appears by ~line 16, well
      // before MAX_HEAD_LINES, so requiring it here still stops large files
      // quickly without scanning to the end.
      if (
        meta.aiTitle &&
        meta.cwd &&
        meta.gitBranch &&
        meta.firstUserText &&
        meta.lastPrompt
      ) {
        finish();
      }
    });

    rl.on('close', finish);
    rl.on('error', finish);
    stream.on('error', finish);
  });
}

/**
 * Harness-injected wrappers that are not real user text. We skip messages that
 * start with these so titles reflect what the human actually typed.
 */
const HARNESS_PREFIXES = [
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<system-reminder>',
  'Caveat: The messages below',
];

/** @param {string} t @returns {boolean} */
function looksLikeHarnessText(t) {
  return HARNESS_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * Pull plain text out of a user message, whose `content` may be a string or
 * an array of content blocks. Returns null for harness-injected wrappers so
 * they don't end up as conversation titles.
 * @param {*} message
 * @returns {string|null}
 */
function extractUserText(message) {
  if (!message || typeof message !== 'object') return null;
  const c = message.content;
  if (typeof c === 'string') {
    const t = c.trim();
    return t && !looksLikeHarnessText(t) ? t : null;
  }
  if (Array.isArray(c)) {
    for (const blk of c) {
      if (blk && typeof blk === 'object' && blk.type === 'text' && typeof blk.text === 'string') {
        const t = blk.text.trim();
        if (t && !looksLikeHarnessText(t)) return t;
      }
    }
  }
  return null;
}

export { MAX_HEAD_LINES };
