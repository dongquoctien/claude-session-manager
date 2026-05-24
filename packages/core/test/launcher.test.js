import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLaunch } from '../src/launcher.js';

test('wt build: argv shape with -- separator before claude', () => {
  const { cmd, args, terminal } = buildLaunch({
    cwd: 'D:\\Github\\news-tok',
    sessionId: 'abc-123',
    terminal: 'wt',
  });
  assert.equal(terminal, 'wt');
  assert.match(cmd, /wt(\.exe)?$/i);
  assert.deepEqual(args, ['-d', 'D:\\Github\\news-tok', '--', 'claude', '--resume', 'abc-123']);
});

test('wt build: -- comes immediately before the claude binary', () => {
  // Regression guard: without `--`, wt swallows claude's flags and the
  // session opens WITHOUT --resume.
  const { args } = buildLaunch({ cwd: 'C:\\x', sessionId: 'id', terminal: 'wt' });
  const sep = args.indexOf('--');
  assert.ok(sep >= 0, 'must contain -- separator');
  assert.equal(args[sep + 1], 'claude');
  assert.equal(args[sep + 2], '--resume');
});

test('wt build: includes --fork-session when fork', () => {
  const { args } = buildLaunch({ cwd: 'C:\\x', sessionId: 'id', terminal: 'wt', fork: true });
  assert.ok(args.includes('--fork-session'));
});

test('wt build: includes --dangerously-skip-permissions when skipPermissions', () => {
  const { args } = buildLaunch({ cwd: 'C:\\x', sessionId: 'id', terminal: 'wt', skipPermissions: true });
  assert.ok(args.includes('--dangerously-skip-permissions'));
});

test('build: omits --dangerously-skip-permissions by default', () => {
  const { args } = buildLaunch({ cwd: 'C:\\x', sessionId: 'id', terminal: 'wt' });
  assert.ok(!args.includes('--dangerously-skip-permissions'));
});

test('powershell build: passes --dangerously-skip-permissions', () => {
  const { args } = buildLaunch({ cwd: 'C:\\x', sessionId: 'id', terminal: 'powershell', skipPermissions: true });
  const command = args[args.length - 1];
  assert.ok(command.includes("'--dangerously-skip-permissions'"));
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

test('macos build: osascript with cd + claude in the script', () => {
  const { cmd, args, terminal } = buildLaunch({ cwd: '/Users/me/proj', sessionId: 'id-1', terminal: 'macos' });
  assert.equal(terminal, 'macos');
  assert.equal(cmd, 'osascript');
  const script = args[args.indexOf('-e') + 1];
  assert.ok(script.includes("cd '/Users/me/proj'"));
  assert.ok(script.includes('--resume'));
  assert.ok(script.includes('id-1'));
});

test('linux build: x-terminal-emulator runs bash -lc with cd + claude', () => {
  const { cmd, args, terminal } = buildLaunch({ cwd: '/home/me/proj', sessionId: 'id-2', terminal: 'linux' });
  assert.equal(terminal, 'linux');
  assert.equal(cmd, 'x-terminal-emulator');
  const line = args[args.length - 1];
  assert.ok(line.includes("cd '/home/me/proj'"));
  assert.ok(line.includes('--resume'));
  assert.ok(line.includes('id-2'));
});

test('posix quoting escapes embedded single quotes (macos)', () => {
  const { args } = buildLaunch({ cwd: "/Users/o'brien/p", sessionId: 'x', terminal: 'macos' });
  const script = args[args.indexOf('-e') + 1];
  // The path is shell-quoted (o'\''brien) and then AppleScript-quoted, which
  // doubles the backslash. Just assert the path made it in intact and quoted.
  assert.ok(script.includes("o'") && script.includes("brien"));
  assert.ok(script.includes("cd '/Users/o"));
});
