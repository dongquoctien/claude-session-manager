import fs from 'node:fs';
import readline from 'node:readline';

/**
 * Max lines to read from the head of a .jsonl before giving up looking for
 * metadata. Measured: aiTitle appears at line index <=182 across real data,
 * so 250 is a safe ceiling that still bounds work on 50MB+ files.
 */
const MAX_HEAD_LINES = 250;

/** Bytes to read from the tail when looking for the most recent gitBranch. */
const TAIL_BYTES = 96 * 1024;

/**
 * The git branch a conversation is "on" can change over its life (the user
 * checks out other branches mid-session). Claude Code's own /resume picker
 * shows the LATEST branch, but that record can be thousands of lines in — far
 * past the head scan. So read just the tail of the file and return the last
 * gitBranch seen there. Returns null if none found in the tail.
 * @param {string} filePath
 * @param {number} fileSize
 * @returns {Promise<string|null>}
 */
function readTailBranch(filePath, fileSize) {
  return new Promise((resolve) => {
    if (fileSize <= 0) return resolve(null);
    const start = Math.max(0, fileSize - TAIL_BYTES);
    let buf = '';
    let stream;
    try {
      stream = fs.createReadStream(filePath, { encoding: 'utf8', start });
    } catch {
      return resolve(null);
    }
    stream.on('data', (chunk) => { buf += chunk; });
    stream.on('error', () => resolve(null));
    stream.on('end', () => {
      let branch = null;
      // Scan complete lines; the first chunk may start mid-line, that's fine —
      // JSON.parse just fails on it and we skip. Walk lines in order so the
      // last valid gitBranch wins (most recent).
      for (const line of buf.split('\n')) {
        if (!line || line.indexOf('gitBranch') === -1) continue;
        try {
          const d = JSON.parse(line);
          if (d && typeof d.gitBranch === 'string' && d.gitBranch) branch = d.gitBranch;
        } catch { /* partial/garbage line — skip */ }
      }
      resolve(branch);
    });
  });
}

/**
 * @typedef {Object} RawMeta
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
      // The branch from the head is the OLDEST one; the conversation may have
      // switched branches later. Prefer the latest branch from the tail so we
      // match Claude Code's /resume picker. Only the tail read is extra work,
      // and only when the file is bigger than the head we already scanned.
      readTailBranch(filePath, fileSize).then((tailBranch) => {
        if (tailBranch) meta.gitBranch = tailBranch;
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

      // aiTitle is the strongest signal; capture the first one seen.
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
