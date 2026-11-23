import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { psUseType, runPowerShell, PS_TYPE_LOADER } from '../src/powershell.js';

const win = process.platform === 'win32';

test('psUseType: verbatim here-string + a hash that follows the source', () => {
  const a = psUseType('CsmX', 'public static class CsmX { }');
  assert.match(a, /^\$__src_CsmX = @'\npublic static class CsmX \{ \}\n'@\nUse-CsmType 'CsmX' '([0-9a-f]{16})' \$__src_CsmX \$null\n$/);
  assert.equal(psUseType('CsmX', 'public static class CsmX { }'), a, 'same source, same cache file');
  assert.notEqual(psUseType('CsmX', 'public static class CsmX { int y; }').match(/'([0-9a-f]{16})'/)[1], a.match(/'([0-9a-f]{16})'/)[1]);
  assert.match(psUseType('CsmY', 'class CsmY {}', ['System.Drawing']), /Use-CsmType 'CsmY' '[0-9a-f]{16}' \$__src_CsmY @\('System\.Drawing'\)/);
});

test("psUseType: refuses C# that would end its here-string early", () => {
  assert.throws(() => psUseType('Bad', "class Bad {}\n'@\nRemove-Item x"), /here-string/);
});

test('runPowerShell: the script travels over stdin — no command-line limit, any script', { skip: !win }, async () => {
  // > 32,767 chars: this used to be spawn ENAMETOOLONG via -EncodedCommand.
  const big = 'x'.repeat(40_000);
  const r = await runPowerShell(`$s = '${big}'; [Console]::Out.Write([string]$s.Length + ' ' + [int][char]'ỗ')`, { timeoutMs: 20_000 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.stdout.trim(), `40000 ${'ỗ'.charCodeAt(0)}`);
});

test('Use-CsmType: compiles once, then loads the cached DLL', { skip: !win }, async () => {
  const name = `CsmTest${process.pid}${Date.now() % 100000}`;
  const src = `public static class ${name} { public static int Answer() { return 42; } }`;
  const script = `${PS_TYPE_LOADER}\n${psUseType(name, src)}
$dll = Join-Path (Join-Path ([IO.Path]::GetTempPath()) 'csm-ps') ('${name}-' + '${psUseType(name, src).match(/'([0-9a-f]{16})'/)[1]}' + '.dll')
[Console]::Out.Write(([string][${name}]::Answer()) + ' ' + [IO.File]::Exists($dll))`;
  // A build of an older version of the same type, left in the cache.
  const cacheDir = path.join(os.tmpdir(), 'csm-ps');
  fs.mkdirSync(cacheDir, { recursive: true });
  const stale = path.join(cacheDir, `${name}-deadbeefdeadbeef.dll`);
  fs.writeFileSync(stale, 'old');
  const first = await runPowerShell(script, { timeoutMs: 30_000 });
  assert.equal(first.stdout.trim(), '42 True', first.error);
  assert.equal(fs.existsSync(stale), false, 'compiling a new build removes older ones');
  const second = await runPowerShell(script, { timeoutMs: 30_000 });
  assert.equal(second.stdout.trim(), '42 True', second.error);
  // Clean up the test DLL (the real ones stay cached).
  await runPowerShell(`Remove-Item -Path (Join-Path (Join-Path ([IO.Path]::GetTempPath()) 'csm-ps') '${name}-*.dll') -ErrorAction SilentlyContinue`);
});
