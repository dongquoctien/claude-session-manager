import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { createServer } from '../src/server.js';

const TOKEN = 'monitor-token-123';
let baseUrl;
let server;
let fakeProjects;

function writeConv(dir, id, lines) {
  const folder = path.join(fakeProjects, dir);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${id}.jsonl`), lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

before(async () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-mon-cfg-'));
  process.env.CLAUDE_CONFIG_DIR = cfg;
  fakeProjects = path.join(cfg, 'projects');
  fs.mkdirSync(fakeProjects, { recursive: true });

  const nowIso = new Date().toISOString();
  writeConv('D--proj-a', 'aaaa1111-2222-3333-4444-555566667777', [
    { type: 'user', timestamp: nowIso, cwd: os.tmpdir(), gitBranch: 'main', message: { content: 'hello a' } },
    {
      type: 'assistant', timestamp: nowIso,
      message: {
        role: 'assistant', model: 'claude-opus-4-7',
        content: [{ type: 'tool_use', name: 'Bash', input: {} }],
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 },
      },
    },
    { type: 'ai-title', aiTitle: 'Conversation A' },
  ]);

  const { server: srv } = createServer({ token: TOKEN, cacheMs: 0 });
  server = srv;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  delete process.env.CLAUDE_CONFIG_DIR;
});

const url = (p) => `${baseUrl}${p}${p.includes('?') ? '&' : '?'}token=${TOKEN}`;

test('/api/monitor returns sessions enriched with metrics + systemStats', async () => {
  const r = await fetch(url('/api/monitor'));
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.ok(Array.isArray(data.sessions));
  assert.ok(data.systemStats);
  const s = data.sessions.find((x) => x.id.startsWith('aaaa1111'));
  assert.ok(s, 'expected the seeded conversation');
  assert.equal(s.tokens.input, 100);
  assert.equal(s.tokens.cacheRead, 900);
  assert.equal(s.totalTokens, 1050);
  assert.equal(s.model, 'claude-opus-4-7');
  assert.equal(s.activity, 'running'); // last tool_use was Bash, just now
  assert.equal(s.active, true);
  assert.ok(s.costUSD > 0, 'cost estimated from tokens');
  assert.ok(data.systemStats.totalSessions >= 1);
});

test('/api/monitor requires a token', async () => {
  const r = await fetch(`${baseUrl}/api/monitor`);
  assert.equal(r.status, 401);
});

test('/api/session returns one enriched session by id prefix', async () => {
  const r = await fetch(url('/api/session?id=aaaa1111'));
  assert.equal(r.status, 200);
  const { session } = await r.json();
  assert.equal(session.title, 'Conversation A');
  assert.equal(session.tokens.cacheRead, 900);
  assert.deepEqual(typeof session.cacheHitRate, 'number');
});

test('/api/session 404 for unknown id', async () => {
  const r = await fetch(url('/api/session?id=zzzzzzzz'));
  assert.equal(r.status, 404);
});

test('/api/stream emits an SSE snapshot event', async () => {
  // Use raw http so we can read the streaming body incrementally.
  const { port } = server.address();
  const snapshot = await new Promise((resolve, reject) => {
    const rq = http.request(
      { host: '127.0.0.1', port, path: `/api/stream?token=${TOKEN}`, method: 'GET' },
      (resp) => {
        assert.equal(resp.statusCode, 200);
        assert.match(resp.headers['content-type'], /text\/event-stream/);
        let buf = '';
        resp.on('data', (c) => {
          buf += c;
          const idx = buf.indexOf('event: snapshot');
          if (idx !== -1) {
            const dataLine = buf.slice(idx).split('\n').find((l) => l.startsWith('data: '));
            if (dataLine) {
              rq.destroy();
              resolve(JSON.parse(dataLine.slice('data: '.length)));
            }
          }
        });
        resp.on('error', () => {}); // expected on destroy
      },
    );
    rq.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    rq.end();
    setTimeout(() => { rq.destroy(); reject(new Error('timeout waiting for snapshot')); }, 5000);
  });
  assert.ok(Array.isArray(snapshot.sessions));
  assert.ok(snapshot.systemStats);
});

test('/api/stream requires a token (401)', async () => {
  const r = await fetch(`${baseUrl}/api/stream`);
  assert.equal(r.status, 401);
});
