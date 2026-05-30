import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Office "agent chatter": short, fun water-cooler lines the avatars buzz in
 * speech bubbles. Generated on demand by the local `claude` CLI (one-shot,
 * `claude -p`) in four languages, so the office feels alive and multilingual.
 *
 * This module only PRODUCES the line pool; the UI picks/rotates lines. If
 * `claude` isn't installed or errors, the generator returns null and the UI
 * falls back to its own static pool — the feature degrades gracefully.
 *
 * IMPORTANT: `claude -p` writes a transcript under its CLAUDE_CONFIG_DIR. We
 * point the child at an isolated throwaway dir so it never litters the user's
 * real ~/.claude/projects (which this app scans and would otherwise surface the
 * generation turn as a junk "agent").
 */

/** Languages we generate. Keys match the UI's detectLang() output. */
export const CHATTER_LANGS = Object.freeze(['en', 'ko', 'ja', 'vi']);

/** Lines longer than this are dropped (bubbles are small). */
const MAX_LINE_LEN = 70;
/** Per-language cap so one batch can't balloon the payload. Bumped from 20
 *  to 50 so a single live generation can give the UI a wider variety pool
 *  and the rotation feels less obviously repeating. */
const MAX_PER_LANG = 50;
/** Themes injected into the prompt at random so each generation pulls from
 *  a different angle of the dev workday — Claude is deterministic enough
 *  that a fixed prompt returns nearly identical batches each time. */
const CHATTER_THEMES = [
  'late-night debugging',
  'Friday deploy nerves',
  'code review banter',
  'merge conflict frustration',
  'tests randomly failing',
  'standup ramble',
  'caffeine and stack traces',
  'pair programming',
  'refactor rabbit holes',
  'production incident war room',
  'sprint planning chaos',
  'rubber duck conversations',
  'legacy code archaeology',
  'docs vs reality',
  'CI is red again',
  'imposter syndrome',
  'shipping at 5 pm',
  'feature flag confusion',
  'database migration anxiety',
  'on-call horror stories',
];

let _claudeBinCache; // undefined = not probed, string|null = result

/**
 * Resolve the `claude` CLI on PATH. Mirrors launcher.findWindowsTerminal():
 * trust `where.exe` / `which`'s exit status, not a stat check.
 * @returns {string|null} the bin name to spawn ('claude') or null if absent
 */
export function resolveClaudeBin() {
  if (_claudeBinCache !== undefined) return _claudeBinCache;
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const probe = spawnSync(finder, ['claude'], { encoding: 'utf8' });
    _claudeBinCache = probe.status === 0 ? 'claude' : null;
  } catch {
    _claudeBinCache = null;
  }
  return _claudeBinCache;
}

/** The instruction we hand to `claude -p`. Asks for strict JSON, no prose.
 *  Pulls in a random pair of CHATTER_THEMES so each call returns a fresh
 *  batch — without the variation the model returns nearly identical lines
 *  every time the prompt is asked. */
function buildPrompt() {
  // Pick two distinct themes so each generation has a clear angle.
  const pool = CHATTER_THEMES.slice();
  const idx1 = Math.floor(Math.random() * pool.length);
  const t1 = pool.splice(idx1, 1)[0];
  const t2 = pool[Math.floor(Math.random() * pool.length)];
  return [
    'You are seeding flavor text for a playful "AI office" visualization where',
    'cartoon dev agents chat in speech bubbles. Output ONLY a JSON object, no',
    'prose, no markdown fences. Shape:',
    '{"en":[...],"ko":[...],"ja":[...],"vi":[...]}',
    'Each array: 24 short water-cooler one-liners in that language (English,',
    'Korean, Japanese, Vietnamese). Tone: software coworkers — light teasing,',
    'self-deprecating, occasional praise or griping about code/PRs/tests/bugs/',
    'merge conflicts. Keep each line under 60 characters. No emoji. No real',
    'insults. Make each language idiomatic and natural, not translated word for',
    `word. Lean the batch into these moods: "${t1}" and "${t2}". Don't repeat`,
    'lines across languages — write each language fresh, not as a translation.',
    'Return the JSON object only.',
  ].join(' ');
}

/**
 * Pull the first balanced-looking JSON object out of arbitrary stdout and
 * validate it into a { lang: string[] } map. Exported for unit testing without
 * spawning a process.
 * @param {string} stdout
 * @returns {Record<string,string[]>|null} validated pool, or null if unusable
 */
export function parseChatter(stdout) {
  if (typeof stdout !== 'string') return null;
  // Grab the outermost { ... } block; `claude -p` may wrap it in stray text.
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj;
  try {
    obj = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  const out = {};
  for (const lang of CHATTER_LANGS) {
    const arr = obj[lang];
    if (!Array.isArray(arr)) continue;
    const clean = arr
      .filter((s) => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.length <= MAX_LINE_LEN)
      .slice(0, MAX_PER_LANG);
    if (clean.length) out[lang] = clean;
  }
  // Need at least one usable language, else treat as a failed generation.
  return Object.keys(out).length ? out : null;
}

/**
 * Generate a fresh chatter pool by invoking the local `claude` CLI once.
 * Never throws — returns null on any failure (missing bin, timeout, bad JSON).
 *
 * @param {Object} [opts]
 * @param {string|null} [opts.claudeBin]  bin to spawn; defaults to resolveClaudeBin()
 * @param {number} [opts.timeoutMs=20000] kill the child after this long
 * @returns {Promise<Record<string,string[]>|null>}
 */
export function generateChatter(opts = {}) {
  const claudeBin = opts.claudeBin !== undefined ? opts.claudeBin : resolveClaudeBin();
  const timeoutMs = opts.timeoutMs || 20000;
  if (!claudeBin) return Promise.resolve(null);

  // Isolated config dir so the child's transcript never lands in the user's
  // real ~/.claude/projects (which this app scans).
  let sandboxDir = null;
  try {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-chatter-'));
  } catch {
    sandboxDir = null; // fall through; worst case the child uses the default dir
  }
  const cleanup = () => {
    if (sandboxDir) { try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  };

  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; cleanup(); resolve(val); } };

    let child;
    try {
      // One-shot print mode: `claude -p "<prompt>" --output-format text`.
      // No --resume, so this starts a throwaway turn and exits. CLAUDE_CONFIG_DIR
      // is redirected to a sandbox so the turn isn't scanned as a real session.
      const env = { ...process.env };
      if (sandboxDir) env.CLAUDE_CONFIG_DIR = sandboxDir;
      child = spawn(claudeBin, ['-p', buildPrompt(), '--output-format', 'text'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env,
      });
    } catch {
      return finish(null);
    }

    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => finish(null));
    child.on('close', () => finish(parseChatter(out)));

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(null);
    }, timeoutMs);
    // Don't let the timer keep the event loop alive.
    if (timer.unref) timer.unref();
  });
}
