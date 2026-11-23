import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';

/**
 * Absolute path to Windows PowerShell 5.1. Built into every supported Windows,
 * and taken from %SystemRoot% rather than PATH so a stray `powershell.exe`
 * earlier on PATH can't be picked up.
 * @returns {string}
 */
export function powershellExe() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Encode a script for `-EncodedCommand` (UTF-16LE, base64). Encoded commands
 * are not subject to the execution policy and need no temp file, so nothing
 * has to ship next to the bundled desktop app.
 * @param {string} script
 * @returns {string}
 */
export function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * The only thing on the command line: read the real script from stdin
 * (base64 of UTF-8, so no console code page can mangle it) and run it.
 *
 * The scripts used to travel inside `-EncodedCommand` itself, but that is
 * UTF-16 *and* base64 — 2.7 bytes per character — and the switch-to-window
 * script with its embedded C# reached 32,200 of Windows' 32,767-character
 * command-line limit: a session title of ~70 Vietnamese characters pushed it
 * over (spawn ENAMETOOLONG, verified). stdin has no such limit.
 */
const BOOTSTRAP = encodeCommand(
  '$__csm = [Console]::In.ReadToEnd(); '
  + '. ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($__csm.Trim()))))',
);

/**
 * Run a PowerShell script hidden and collect its stdout. Never throws.
 * @param {string} script
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, stdout: string, error?: string }>}
 */
export function runPowerShell(script, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return new Promise((resolve) => {
    let stdout = '';
    let child;
    try {
      child = spawn(
        powershellExe(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', BOOTSTRAP],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
      );
    } catch (err) {
      resolve({ ok: false, stdout: '', error: String(err && err.message || err) });
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdin.on('error', () => {}); // the helper may exit before reading it all
    child.stdin.end(Buffer.from(script, 'utf8').toString('base64'));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, error: String(err && err.message || err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) resolve({ ok: false, stdout, error: `timed out after ${timeoutMs}ms` });
      else resolve({ ok: code === 0, stdout, error: code === 0 ? undefined : `exit code ${code}` });
    });
  });
}

/**
 * PowerShell function that makes a C# type available, compiled ONCE.
 *
 * `Add-Type -TypeDefinition` runs the C# compiler on every call: ~150ms per
 * type, paid on every switch-to-window. Instead the source is compiled once
 * into `%TEMP%\csm-ps\<Name>-<hash>.dll` (hash of the source, so an edited
 * type gets a new file) and later calls just load that DLL (~12ms, measured).
 * Compiled to a unique temp name and renamed into place, so two helpers
 * starting at once can't read a half-written file; any problem with the cache
 * falls back to the old in-memory compile.
 */
export const PS_TYPE_LOADER = String.raw`
function Use-CsmType([string]$Name, [string]$Hash, [string]$Source, [string[]]$Refs) {
  if ($Name -as [type]) { return }
  # .NET calls only: the path cmdlets would load a module (~45ms) every time.
  $dir = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'csm-ps')
  $dll = [IO.Path]::Combine($dir, $Name + '-' + $Hash + '.dll')
  if (-not [IO.File]::Exists($dll)) {
    try {
      [void][IO.Directory]::CreateDirectory($dir)
      $part = [IO.Path]::Combine($dir, $Name + '-' + $Hash + '-' + [Guid]::NewGuid().ToString('N') + '.part.dll')
      if ($Refs) { Add-Type -TypeDefinition $Source -ReferencedAssemblies $Refs -OutputAssembly $part }
      else { Add-Type -TypeDefinition $Source -OutputAssembly $part }
      try { [IO.File]::Move($part, $dll) } catch { try { [IO.File]::Delete($part) } catch { } }
      # Builds of earlier versions of this type are dead weight now.
      foreach ($old in [IO.Directory]::GetFiles($dir, $Name + '-*.dll')) {
        if ($old -ne $dll -and -not $old.EndsWith('.part.dll')) { try { [IO.File]::Delete($old) } catch { } }
      }
    } catch { }
  }
  if ([IO.File]::Exists($dll)) {
    try { [void][Reflection.Assembly]::LoadFrom($dll) } catch { try { [IO.File]::Delete($dll) } catch { } }
    if ($Name -as [type]) { return }
  }
  if ($Refs) { Add-Type -TypeDefinition $Source -ReferencedAssemblies $Refs }
  else { Add-Type -TypeDefinition $Source }
}
`;

/**
 * PowerShell lines that load C# type `name` through {@link PS_TYPE_LOADER}
 * (which the script must define first). The source goes into a verbatim
 * (single-quoted) here-string, so PowerShell expands nothing in it.
 *
 * @param {string} name    the public class the source defines
 * @param {string} source  C#
 * @param {string[]} [refs]  extra assemblies to reference
 * @returns {string}
 */
export function psUseType(name, source, refs = []) {
  if (/^\s*'@/m.test(source)) throw new Error(`C# for ${name} would end its here-string early`);
  const hash = crypto.createHash('sha256').update(`${name}\n${refs.join(',')}\n${source}`).digest('hex').slice(0, 16);
  const refList = refs.length ? `@(${refs.map((r) => `'${r}'`).join(', ')})` : '$null';
  return `$__src_${name} = @'\n${source}\n'@\nUse-CsmType '${name}' '${hash}' $__src_${name} ${refList}\n`;
}
