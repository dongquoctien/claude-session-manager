import { runPowerShell, PS_TYPE_LOADER, psUseType } from './powershell.js';
import { LAYOUT_CS, PIP_WINDOW_TITLE, MIN_FREE_WIDTH, psString } from './dock.js';

/**
 * Bring the terminal window that hosts a running Claude Code process to the
 * front — and, in Windows Terminal, select the exact tab — instead of starting
 * a second `claude --resume` on the same conversation.
 *
 * Windows only. The work is done by a short PowerShell script (Win32 via
 * Add-Type + UI Automation, both built into Windows PowerShell 5.1), so there
 * is no native addon and nothing to install. Measured ~0.3s per call (the
 * C# is compiled once and then loaded from a cached DLL, see powershell.js).
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
 * @property {'focused'|'flashed'|'gone'|'stale'|'no-window'|'not-started'|'error'|'unsupported'} result
 *   not-started — (launched mode) no process with that session id appeared
 * @property {number|null} [launchedPid]  (launched mode) the process it found
 * @property {'selected'|'single'|'not-found'|null} [tab]  tab outcome (WT only)
 * @property {'marker'|'title'|null} [tabBy]  how the tab was identified
 * @property {string|null} [host]  window class or host process name
 * @property {number|null} [hwnd]  the window that was raised
 * @property {'placed'|'no-pip'|'ambiguous'|'no-room'|null} [placed]  outcome of `place`
 * @property {string} [error]
 */

/** A session id: the only thing that goes into the WQL process search. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Win32 helpers for the switch script (loaded via the compile-once cache). */
const FOCUS_CS = String.raw`
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
`;

/**
 * The PowerShell side. `__CSM_PARAMS__` becomes a PowerShell object literal in
 * which every string from outside (the titles) is base64 — no quote character
 * can break out — and everything else is a validated number, UUID or bool.
 * Nothing is written to stdout while attached to the target console; the
 * single JSON result is written after FreeConsole.
 *
 * Speed: the hot path (switch to a running session) calls .NET directly and
 * no cmdlet from an auto-loaded module. Measured: `ConvertFrom-Json` alone
 * costs ~100ms (it loads Microsoft.PowerShell.Utility), `Get-Process` ~45ms
 * (Microsoft.PowerShell.Management) — against ~2ms for the .NET calls. Same
 * for ConvertTo-Json, New-Object, Start-Sleep, Get-Date, Add-Type
 * -AssemblyName and Join-Path, so none of them are used on that path.
 */
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function D([string]$b) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) }
$P = __CSM_PARAMS__
__CSM_LOADER__
__CSM_USE_FOCUS__
if ($P.place) {
__CSM_USE_LAYOUT__
  [CsmLayout]::DpiAware()
}
$r = [ordered]@{ result = $null; tab = $null; tabBy = $null; host = $null; hwnd = $null; placed = $null; launchedPid = $null; error = $null }
$attached = $false; $restore = $null
# Where a placed terminal goes: an explicit area (floating layout: the work
# area minus the round button's column), else beside the docked list.
function PlaceIt([IntPtr]$w) {
  if ($P.placeRect) {
    [CsmLayout]::PlaceVisible($w, [int]$P.placeRect[0], [int]$P.placeRect[1], [int]$P.placeRect[2], [int]$P.placeRect[3])
    return 'placed'
  }
  return [CsmLayout]::PlaceBeside($w, __CSM_PIP_TITLE__, __CSM_MIN_FREE__)
}
function Norm([string]$s) { if (-not $s) { return '' }; ($s -replace '^[^\p{L}\p{N}]+', '').Trim().ToLowerInvariant() }
function J($v) {
  if ($null -eq $v) { return 'null' }
  if ($v -is [bool]) { if ($v) { return 'true' } else { return 'false' } }
  if ($v -is [int] -or $v -is [long]) { return [string]$v }
  $e = [regex]::Replace(([string]$v).Replace('\', '\\').Replace('"', '\"'), '[^\x20-\x7e]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  return '"' + $e + '"'
}
try {
  if (-not $P.pid -and $P.launchedId) {
    # A terminal csm has just started: find its claude by the session id on
    # its command line (--resume <id> / --session-id <id>). It exists from the
    # first moment — long before claude registers in ~/.claude/sessions, and
    # even while it is still asking whether to trust the folder.
    $after = [DateTime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc).AddMilliseconds([double]$P.launchedAfter).ToLocalTime()
    $deadline = [DateTime]::Now.AddMilliseconds([int]$P.searchMs)
    $skip = @('wt.exe', 'WindowsTerminal.exe', 'OpenConsole.exe', 'conhost.exe')
    $searcher = [wmisearcher]("SELECT ProcessId, Name, CreationDate FROM Win32_Process WHERE CommandLine LIKE '%" + $P.launchedId + "%'")
    $best = $null; $bestAt = $null
    do {
      # (Not "$p": PowerShell names are case-insensitive — that IS $P.)
      foreach ($proc in $searcher.Get()) {
        if ($skip -contains [string]$proc.Name) { continue }
        $at = [Management.ManagementDateTimeConverter]::ToDateTime([string]$proc.CreationDate)
        if ($at -lt $after) { continue }
        if ($null -eq $best -or $at -lt $bestAt) { $best = $proc; $bestAt = $at }
      }
      if ($null -eq $best) { [Threading.Thread]::Sleep(120) }
    } while ($null -eq $best -and [DateTime]::Now -lt $deadline)
    if ($best) { $P.pid = [int]$best.ProcessId; $r.launchedPid = $P.pid }
  }
  $proc = $null
  if ($P.pid) { try { $proc = [Diagnostics.Process]::GetProcessById([int]$P.pid) } catch { } }
  if (-not $P.pid) { $r.result = 'not-started' }
  elseif (-not $proc) { $r.result = 'gone' }
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
      # (Rare — IDE terminals — so cmdlets are fine here.)
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
        [void][Reflection.Assembly]::Load('UIAutomationTypes, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
        [void][Reflection.Assembly]::Load('UIAutomationClient, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
        $A = [System.Windows.Automation.AutomationElement]
        $win = $A::FromHandle($top)
        $tabCond = [System.Windows.Automation.PropertyCondition]::new($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
        $tabs = @($win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond))
        if ($tabs.Count -le 1) { $r.tab = 'single' }
        else {
          $hit = $null
          if ($attached) {
            $restore = [CsmW]::Title()
            $marker = 'csm-focus-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
            [void][CsmW]::SetConsoleTitle($marker)
            $deadline = [DateTime]::Now.AddMilliseconds(1500)
            while (-not $hit -and [DateTime]::Now -lt $deadline) {
              [Threading.Thread]::Sleep(60)
              foreach ($t in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)) {
                if ($t.Current.Name -eq $marker) { $hit = $t; break }
              }
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
      if ($P.place) { $r.placed = PlaceIt $top }
      if ([CsmW]::Raise($top)) { $r.result = 'focused' } else { [CsmW]::Flash($top); $r.result = 'flashed' }
      if ($P.place -and $r.launchedPid -and $r.placed -eq 'placed') {
        # A window that has only just opened can still apply its own initial
        # size/position after ours: put it back if it moved.
        for ($i = 0; $i -lt 4; $i++) { [Threading.Thread]::Sleep(200); [void](PlaceIt $top) }
      }
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
[Console]::Out.Write('{' + (($r.Keys | ForEach-Object { (J $_) + ':' + (J $r[$_]) }) -join ',') + '}')
`;

/**
 * The parameters as the script will see them: validated and normalised.
 * Exported for tests.
 * @param {{ pid?: number, procStart?: string|null, titles?: string[], place?: boolean,
 *           placeRect?: { x: number, y: number, w: number, h: number }|null,
 *           launchedId?: string, launchedAfter?: number, searchMs?: number }} params
 *   placeRect — with place: put the window exactly there (floating layout)
 *   instead of beside the docked list
 */
export function focusParams(params) {
  const launchedId = typeof params.launchedId === 'string' && UUID_RE.test(params.launchedId)
    ? params.launchedId
    : null;
  return {
    pid: Number.isInteger(params.pid) && params.pid > 0 ? params.pid : 0,
    procStart: /^\d{1,20}$/.test(String(params.procStart ?? '')) ? String(params.procStart) : null,
    titles: (params.titles || []).filter((t) => typeof t === 'string' && t),
    place: !!params.place,
    placeRect: rectOf(params.placeRect),
    launchedId,
    launchedAfter: launchedId ? Math.max(0, Math.trunc(Number(params.launchedAfter) || 0)) : 0,
    searchMs: launchedId ? Math.max(0, Math.trunc(Number(params.searchMs) || 8000)) : 0,
  };
}

/**
 * An explicit placement area as [x, y, w, h] integers (screen px), or null.
 * @param {unknown} r
 * @returns {number[]|null}
 */
function rectOf(r) {
  const o = /** @type {any} */ (r);
  if (!o || typeof o !== 'object') return null;
  const v = [o.x, o.y, o.w, o.h];
  if (!v.every((n) => Number.isInteger(n) && Math.abs(n) <= 100_000) || o.w <= 0 || o.h <= 0) return null;
  return v;
}

/** Render focusParams() as a PowerShell object literal (see PS_SCRIPT). */
function psParams(p) {
  const b64 = (t) => `(D '${Buffer.from(t, 'utf8').toString('base64')}')`;
  return `[pscustomobject]@{ pid = ${p.pid}; procStart = ${p.procStart ? `'${p.procStart}'` : '$null'}; `
    + `titles = @(${p.titles.map(b64).join(', ')}); place = $${p.place}; `
    + `placeRect = ${p.placeRect ? `@(${p.placeRect.join(', ')})` : '$null'}; `
    + `launchedId = ${p.launchedId ? `'${p.launchedId}'` : '$null'}; launchedAfter = ${p.launchedAfter}; searchMs = ${p.searchMs} }`;
}

/**
 * Build the PowerShell script for given params. Exported for tests.
 * @param {Parameters<typeof focusParams>[0]} params
 * @returns {string}
 */
export function buildFocusScript(params) {
  // Function replacements: a plain string would have `$&`-style patterns expanded.
  return PS_SCRIPT
    .replace('__CSM_PARAMS__', () => psParams(focusParams(params)))
    .replace('__CSM_LOADER__', () => PS_TYPE_LOADER)
    .replace('__CSM_USE_FOCUS__', () => psUseType('CsmW', FOCUS_CS))
    .replace('__CSM_USE_LAYOUT__', () => psUseType('CsmLayout', LAYOUT_CS))
    .replaceAll('__CSM_PIP_TITLE__', () => psString(PIP_WINDOW_TITLE))
    .replaceAll('__CSM_MIN_FREE__', () => String(MIN_FREE_WIDTH));
}

/**
 * Bring the window hosting a running Claude Code process to the front.
 * Never throws: failures come back as `{ result: 'error' }`.
 *
 * Or, for a terminal csm has JUST launched (`pid` 0, `launchedId` set): first
 * find that `claude` by the session id on its command line — started after
 * `launchedAfter` (ms epoch), waiting up to `searchMs` for it to appear — then
 * do the same. Resolves `not-started` if no such process showed up.
 *
 * @param {{ pid?: number, procStart?: string|null, titles?: string[], place?: boolean,
 *           launchedId?: string, launchedAfter?: number, searchMs?: number }} params
 *   titles — the session's names (custom/AI title), used only as a fallback to
 *   pick the tab when the title marker can't be used;
 *   place — also move the window beside the floating Sessions window
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<FocusResult>}
 */
export async function focusSessionWindow(params, opts = {}) {
  if (process.platform !== 'win32') return { result: 'unsupported' };
  const byPid = Number.isInteger(params.pid) && params.pid > 0;
  const launched = !byPid && typeof params.launchedId === 'string' && UUID_RE.test(params.launchedId);
  if (!byPid && !launched) {
    return { result: 'error', error: 'invalid pid' };
  }
  const searchMs = launched ? (params.searchMs ?? 8000) : 0;
  const { stdout, error } = await runPowerShell(
    buildFocusScript({ ...params, searchMs }),
    { timeoutMs: opts.timeoutMs ?? 10_000 + searchMs },
  );
  const line = stdout.trim().split(/\r?\n/).pop() || '';
  try {
    return JSON.parse(line);
  } catch {
    return { result: 'error', error: line ? `bad helper output: ${line.slice(0, 200)}` : (error || 'helper produced no output') };
  }
}
