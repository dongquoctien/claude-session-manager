import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { parseHead } from '../src/parser.js';

/** Write lines (each a JS object) as a temp .jsonl and return its path. */
function tmpJsonl(name, objects) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-test-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, objects.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n'));
  return file;
}

test('extracts aiTitle, cwd, branch from a normal conversation', async () => {
  const file = tmpJsonl('a.jsonl', [
    { type: 'last-prompt', lastPrompt: 'first prompt', sessionId: 'a' },
    { type: 'user', message: { content: 'hi' }, cwd: 'D:\\proj', gitBranch: 'main' },
    { type: 'ai-title', aiTitle: 'Nice Title', sessionId: 'a' },
    { type: 'assistant', message: { content: 'ok' } },
  ]);
  const m = await parseHead(file);
  assert.equal(m.aiTitle, 'Nice Title');
  assert.equal(m.cwd, 'D:\\proj');
  assert.equal(m.gitBranch, 'main');
  assert.equal(m.firstUserText, 'hi');
});

test('tolerates malformed lines and unknown types', async () => {
  const file = tmpJsonl('b.jsonl', [
    'not json at all',
    { type: 'mystery-future-type', foo: 1 },
    { type: 'user', message: { content: 'real question' }, cwd: 'C:\\x', gitBranch: 'dev' },
    '{ broken json',
  ]);
  const m = await parseHead(file);
  assert.equal(m.cwd, 'C:\\x');
  assert.equal(m.gitBranch, 'dev');
  assert.equal(m.firstUserText, 'real question');
});

test('ignores harness-injected text as firstUserText', async () => {
  const file = tmpJsonl('c.jsonl', [
    { type: 'user', message: { content: '<local-command-caveat>Caveat: ...' } },
    { type: 'user', message: { content: '<command-name>/foo</command-name>' } },
    { type: 'user', message: { content: 'actual human message' }, cwd: 'C:\\y' },
  ]);
  const m = await parseHead(file);
  assert.equal(m.firstUserText, 'actual human message');
});

test('reads aiTitle even when it appears deep in the file', async () => {
  const lines = [];
  for (let i = 0; i < 120; i++) lines.push({ type: 'assistant', message: { content: 'x' } });
  lines.unshift({ type: 'user', message: { content: 'q' }, cwd: 'C:\\z', gitBranch: 'b' });
  lines.push({ type: 'ai-title', aiTitle: 'Deep Title', sessionId: 'd' });
  const file = tmpJsonl('d.jsonl', lines);
  const m = await parseHead(file);
  assert.equal(m.aiTitle, 'Deep Title');
});

test('handles content as array of blocks', async () => {
  const file = tmpJsonl('e.jsonl', [
    { type: 'user', message: { content: [{ type: 'image' }, { type: 'text', text: 'block text' }] }, cwd: 'C:\\b' },
  ]);
  const m = await parseHead(file);
  assert.equal(m.firstUserText, 'block text');
});

test('uses the LATEST branch when the conversation switches branches', async () => {
  // Mirrors real data: a conversation that checked out several branches over
  // its life. /resume shows the latest; we must too (read from the tail).
  const lines = [
    { type: 'user', message: { content: 'start' }, cwd: 'D:\\proj', gitBranch: 'feature-old' },
    { type: 'ai-title', aiTitle: 'Long session' },
  ];
  for (let i = 0; i < 500; i++) lines.push({ type: 'assistant', message: { content: 'x'.repeat(50) }, gitBranch: 'feature-mid' });
  // the most recent activity is on a different branch
  lines.push({ type: 'assistant', message: { content: 'final' }, gitBranch: 'staging' });
  const file = tmpJsonl('switch.jsonl', lines);
  const m = await parseHead(file);
  assert.equal(m.gitBranch, 'staging', 'should report the latest branch, not the first');
});

test('falls back to head branch when tail has none', async () => {
  const file = tmpJsonl('headbranch.jsonl', [
    { type: 'user', message: { content: 'hi' }, cwd: 'C:\\p', gitBranch: 'only-branch' },
    { type: 'ai-title', aiTitle: 'T' },
  ]);
  const m = await parseHead(file);
  assert.equal(m.gitBranch, 'only-branch');
});

// --- /rename title (`custom-title` records) -------------------------------
// Claude Code's /rename appends {"type":"custom-title","customTitle":…} to the
// .jsonl, and keeps re-appending the current one near the end of the file.

test('no custom-title record -> customTitle is null', async () => {
  const file = tmpJsonl('noct.jsonl', [
    { type: 'user', message: { content: 'hi' }, cwd: 'C:\p', gitBranch: 'main' },
    { type: 'ai-title', aiTitle: 'AI name' },
  ]);
  const m = await parseHead(file);
  assert.equal(m.customTitle, null);
});

test('reads a custom-title written near the start (rename at startup)', async () => {
  const file = tmpJsonl('ct-head.jsonl', [
    { type: 'user', message: { content: 'hi' }, cwd: 'C:\p', gitBranch: 'main' },
    { type: 'custom-title', customTitle: '  Allotment Increase Automation ', sessionId: 's' },
    { type: 'agent-name', agentName: 'Allotment Increase Automation', sessionId: 's' },
    { type: 'assistant', message: { content: 'ok' } },
  ]);
  const m = await parseHead(file);
  assert.equal(m.customTitle, 'Allotment Increase Automation');
});

test('custom-title far past the head window is found in the tail', async () => {
  // Real data: the first rename record can be 88k lines in (way past
  // MAX_HEAD_LINES), but Claude Code re-appends it close to EOF.
  const lines = [
    { type: 'user', message: { content: 'start' }, cwd: 'D:\proj', gitBranch: 'main' },
    { type: 'ai-title', aiTitle: 'AI generated name' },
    { type: 'last-prompt', lastPrompt: 'p' },
  ];
  for (let i = 0; i < 2000; i++) lines.push({ type: 'assistant', message: { content: 'x'.repeat(80) } });
  lines.push({ type: 'custom-title', customTitle: 'VCC', sessionId: 's' });
  for (let i = 0; i < 20; i++) lines.push({ type: 'assistant', message: { content: 'y' } });
  const file = tmpJsonl('ct-deep.jsonl', lines);
  const m = await parseHead(file);
  assert.equal(m.aiTitle, 'AI generated name');
  assert.equal(m.customTitle, 'VCC');
});

test('renamed twice -> the LATEST custom-title wins', async () => {
  const lines = [
    { type: 'user', message: { content: 'hi' }, cwd: 'C:\p', gitBranch: 'main' },
    { type: 'custom-title', customTitle: 'RPA', sessionId: 's' },
    { type: 'assistant', message: { content: 'ok' } },
    { type: 'custom-title', customTitle: 'Plugin Angular', sessionId: 's' },
  ];
  const m = await parseHead(tmpJsonl('ct-twice.jsonl', lines));
  assert.equal(m.customTitle, 'Plugin Angular');

  // Same, but the second rename is beyond the head window: tail must win.
  const big = [lines[0], lines[1]];
  for (let i = 0; i < 2000; i++) big.push({ type: 'assistant', message: { content: 'x'.repeat(80) } });
  big.push(lines[3]);
  const m2 = await parseHead(tmpJsonl('ct-twice-big.jsonl', big));
  assert.equal(m2.customTitle, 'Plugin Angular');
});

test('a blank latest custom-title clears the name', async () => {
  const file = tmpJsonl('ct-clear.jsonl', [
    { type: 'user', message: { content: 'hi' }, cwd: 'C:\p' },
    { type: 'custom-title', customTitle: 'Old', sessionId: 's' },
    { type: 'custom-title', customTitle: '   ', sessionId: 's' },
  ]);
  const m = await parseHead(file);
  assert.equal(m.customTitle, null);
});

test('the text "custom-title" inside a message is not a rename', async () => {
  const file = tmpJsonl('ct-mention.jsonl', [
    { type: 'user', message: { content: 'grep for "custom-title" please' }, cwd: 'C:\p' },
    { type: 'assistant', message: { content: '{"type":"custom-title","customTitle":"Fake"}' } },
  ]);
  const m = await parseHead(file);
  assert.equal(m.customTitle, null);
});
