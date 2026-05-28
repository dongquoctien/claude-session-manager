import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

/**
 * Token/cost/activity metrics for a single conversation, derived by streaming
 * its .jsonl. Unlike parser.js (head+tail metadata only, for the picker), this
 * walks every entry to accumulate usage — so it uses an incremental byte-offset
 * cache (see {@link MetricsCache}) to stay fast on 50MB+ files and under a
 * realtime watch loop.
 *
 * Ported from lazyagent's internal/claude/jsonl.go + internal/core/activity.go.
 */

// --- model pricing --------------------------------------------------------

/**
 * USD per *million* tokens, by Claude model family. Claude Code's newer .jsonl
 * no longer records a `costUSD` field, so we compute cost from token usage.
 * Keyed by substring match against the model id (longest-match wins). Prices
 * are list prices; treat the result as an estimate.
 * @type {{ match: string, input: number, output: number, cacheWrite: number, cacheRead: number }[]}
 */
const PRICING = [
  { match: 'opus',   input: 15,   output: 75,   cacheWrite: 18.75, cacheRead: 1.5 },
  { match: 'sonnet', input: 3,    output: 15,   cacheWrite: 3.75,  cacheRead: 0.3 },
  { match: 'haiku',  input: 0.8,  output: 4,    cacheWrite: 1.0,   cacheRead: 0.08 },
];
const DEFAULT_PRICING = PRICING[0]; // opus — safest (highest) default

/** @param {string|null} model @returns {typeof DEFAULT_PRICING} */
function pricingFor(model) {
  if (!model) return DEFAULT_PRICING;
  const m = model.toLowerCase();
  for (const p of PRICING) if (m.includes(p.match)) return p;
  return DEFAULT_PRICING;
}

/**
 * Estimate cumulative cost (USD) from token counters and the model used.
 * @param {Tokens} t
 * @param {string|null} model
 * @returns {number}
 */
export function estimateCost(t, model) {
  const p = pricingFor(model);
  return (
    (t.input * p.input +
      t.output * p.output +
      t.cacheCreation * p.cacheWrite +
      t.cacheRead * p.cacheRead) /
    1_000_000
  );
}

// --- activity classification ----------------------------------------------

/** How long after the last entry a session is still considered "active". */
export const ACTIVE_WINDOW_MS = 60_000;
/** A tool activity stays visible this long after the last entry. */
const ACTIVITY_TIMEOUT_MS = 30_000;
/** "waiting" stays visible this long before falling back to idle. */
const WAITING_TIMEOUT_MS = 2 * 60_000;

export const Activity = Object.freeze({
  Idle: 'idle',
  Waiting: 'waiting',
  Thinking: 'thinking',
  Reading: 'reading',
  Writing: 'writing',
  Running: 'running',
  Searching: 'searching',
  Browsing: 'browsing',
  Spawning: 'spawning',
});

export const Status = Object.freeze({
  Unknown: 'unknown',
  Waiting: 'waiting',   // assistant responded, awaiting human
  Thinking: 'thinking', // assistant generating
  Tool: 'tool',         // tool invoked, awaiting result
  Idle: 'idle',
});

/**
 * Map a tool name to an activity kind. Claude Code uses PascalCase tool names.
 * @param {string} tool
 * @returns {string}
 */
export function toolActivity(tool) {
  switch (tool) {
    case 'Read': return Activity.Reading;
    case 'Write': case 'Edit': case 'NotebookEdit': return Activity.Writing;
    case 'Bash': return Activity.Running;
    case 'Glob': case 'Grep': return Activity.Searching;
    case 'WebFetch': case 'WebSearch': return Activity.Browsing;
    case 'Agent': case 'Task': return Activity.Spawning;
    default: return tool ? Activity.Running : Activity.Idle;
  }
}

/**
 * Resolve the display activity for a session from its metrics, as of `now`.
 * @param {Metrics} m
 * @param {number} [now] epoch ms
 * @returns {string}
 */
export function resolveActivity(m, now = Date.now()) {
  const last = m.lastActivityMs || 0;
  const since = now - last;

  // Most recent tool, if still within the activity window.
  const lastTool = m.recentTools[m.recentTools.length - 1];
  if (lastTool && lastTool.ts && now - lastTool.ts < ACTIVITY_TIMEOUT_MS) {
    return toolActivity(lastTool.name);
  }

  if (m.status === Status.Waiting) {
    return last && since < WAITING_TIMEOUT_MS ? Activity.Waiting : Activity.Idle;
  }

  if (!last || since > ACTIVITY_TIMEOUT_MS) return Activity.Idle;

  switch (m.status) {
    case Status.Thinking: return Activity.Thinking;
    case Status.Tool: return toolActivity(m.currentTool);
    default: return Activity.Idle;
  }
}

/** @param {Metrics} m @param {number} [now] @returns {boolean} */
export function isActive(m, now = Date.now()) {
  return now - (m.lastActivityMs || 0) < ACTIVE_WINDOW_MS;
}

// --- typedefs --------------------------------------------------------------

/**
 * @typedef {Object} Tokens
 * @property {number} input
 * @property {number} output
 * @property {number} cacheCreation
 * @property {number} cacheRead
 */

/**
 * @typedef {Object} Metrics
 * @property {Tokens} tokens
 * @property {number} costUSD          estimated, from tokens * model price
 * @property {string|null} model
 * @property {number} userMessages
 * @property {number} assistantMessages
 * @property {number} totalMessages
 * @property {string} status           Status.*
 * @property {string} currentTool      tool name if status === tool
 * @property {number} lastActivityMs   epoch ms of last entry with a timestamp
 * @property {number} firstActivityMs  epoch ms of first entry with a timestamp
 * @property {{name:string, ts:number}[]} recentTools  last ~20
 * @property {{role:string, text:string, ts:number}[]} recentMessages last ~10
 * @property {string[]} modifiedFiles  distinct files written/edited
 * @property {number[]} entryTimestamps epoch ms per entry (for charts), capped
 */

/** @returns {Metrics} */
function emptyMetrics() {
  return {
    tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    costUSD: 0,
    model: null,
    userMessages: 0,
    assistantMessages: 0,
    totalMessages: 0,
    status: Status.Unknown,
    currentTool: '',
    lastActivityMs: 0,
    firstActivityMs: 0,
    recentTools: [],
    recentMessages: [],
    modifiedFiles: [],
    entryTimestamps: [],
  };
}

// --- parsing ---------------------------------------------------------------

const HARNESS_PREFIXES = [
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<system-reminder>',
  'Caveat: The messages below',
];

/** @param {*} content @returns {string|null} first plain user/assistant text */
function firstText(content) {
  if (typeof content === 'string') {
    const t = content.trim();
    if (!t || HARNESS_PREFIXES.some((p) => t.startsWith(p))) return null;
    return t;
  }
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && b.type === 'text' && typeof b.text === 'string') {
        const t = b.text.trim();
        if (t && !HARNESS_PREFIXES.some((p) => t.startsWith(p))) return t;
      }
    }
  }
  return null;
}

/** @param {*} content @returns {boolean} whether this user content is a tool_result */
function isToolResult(content) {
  return Array.isArray(content) && content.some((b) => b && b.type === 'tool_result');
}

const MAX_RECENT_TOOLS = 20;
const MAX_RECENT_MESSAGES = 10;
const MAX_ENTRY_TIMESTAMPS = 1000;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

/**
 * Apply one parsed JSONL entry to the running metrics. Returns the timestamp
 * (epoch ms, or 0) and whether the entry was a meaningful user/assistant turn
 * that should set status.
 * @param {Metrics} m
 * @param {*} d  parsed JSON object for the line
 * @returns {{ ts: number, meaningful: *|null }}
 */
function applyEntry(m, d) {
  if (!d || typeof d !== 'object') return { ts: 0, meaningful: null };

  let ts = 0;
  if (typeof d.timestamp === 'string') {
    const parsed = Date.parse(d.timestamp);
    if (!Number.isNaN(parsed)) {
      ts = parsed;
      if (!m.firstActivityMs) m.firstActivityMs = ts;
      m.lastActivityMs = ts;
      m.entryTimestamps.push(ts);
    }
  }

  const type = d.type;
  if (type !== 'user' && type !== 'assistant') return { ts, meaningful: null };

  const msg = d.message;
  if (!msg || typeof msg !== 'object') return { ts, meaningful: null };

  // Accumulate token usage.
  const u = msg.usage;
  if (u && typeof u === 'object') {
    m.tokens.input += u.input_tokens || 0;
    m.tokens.output += u.output_tokens || 0;
    m.tokens.cacheCreation += u.cache_creation_input_tokens || 0;
    m.tokens.cacheRead += u.cache_read_input_tokens || 0;
  }

  if (type === 'user') {
    if (!isToolResult(msg.content)) {
      m.userMessages += 1;
      const text = firstText(msg.content);
      if (text) pushMessage(m, 'user', text, ts);
    }
    return { ts, meaningful: d };
  }

  // assistant
  m.assistantMessages += 1;
  if (typeof msg.model === 'string' && msg.model) m.model = msg.model;
  const text = firstText(msg.content);
  if (text) pushMessage(m, 'assistant', text, ts);

  if (Array.isArray(msg.content)) {
    for (const c of msg.content) {
      if (c && c.type === 'tool_use' && typeof c.name === 'string') {
        m.recentTools.push({ name: c.name, ts });
        if (m.recentTools.length > MAX_RECENT_TOOLS * 2) {
          m.recentTools = m.recentTools.slice(-MAX_RECENT_TOOLS);
        }
        if (WRITE_TOOLS.has(c.name)) {
          const fp = c.input && typeof c.input.file_path === 'string' ? c.input.file_path
            : c.input && typeof c.input.notebook_path === 'string' ? c.input.notebook_path
            : null;
          if (fp && !m.modifiedFiles.includes(fp)) m.modifiedFiles.push(fp);
        }
      }
    }
  }
  return { ts, meaningful: d };
}

function pushMessage(m, role, text, ts) {
  m.recentMessages.push({ role, text: text.length > 300 ? text.slice(0, 300) : text, ts });
  if (m.recentMessages.length > MAX_RECENT_MESSAGES * 2) {
    m.recentMessages = m.recentMessages.slice(-MAX_RECENT_MESSAGES);
  }
}

/**
 * Determine session status from the last meaningful (user/assistant) entry.
 * @param {*} last  parsed JSON of the last user/assistant entry, or null
 * @returns {{ status: string, currentTool: string }}
 */
function determineStatus(last) {
  if (!last) return { status: Status.Idle, currentTool: '' };
  const msg = last.message;
  const content = msg && msg.content;

  if (last.type === 'assistant') {
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c && c.type === 'tool_use') {
          return { status: Status.Tool, currentTool: typeof c.name === 'string' ? c.name : '' };
        }
      }
    }
    // Assistant text with no tool_use => turn finished, awaiting the human.
    return { status: Status.Waiting, currentTool: '' };
  }

  // last.type === 'user'
  if (isToolResult(content)) {
    // Tool result just came back; the assistant is processing it.
    return { status: Status.Thinking, currentTool: '' };
  }
  // A human prompt is the last thing on file => assistant is thinking.
  return { status: Status.Thinking, currentTool: '' };
}

/** Trim per-entry slices to their display caps once, after a full parse. */
function finalize(m) {
  if (m.recentTools.length > MAX_RECENT_TOOLS) m.recentTools = m.recentTools.slice(-MAX_RECENT_TOOLS);
  if (m.recentMessages.length > MAX_RECENT_MESSAGES) m.recentMessages = m.recentMessages.slice(-MAX_RECENT_MESSAGES);
  if (m.entryTimestamps.length > MAX_ENTRY_TIMESTAMPS) m.entryTimestamps = m.entryTimestamps.slice(-MAX_ENTRY_TIMESTAMPS);
  m.totalMessages = m.userMessages + m.assistantMessages;
  m.costUSD = estimateCost(m.tokens, m.model);
}

/**
 * Stream a conversation .jsonl from a byte offset and accumulate metrics.
 * Pass `prev` (a previously returned Metrics) + `offset` to resume incrementally.
 *
 * @param {string} filePath
 * @param {Object} [opts]
 * @param {Metrics} [opts.prev]    previous metrics to continue from
 * @param {number} [opts.offset]   byte offset to start reading at
 * @returns {Promise<{ metrics: Metrics, offset: number }>}  offset = bytes consumed
 */
export function parseMetrics(filePath, opts = {}) {
  return new Promise((resolve) => {
    const m = opts.prev ? cloneMetrics(opts.prev) : emptyMetrics();
    const start = opts.offset && opts.offset > 0 ? opts.offset : 0;

    let size = 0;
    try { size = fs.statSync(filePath).size; } catch { return resolve({ metrics: m, offset: start }); }
    if (size <= start) {
      finalize(m);
      return resolve({ metrics: m, offset: start });
    }

    let stream;
    try {
      stream = fs.createReadStream(filePath, { encoding: 'utf8', start });
    } catch {
      finalize(m);
      return resolve({ metrics: m, offset: start });
    }

    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let consumed = start;
    let lastMeaningful = m._lastMeaningful || null;

    rl.on('line', (line) => {
      // +1 for the newline that readline stripped. Good enough for an offset;
      // a partial final line during a concurrent write is re-read next pass.
      consumed += Buffer.byteLength(line, 'utf8') + 1;
      if (!line) return;
      let d;
      try { d = JSON.parse(line); } catch { return; }
      const { meaningful } = applyEntry(m, d);
      if (meaningful) lastMeaningful = meaningful;
    });

    const done = () => {
      const { status, currentTool } = determineStatus(lastMeaningful);
      m.status = status;
      m.currentTool = currentTool;
      // Stash the last meaningful entry so a later incremental pass can still
      // resolve status even if the new bytes had no user/assistant turn.
      Object.defineProperty(m, '_lastMeaningful', {
        value: lastMeaningful, enumerable: false, writable: true, configurable: true,
      });
      finalize(m);
      // Clamp to real size (newline accounting can overshoot the last line).
      let realSize = size;
      try { realSize = fs.statSync(filePath).size; } catch { /* keep */ }
      resolve({ metrics: m, offset: Math.min(consumed, realSize) });
    };

    rl.on('close', done);
    rl.on('error', done);
    stream.on('error', done);
  });
}

/** Deep-enough clone so an incremental pass never mutates the cached metrics. */
function cloneMetrics(m) {
  const c = {
    ...m,
    tokens: { ...m.tokens },
    recentTools: m.recentTools.slice(),
    recentMessages: m.recentMessages.slice(),
    modifiedFiles: m.modifiedFiles.slice(),
    entryTimestamps: m.entryTimestamps.slice(),
  };
  if (m._lastMeaningful) {
    Object.defineProperty(c, '_lastMeaningful', {
      value: m._lastMeaningful, enumerable: false, writable: true, configurable: true,
    });
  }
  return c;
}

// --- incremental cache -----------------------------------------------------

/**
 * Caches parsed metrics per file, keyed by path. On the next parse, only the
 * bytes appended since last time are read (unless the file shrank/was rewritten,
 * which forces a full re-parse). Mirrors lazyagent's SessionCache.
 */
export class MetricsCache {
  constructor() {
    /** @type {Map<string, { mtimeMs: number, size: number, offset: number, metrics: Metrics }>} */
    this.entries = new Map();
  }

  /**
   * Return metrics for `filePath`, parsing only what changed since last call.
   * @param {string} filePath
   * @returns {Promise<Metrics>}
   */
  async get(filePath) {
    let stat;
    try { stat = fs.statSync(filePath); } catch { this.entries.delete(filePath); return emptyMetrics(); }

    const prev = this.entries.get(filePath);
    // A full cache hit requires BOTH mtime and size unchanged: filesystem mtime
    // resolution can be coarse (or two writes can land in the same millisecond),
    // so a size change must invalidate the cache even when mtime looks equal.
    if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) {
      return prev.metrics; // unchanged — full cache hit
    }

    let resumeFrom;
    if (prev && stat.size > prev.offset && prev.offset > 0) {
      // File grew: continue from the cached offset.
      resumeFrom = { prev: prev.metrics, offset: prev.offset };
    } else {
      resumeFrom = {}; // new, shrunk, or rewritten -> full re-parse
    }

    const { metrics, offset } = await parseMetrics(filePath, resumeFrom);
    this.entries.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, offset, metrics });
    return metrics;
  }

  /** Drop entries for files not present in `seen` (a Set of paths). */
  prune(seen) {
    for (const k of this.entries.keys()) if (!seen.has(k)) this.entries.delete(k);
  }
}

export { emptyMetrics };
