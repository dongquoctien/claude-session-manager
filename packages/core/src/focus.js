import { runPowerShell } from './powershell.js';
import { LAYOUT_CS, PIP_WINDOW_TITLE, MIN_FREE_WIDTH, psString } from './dock.js';

/**
 * Bring the terminal window that hosts a running Claude Code process to the
 * front — and, in Windows Terminal, select the exact tab — instead of starting
 * a second `claude --resume` on the same conversation.
 *
 * Windows only. The work is done by a short PowerShell script (Win32 via
 * Add-Type + UI Automation, both built into Windows PowerShell 5.1), so there
 * is no native addon and nothing to install. Measured ~0.4s per call.
 *
 * How the window is found (verified on real data, see CLAUDE.md):
 *  1. The PID must still be the same process: its creation time must equal the
 *     `procStart` Claude Code recorded (a Windows FILETIME). Otherwise the PID
 *     file is stale and the PID was reused → `stale`.
 *  2. AttachConsole(pid) + GetConsoleWindow(). Under Windows Terminal that is a
 *     `PseudoConsoleWindow` whose root owner is the exact WT window hosting the
 *     tab — exact even when one WindowsTerminal.exe hosts several windows. A
 *     classic console gives its own `ConsoleWindowClass` window. No console
 *     window (IDE terminals, desktop app) → nearest ancestor process that has a
 *     main window (e.g. Code.exe).
 *  3. Tab: while attached, the console title is set to a unique marker, the WT
 *     tab carrying it is selected via UI Automation, and the old title is put
 *     back. Exact even when several tabs share a title. If the marker never
 *     shows (profile has `suppressApplicationTitle`), fall back to matching the
 *     tab name against the session's titles; if that is not a single hit, only
 *     the window is raised.
 *  4. Optional `place`: when the web UI's Sessions list is floating (pinned to
 *     a screen edge, see dock.js), move the window into the space beside it.
 *  5. Raise: restore if minimized, SetForegroundWindow, then the usual
 *     fallbacks (AttachThreadInput, a synthetic Alt tap) for the foreground
 *     lock. If Windows still refuses, flash the taskbar button → `flashed`.
 *
 * @typedef {Object} FocusResult
 * @property {'focused'|'flashed'|'gone'|'stale'|'no-window'|'error'|'unsupported'} result
 * @property {'selected'|'single'|'not-found'|null} [tab]  tab outcome (WT only)
 * @property {'marker'|'title'|null} [tabBy]  how the tab was identified
 * @property {string|null} [host]  window class or host process name
 * @property {number|null} [hwnd]  the window that was raised
 * @property {'placed'|'no-pip'|'ambiguous'|'no-room'|null} [placed]  outcome of `place`
 * @property {string} [error]
 */

/**
 * The PowerShell side. `__CSM_PARAMS__` is replaced by base64(JSON) — base64
 * has no quote characters, so session titles can never break out of the
 * string literal. Nothing is written to stdout while attached to the target
 * console; the single JSON result is written after FreeConsole.
 */
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$P = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__CSM_PARAMS__')) | ConvertFrom-Json
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class CsmW {
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern uint GetConsoleTitle(StringBuilder s, uint n);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool SetConsoleTitle(string s);
  [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr h, bool add);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO f);
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string Title() { var s = new StringBuilder(2048); GetConsoleTitle(s, 2048); return s.ToString(); }
  public static bool Raise(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    if (SetForegroundWindow(h) && GetForegroundWindow() == h) return true;
    uint dummy; IntPtr fg = GetForegroundWindow();
    uint fgT = GetWindowThreadProcessId(fg, out dummy), me = GetCurrentThreadId();
    if (fgT != 0 && fgT != me && AttachThreadInput(me, fgT, true)) {
      BringWindowToTop(h); SetForegroundWindow(h); AttachThreadInput(me, fgT, false);
      if (GetForegroundWindow() == h) return true;
    }
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
    return GetForegroundWindow() == h;
  }
  public static void Flash(IntPtr h) {
    var f = new FLASHWINFO(); f.cbSize = (uint)Marshal.SizeOf(f); f.hwnd = h; f.dwFlags = 3 | 12;
    FlashWindowEx(ref f);
  }
}
"@
if ($P.place) {
  Add-Type @"
__CSM_LAYOUT__
"@
  [CsmLayout]::DpiAware()
}
$r = [ordered]@{ result = $null; tab = $null; tabBy = $null; host = $null; hwnd = $null; placed = $null }
$attached = $false; $restore = $null
function Norm([string]$s) { if (-not $s) { return '' }; ($s -replace '^[^\p{L}\p{N}]+', '').Trim().ToLowerInvariant() }
try {
  $proc = Get-Process -Id ([int]$P.pid) -ErrorAction SilentlyContinue
  if (-not $proc) { $r.result = 'gone' }
  elseif ($P.procStart -and $(try { [Math]::Abs($proc.StartTime.ToFileTimeUtc() - [int64]$P.procStart) -gt 10000 } catch { $false })) { $r.result = 'stale' }
  else {
    [void][CsmW]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)
    [void][CsmW]::FreeConsole()
    $attached = [CsmW]::AttachConsole([uint32]$P.pid)
    $top = [IntPtr]::Zero
    if ($attached) {
      $con = [CsmW]::GetConsoleWindow()
      if ($con -ne [IntPtr]::Zero) {
        if ([CsmW]::Cls($con) -eq 'PseudoConsoleWindow') {
          $o = [CsmW]::GetAncestor($con, 3)
          if ($o -ne [IntPtr]::Zero -and $o -ne $con) { $top = $o }
        } else { $top = $con }
      }
    }
    if ($top -eq [IntPtr]::Zero) {
      # No console window of its own: take the nearest ancestor with a window.
      $cur = [int]$P.pid
      for ($i = 0; $i -lt 8 -and $top -eq [IntPtr]::Zero; $i++) {
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
        if (-not $cim -or -not $cim.ParentProcessId) { break }
        $cur = [int]$cim.ParentProcessId
        $gp = Get-Process -Id $cur -ErrorAction SilentlyContinue
        if ($gp -and $gp.MainWindowHandle -ne [IntPtr]::Zero) { $top = $gp.MainWindowHandle; $r.host = $gp.ProcessName }
      }
    }
    if ($top -eq [IntPtr]::Zero) { $r.result = 'no-window' }
    else {
      $r.hwnd = $top.ToInt64()
      if (-not $r.host) { $r.host = [CsmW]::Cls($top) }
      if ($r.host -eq 'CASCADIA_HOSTING_WINDOW_CLASS') {
        Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
        $A = [System.Windows.Automation.AutomationElement]
        $win = $A::FromHandle($top)
        $tabCond = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
        $tabs = @($win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond))
        if ($tabs.Count -le 1) { $r.tab = 'single' }
        else {
          $hit = $null
          if ($attached) {
            $restore = [CsmW]::Title()
            $marker = 'csm-focus-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
            [void][CsmW]::SetConsoleTitle($marker)
            $deadline = (Get-Date).AddMilliseconds(1500)
            while (-not $hit -and (Get-Date) -lt $deadline) {
              Start-Sleep -Milliseconds 60
              $hit = @($win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)) | Where-Object { $_.Current.Name -eq $marker } | Select-Object -First 1
            }
            if ($hit) { $r.tabBy = 'marker' }
          }
          if (-not $hit) {
            $want = @($P.titles | ForEach-Object { Norm $_ } | Where-Object { $_ })
            $cands = @($tabs | Where-Object { $want -contains (Norm $_.Current.Name) })
            if ($cands.Count -eq 1) { $hit = $cands[0]; $r.tabBy = 'title' }
          }
          if ($hit) {
            $hit.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
            $r.tab = 'selected'
          } else { $r.tab = 'not-found' }
        }
      }
      if ($P.place) { $r.placed = [CsmLayout]::PlaceBeside($top, __CSM_PIP_TITLE__, __CSM_MIN_FREE__) }
      if ([CsmW]::Raise($top)) { $r.result = 'focused' } else { [CsmW]::Flash($top); $r.result = 'flashed' }
    }
  }
} catch {
  $r.result = 'error'; $r.error = $_.Exception.Message
} finally {
  if ($attached) {
    if ($null -ne $restore) { [void][CsmW]::SetConsoleTitle($restore) }
    [void][CsmW]::FreeConsole()
  }
}
[Console]::Out.Write(($r | ConvertTo-Json -Compress))
`;

/**
 * Build the PowerShell script for given params (params are embedded as
 * base64 JSON, so no value can break out of the string literal). Exported
 * for tests.
 * @param {{ pid: number, procStart?: string|null, titles?: string[], place?: boolean }} params
 * @returns {string}
 */
export function buildFocusScript(params) {
  const json = JSON.stringify({
    pid: params.pid,
    procStart: params.procStart || null,
    titles: (params.titles || []).filter((t) => typeof t === 'string' && t),
    place: !!params.place,
  });
  // Function replacements: a plain string would have `$&`-style patterns expanded.
  return PS_SCRIPT
    .replace('__CSM_PARAMS__', () => Buffer.from(json, 'utf8').toString('base64'))
    .replace('__CSM_LAYOUT__', () => LAYOUT_CS)
    .replace('__CSM_PIP_TITLE__', () => psString(PIP_WINDOW_TITLE))
    .replace('__CSM_MIN_FREE__', () => String(MIN_FREE_WIDTH));
}

/**
 * Bring the window hosting a running Claude Code process to the front.
 * Never throws: failures come back as `{ result: 'error' }`.
 *
 * @param {{ pid: number, procStart?: string|null, titles?: string[], place?: boolean }} params
 *   titles — the session's names (custom/AI title), used only as a fallback to
 *   pick the tab when the title marker can't be used;
 *   place — also move the window beside the floating Sessions window
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<FocusResult>}
 */
export async function focusSessionWindow(params, opts = {}) {
  if (process.platform !== 'win32') return { result: 'unsupported' };
  if (!Number.isInteger(params.pid) || params.pid <= 0) {
    return { result: 'error', error: 'invalid pid' };
  }
  const { stdout, error } = await runPowerShell(buildFocusScript(params), { timeoutMs: opts.timeoutMs ?? 10_000 });
  const line = stdout.trim().split(/\r?\n/).pop() || '';
  try {
    return JSON.parse(line);
  } catch {
    return { result: 'error', error: line ? `bad helper output: ${line.slice(0, 200)}` : (error || 'helper produced no output') };
  }
}
