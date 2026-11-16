import { spawn } from 'node:child_process';
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
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch (err) {
      resolve({ ok: false, stdout: '', error: String(err && err.message || err) });
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
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
