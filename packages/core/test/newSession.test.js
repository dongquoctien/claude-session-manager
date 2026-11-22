import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeFolderInput,
  isFullPath,
  resolveFolder,
  cleanSessionName,
  recentFolders,
  startNewSession,
  MAX_NAME_LENGTH,
} from '../src/newSession.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'csm-new-'));

// --- folder input -----------------------------------------------------------

test('normalizeFolderInput: trims and drops the quotes of "Copy as path"', () => {
  assert.equal(normalizeFolderInput('  "D:\\Github\\my app"  '), 'D:\\Github\\my app');
  assert.equal(normalizeFolderInput("'/home/me/x'"), '/home/me/x');
  assert.equal(normalizeFolderInput('"unbalanced'), '"unbalanced');
  assert.equal(normalizeFolderInput(null), '');
  assert.equal(normalizeFolderInput(42), '');
});

test('normalizeFolderInput: expands a leading ~', () => {
  assert.equal(normalizeFolderInput('~'), path.join(os.homedir()));
  assert.equal(normalizeFolderInput('~/proj'), path.join(os.homedir(), 'proj'));
});

test('isFullPath: Windows wants a drive or a UNC share, not a bare \\folder', () => {
  assert.equal(isFullPath('D:\\Github\\x', 'win32'), true);
  assert.equal(isFullPath('d:/Github/x', 'win32'), true);
  assert.equal(isFullPath('\\\\server\\share\\x', 'win32'), true);
  assert.equal(isFullPath('\\Github\\x', 'win32'), false);
  assert.equal(isFullPath('Github\\x', 'win32'), false);
  assert.equal(isFullPath('/home/me', 'linux'), true);
  assert.equal(isFullPath('me/proj', 'linux'), false);
});

test('resolveFolder: accepts an existing directory (quoted too)', () => {
  const dir = tmp();
  assert.deepEqual(resolveFolder(`"${dir}"`), { ok: true, path: path.resolve(dir) });
});

test('resolveFolder: rejects empty, relative, missing and file paths with a message', () => {
  const dir = tmp();
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'x');
  for (const [input, re] of [
    ['', /Choose a folder/],
    ['relative/dir', /full path/],
    [path.join(dir, 'nope'), /not found/],
    [file, /Not a folder/],
  ]) {
    const r = resolveFolder(input);
    assert.equal(r.ok, false, input);
    assert.match(r.error, re);
  }
});

// --- name -------------------------------------------------------------------

test('cleanSessionName: one line, no control chars or double quotes, capped', () => {
  assert.equal(cleanSessionName('  Fix  "login"\n bug\t'), 'Fix login bug');
  assert.equal(cleanSessionName('Lỗi tên; v2'), 'Lỗi tên; v2');
  assert.equal(cleanSessionName(undefined), '');
  assert.equal(cleanSessionName('x'.repeat(200)).length, MAX_NAME_LENGTH);
});

// --- recent folders ---------------------------------------------------------

test('recentFolders: one entry per folder, newest first, missing folders skipped', () => {
  const sessions = [
    { cwd: 'D:\\a', mtime: 100, cwdExists: true },
    { cwd: 'D:\\b', mtime: 300, cwdExists: true },
    { cwd: 'd:\\A\\', mtime: 200, cwdExists: true }, // same folder as D:\a on Windows
    { cwd: 'D:\\gone', mtime: 999, cwdExists: false },
    { cwd: null, mtime: 500 },
  ];
  const r = recentFolders(sessions, { platform: 'win32' });
  assert.deepEqual(r, [
    { path: 'D:\\b', lastActive: 300, count: 1 },
    { path: 'd:\\A', lastActive: 200, count: 2 }, // spelling of the latest use
  ]);
});

test('recentFolders: case matters off Windows; limit applies', () => {
  const sessions = [
    { cwd: '/p/A', mtime: 1, cwdExists: true },
    { cwd: '/p/a', mtime: 2, cwdExists: true },
    { cwd: '/p/c', mtime: 3, cwdExists: true },
  ];
  assert.equal(recentFolders(sessions, { platform: 'linux' }).length, 3);
  assert.deepEqual(recentFolders(sessions, { platform: 'linux', limit: 1 }).map((f) => f.path), ['/p/c']);
});

// --- startNewSession --------------------------------------------------------

function fakes() {
  const calls = { launch: [], place: [] };
  return {
    calls,
    deps: {
      uuid: () => '11111111-2222-4333-8444-555555555555',
      launch: (o) => { calls.launch.push(o); return { terminal: 'wt', cmd: 'wt.exe', args: [] }; },
      placeWhenLive: async (s) => { calls.place.push(s); return { result: 'focused' }; },
    },
  };
}

test('startNewSession: launches claude with the generated id, name and flags', async () => {
  const dir = tmp();
  const f = fakes();
  const r = await startNewSession({ cwd: dir, name: ' My "new" task ', skipPermissions: true }, f.deps);
  assert.equal(r.action, 'launched');
  assert.equal(r.id, '11111111-2222-4333-8444-555555555555');
  assert.equal(r.name, 'My new task');
  assert.equal(r.placing, undefined);
  assert.deepEqual(f.calls.launch, [{
    cwd: path.resolve(dir),
    sessionId: r.id,
    newSession: true,
    name: 'My new task',
    skipPermissions: true,
    terminal: 'auto',
  }]);
  assert.equal(f.calls.place.length, 0);
});

test('startNewSession: no name -> no --name; place -> placed once it runs', async () => {
  const f = fakes();
  const r = await startNewSession({ cwd: tmp(), place: true }, f.deps);
  assert.equal(f.calls.launch[0].name, undefined);
  assert.equal(r.placing, true);
  assert.deepEqual(f.calls.place, [{ id: r.id, title: 'Claude Code' }]);
});

test('startNewSession: a bad folder throws BAD_FOLDER and starts nothing', async () => {
  const f = fakes();
  await assert.rejects(
    startNewSession({ cwd: path.join(tmp(), 'missing') }, f.deps),
    (err) => err.code === 'BAD_FOLDER' && /not found/.test(err.message),
  );
  assert.equal(f.calls.launch.length, 0);
});

test('startNewSession: dryRun returns the command, spawns nothing', async () => {
  const f = fakes();
  const r = await startNewSession({ cwd: tmp(), name: 'n', dryRun: true, terminal: 'wt' }, f.deps);
  assert.equal(r.action, 'launch');
  assert.equal(r.dryRun, true);
  const sep = r.args.indexOf('--');
  assert.deepEqual(r.args.slice(sep + 1), ['claude', '--session-id', r.id, '--name', 'n']);
  assert.equal(f.calls.launch.length, 0);
});
