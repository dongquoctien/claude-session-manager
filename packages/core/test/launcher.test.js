import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLaunch } from '../src/launcher.js';

test('wt build: argv shape', () => {
  const { cmd, args, terminal } = buildLaunch({
    cwd: 'D:\\Github\\news-tok',
    sessionId: 'abc-123',
    terminal: 'wt',
  });
  assert.equal(terminal, 'wt');
  assert.match(cmd, /wt(\.exe)?$/i);
  assert.deepEqual(args, ['-d', 'D:\\Github\\news-tok', 'claude', '--resume', 'abc-123']);
});

test('wt build: includes --fork-session when fork', () => {
  const { args } = buildLaunch({ cwd: 'C:\\x', sessionId: 'id', terminal: 'wt', fork: true });
  assert.ok(args.includes('--fork-session'));
});

test('powershell build: single-quote escaping for paths with quotes', () => {
  const { cmd, args, terminal } = buildLaunch({
    cwd: "C:\\weird's dir",
    sessionId: 'id-1',
    terminal: 'powershell',
  });
  assert.equal(terminal, 'powershell');
  assert.equal(cmd, 'powershell.exe');
  const command = args[args.length - 1];
  // embedded single quote must be doubled
  assert.ok(command.includes("'C:\\weird''s dir'"));
  assert.ok(command.includes("'--resume'"));
  assert.ok(command.includes("'id-1'"));
});

test('powershell build: -NoExit keeps window open', () => {
  const { args } = buildLaunch({ cwd: 'C:\\x', sessionId: 'id', terminal: 'powershell' });
  assert.ok(args.includes('-NoExit'));
});

test('respects custom claudeBin', () => {
  const { args } = buildLaunch({ cwd: 'C:\\x', sessionId: 'id', terminal: 'wt', claudeBin: 'claude-canary' });
  assert.ok(args.includes('claude-canary'));
});
