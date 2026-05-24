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
