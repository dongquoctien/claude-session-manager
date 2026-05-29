import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseMetrics,
  resolveActivity,
  estimateCost,
  toolActivity,
  isActive,
  bucketTokenSeries,
  MetricsCache,
  Activity,
  Status,
} from '../src/metrics.js';

/** Write lines to a throwaway .jsonl and return its path. */
function writeJsonl(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-metrics-'));
  const file = path.join(dir, 'conv.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

function appendJsonl(file, lines) {
  fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

const ISO = (s) => new Date(s).toISOString();

test('accumulates token usage across assistant entries', async () => {
  const file = writeJsonl([
    { type: 'user', timestamp: ISO('2026-05-19T10:00:00Z'), message: { role: 'user', content: 'hello' } },
    {
      type: 'assistant', timestamp: ISO('2026-05-19T10:00:02Z'),
      message: {
        role: 'assistant', model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 200 },
      },
    },
    {
      type: 'assistant', timestamp: ISO('2026-05-19T10:00:04Z'),
      message: {
        role: 'assistant', model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'more' }],
        usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 50 },
      },
    },
  ]);
  const { metrics } = await parseMetrics(file);
  assert.equal(metrics.tokens.input, 11);
  assert.equal(metrics.tokens.output, 7);
  assert.equal(metrics.tokens.cacheCreation, 100);
  assert.equal(metrics.tokens.cacheRead, 250);
  assert.equal(metrics.model, 'claude-opus-4-7');
  assert.equal(metrics.assistantMessages, 2);
  assert.equal(metrics.userMessages, 1);
  assert.equal(metrics.totalMessages, 3);
});

test('estimateCost uses model pricing (opus)', () => {
  // 1M input @ $15 + 1M output @ $75 = $90
  const cost = estimateCost({ input: 1_000_000, output: 1_000_000, cacheCreation: 0, cacheRead: 0 }, 'claude-opus-4-7');
  assert.equal(cost, 90);
});

test('estimateCost picks sonnet pricing', () => {
  // 1M input @ $3 = $3
  const cost = estimateCost({ input: 1_000_000, output: 0, cacheCreation: 0, cacheRead: 0 }, 'claude-sonnet-4-6');
  assert.equal(cost, 3);
});

test('cost is computed even without a costUSD field', async () => {
  const file = writeJsonl([
    {
      type: 'assistant', timestamp: ISO('2026-05-19T10:00:02Z'),
      message: {
        role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'x' }],
        usage: { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    },
  ]);
  const { metrics } = await parseMetrics(file);
  assert.equal(metrics.costUSD, 3);
});

test('status = tool + currentTool when last assistant invoked a tool', async () => {
  const file = writeJsonl([
    { type: 'user', timestamp: ISO('2026-05-19T10:00:00Z'), message: { role: 'user', content: 'go' } },
    {
      type: 'assistant', timestamp: ISO('2026-05-19T10:00:02Z'),
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
    },
  ]);
  const { metrics } = await parseMetrics(file);
  assert.equal(metrics.status, Status.Tool);
  assert.equal(metrics.currentTool, 'Bash');
});

test('status = waiting when last assistant entry is text only', async () => {
  const file = writeJsonl([
    { type: 'user', timestamp: ISO('2026-05-19T10:00:00Z'), message: { role: 'user', content: 'q' } },
    { type: 'assistant', timestamp: ISO('2026-05-19T10:00:02Z'), message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
  ]);
  const { metrics } = await parseMetrics(file);
  assert.equal(metrics.status, Status.Waiting);
});

test('resolveActivity maps recent Bash tool to running', () => {
  const now = Date.now();
  const m = {
    status: Status.Tool, currentTool: 'Bash',
    lastActivityMs: now - 1000,
    recentTools: [{ name: 'Bash', ts: now - 1000 }],
  };
  assert.equal(resolveActivity(m, now), Activity.Running);
});

test('resolveActivity falls back to idle after the timeout', () => {
  const now = Date.now();
  const m = {
    status: Status.Tool, currentTool: 'Bash',
    lastActivityMs: now - 5 * 60_000, // 5 min ago
    recentTools: [{ name: 'Bash', ts: now - 5 * 60_000 }],
  };
  assert.equal(resolveActivity(m, now), Activity.Idle);
});

test('toolActivity classifies the main tools', () => {
  assert.equal(toolActivity('Read'), Activity.Reading);
  assert.equal(toolActivity('Edit'), Activity.Writing);
  assert.equal(toolActivity('Grep'), Activity.Searching);
  assert.equal(toolActivity('WebSearch'), Activity.Browsing);
  assert.equal(toolActivity('Agent'), Activity.Spawning);
  assert.equal(toolActivity(''), Activity.Idle);
});

test('isActive reflects recency of last activity', () => {
  const now = Date.now();
  assert.equal(isActive({ lastActivityMs: now - 1000 }, now), true);
  assert.equal(isActive({ lastActivityMs: now - 120_000 }, now), false);
});

test('tracks modified files from Write/Edit tool_use', async () => {
  const file = writeJsonl([
    {
      type: 'assistant', timestamp: ISO('2026-05-19T10:00:02Z'),
      message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/a.js' } },
        { type: 'tool_use', name: 'Write', input: { file_path: '/repo/b.js' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/a.js' } }, // dup
      ] },
    },
  ]);
  const { metrics } = await parseMetrics(file);
  assert.deepEqual(metrics.modifiedFiles, ['/repo/a.js', '/repo/b.js']);
});

test('skips harness-wrapper text for recent messages', async () => {
  const file = writeJsonl([
    { type: 'user', timestamp: ISO('2026-05-19T10:00:00Z'), message: { role: 'user', content: '<system-reminder>noise</system-reminder>' } },
    { type: 'user', timestamp: ISO('2026-05-19T10:00:01Z'), message: { role: 'user', content: 'real question' } },
  ]);
  const { metrics } = await parseMetrics(file);
  const userMsgs = metrics.recentMessages.filter((x) => x.role === 'user');
  assert.equal(userMsgs.length, 1);
  assert.equal(userMsgs[0].text, 'real question');
});

test('incremental parse: appended lines accumulate, not double-count', async () => {
  const file = writeJsonl([
    {
      type: 'assistant', timestamp: ISO('2026-05-19T10:00:02Z'),
      message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'text', text: 'a' }],
        usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    },
  ]);
  const first = await parseMetrics(file);
  assert.equal(first.metrics.tokens.input, 100);

  appendJsonl(file, [
    {
      type: 'assistant', timestamp: ISO('2026-05-19T10:00:05Z'),
      message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'text', text: 'b' }],
        usage: { input_tokens: 50, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    },
  ]);
  const second = await parseMetrics(file, { prev: first.metrics, offset: first.offset });
  assert.equal(second.metrics.tokens.input, 150, 'should add 50, not re-read the first 100');
  assert.equal(second.metrics.assistantMessages, 2);
});

test('MetricsCache returns cached metrics when unchanged and updates on append', async () => {
  const file = writeJsonl([
    {
      type: 'assistant', timestamp: ISO('2026-05-19T10:00:02Z'),
      message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'text', text: 'a' }],
        usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    },
  ]);
  const cache = new MetricsCache();
  const m1 = await cache.get(file);
  assert.equal(m1.tokens.input, 10);
  const m2 = await cache.get(file); // unchanged -> same object
  assert.equal(m2, m1);

  appendJsonl(file, [
    {
      type: 'assistant', timestamp: ISO('2026-05-19T10:00:06Z'),
      message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'text', text: 'b' }],
        usage: { input_tokens: 7, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    },
  ]);
  const m3 = await cache.get(file);
  assert.equal(m3.tokens.input, 17);
});

test('cacheRead hit-rate inputs are summed correctly', async () => {
  const file = writeJsonl([
    {
      type: 'assistant', timestamp: ISO('2026-05-19T10:00:02Z'),
      message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'text', text: 'a' }],
        usage: { input_tokens: 6, output_tokens: 167, cache_creation_input_tokens: 20941, cache_read_input_tokens: 23932 } },
    },
  ]);
  const { metrics } = await parseMetrics(file);
  // hit-rate = cacheRead / (cacheRead + input)
  const rate = metrics.tokens.cacheRead / (metrics.tokens.cacheRead + metrics.tokens.input);
  assert.ok(rate > 0.99, `expected >0.99, got ${rate}`);
});

// --- tokenSeries + bucketTokenSeries (Monitor chart) -----------------------

test('records a per-entry tokenSeries point for each usage-bearing entry', async () => {
  const file = writeJsonl([
    { type: 'user', timestamp: ISO('2026-05-19T10:00:00Z'), message: { role: 'user', content: 'hi' } },
    {
      type: 'assistant', timestamp: ISO('2026-05-19T10:00:02Z'),
      message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'text', text: 'a' }],
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 } },
    },
    {
      type: 'assistant', timestamp: ISO('2026-05-19T10:05:00Z'),
      message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'text', text: 'b' }],
        usage: { input_tokens: 20, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    },
  ]);
  const { metrics } = await parseMetrics(file);
  assert.equal(metrics.tokenSeries.length, 2, 'only the 2 usage entries are recorded');
  assert.equal(metrics.tokenSeries[0].tokens, 115); // 10+5+0+100
  assert.equal(metrics.tokenSeries[1].tokens, 30);  // 20+10
  // sum of series == grand total tokens
  const seriesTotal = metrics.tokenSeries.reduce((n, p) => n + p.tokens, 0);
  const grand = metrics.tokens.input + metrics.tokens.output + metrics.tokens.cacheCreation + metrics.tokens.cacheRead;
  assert.equal(seriesTotal, grand);
});

test('incremental pass does not mutate the cached tokenSeries', async () => {
  const file = writeJsonl([
    {
      type: 'assistant', timestamp: ISO('2026-05-19T10:00:00Z'),
      message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'text', text: 'a' }],
        usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    },
  ]);
  const cache = new MetricsCache();
  const m1 = await cache.get(file);
  const len1 = m1.tokenSeries.length;
  // append a new usage entry, then re-read incrementally
  appendJsonl(file, [
    {
      type: 'assistant', timestamp: ISO('2026-05-19T10:01:00Z'),
      message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'text', text: 'b' }],
        usage: { input_tokens: 7, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    },
  ]);
  const m2 = await cache.get(file);
  // the first snapshot must NOT have grown (no shared-array mutation)
  assert.equal(m1.tokenSeries.length, len1, 'old snapshot tokenSeries must be untouched');
  assert.equal(m2.tokenSeries.length, len1 + 1);
});

test('bucketTokenSeries sums tokens into fixed time bins', () => {
  const base = Date.parse('2026-05-19T10:00:00Z');
  const series = [
    { ts: base, tokens: 100 },
    { ts: base + 1000, tokens: 50 },     // same early region
    { ts: base + 60_000, tokens: 200 },  // last point
  ];
  const { ts, tokens } = bucketTokenSeries(series, 4);
  assert.equal(ts.length, 4);
  assert.equal(tokens.length, 4);
  // total preserved
  assert.equal(tokens.reduce((a, b) => a + b, 0), 350);
  // first two points fall in the first bin, the last in the final bin
  assert.equal(tokens[0], 150);
  assert.equal(tokens[3], 200);
});

test('bucketTokenSeries returns empty arrays for too-little data', () => {
  assert.deepEqual(bucketTokenSeries([], 8), { ts: [], tokens: [] });
  assert.deepEqual(bucketTokenSeries([{ ts: 1, tokens: 5 }], 8), { ts: [], tokens: [] });
});
