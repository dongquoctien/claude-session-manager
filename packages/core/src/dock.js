import { runPowerShell, PS_TYPE_LOADER, psUseType } from './powershell.js';

/**
 * Side-by-side layout for the web UI's floating Sessions window: the list sits
 * in a Chrome Document Picture-in-Picture window pinned to one screen edge,
 * and the terminals csm opens or switches to go in the space next to it.
 *
 * Verified on Chrome 157 / Windows 11:
 *  - a document-PiP window is a top-level `Chrome_WidgetWin_*` window that is
 *    always-on-top (WS_EX_TOPMOST), and its native title is the opener page's
 *    `<title>` — fixed when the window is created; later `document.title`
 *    changes don't reach it. Ordinary browser windows are not topmost and
 *    carry a " - Google Chrome" style suffix, so "visible + topmost + Chrome
 *    class + exact title" picks out our PiP window. Anything other than
 *    exactly one match means "don't touch anything".
 *  - it can be moved/resized with SetWindowPos. Chrome caps its height at 80%
 *    of the screen (its answer to WM_WINDOWPOSCHANGING / WM_GETMINMAXINFO),
 *    but a resize with SWP_NOSENDCHANGING skips that: docked, it spans the
 *    whole work area, renders it, and keeps it when moved. Dragging an edge
 *    by hand still goes through Chrome, so that stays capped at 80%.
 *  - Windows 10/11 windows have invisible resize borders; placement works on
 *    the visible frame (DWMWA_EXTENDED_FRAME_BOUNDS) so edges meet exactly.
 *  - all of it runs per-monitor-DPI-aware, in physical pixels.
 */

/**
 * Native title Chrome gives our PiP window: the `<title>` of
 * packages/ui/public/index.html (a test keeps the two in sync).
 */
export const PIP_WINDOW_TITLE = 'Claude Session Manager';

/** Below this many px of free width, terminals are left where they are. */
const MIN_FREE_WIDTH = 320;

/**
 * C# used by the dock script and the switch script (focus.js). Pure Win32;
 * compiled once and then loaded from a cached DLL (powershell.js psUseType).
 */
export const LAYOUT_CS = String.raw`
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public static class CsmLayout {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cb; public RECT mon; public RECT work; public uint flags; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);

  public static void DpiAware() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } }

  static string Text(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }

  public static List<IntPtr> FindPip(string title) {
    var hits = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h) && (GetWindowLong(h, -20) & 0x8) != 0
          && Cls(h).StartsWith("Chrome_WidgetWin") && Text(h) == title) hits.Add(h);
      return true;
    }, IntPtr.Zero);
    return hits;
  }

  /** Visible frame (no invisible resize borders). */
  public static RECT Visible(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) == 0 && r.R > r.L) return r;
    GetWindowRect(h, out r);
    return r;
  }

  public static RECT Work(IntPtr h) {
    var mi = new MONITORINFO(); mi.cb = Marshal.SizeOf(mi);
    GetMonitorInfo(MonitorFromWindow(h, 2), ref mi);
    return mi.work;
  }

  /** Put the VISIBLE frame of h at (x, y, w, hh). */
  public static void PlaceVisible(IntPtr h, int x, int y, int w, int hh) { PlaceVisible(h, x, y, w, hh, false); }

  /**
   * noClamp: SWP_NOSENDCHANGING — the window gets no WM_WINDOWPOSCHANGING, so
   * it can't shrink the new size to its own maximum. Chrome caps a PiP window
   * at 80% of the screen height that way; resized like this it takes the
   * full height, renders it, and keeps it when moved afterwards (verified).
   */
  public static void PlaceVisible(IntPtr h, int x, int y, int w, int hh, bool noClamp) {
    if (IsZoomed(h) || IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE: a maximized window ignores SetWindowPos
    RECT r; GetWindowRect(h, out r); RECT v = Visible(h);
    int l = v.L - r.L, t = v.T - r.T, rr = r.R - v.R, b = r.B - v.B;
    uint flags = 0x0004 | 0x0010; // NOZORDER | NOACTIVATE
    if (noClamp) flags |= 0x0400; // NOSENDCHANGING
    SetWindowPos(h, IntPtr.Zero, x - l, y - t, w + l + rr, hh + t + b, flags);
  }

  static bool OnRight(RECT v, RECT work) { return (v.L + v.R) / 2 >= (work.L + work.R) / 2; }

  /** Pin the PiP window to the edge it is nearest to: top to bottom of the work area. */
  public static string Dock(string title) {
    var pips = FindPip(title);
    if (pips.Count == 0) return "no-pip";
    if (pips.Count > 1) return "ambiguous";
    IntPtr p = pips[0]; RECT v = Visible(p); RECT work = Work(p);
    int w = v.R - v.L; bool right = OnRight(v, work);
    PlaceVisible(p, right ? work.R - w : work.L, work.T, w, work.B - work.T, true);
    return right ? "right" : "left";
  }

  /** Is the PiP window (still) flush with a side edge and the top? */
  public static bool IsDocked(string title) {
    var pips = FindPip(title);
    if (pips.Count != 1) return false;
    RECT v = Visible(pips[0]); RECT work = Work(pips[0]);
    bool side = Math.Abs(v.R - work.R) <= 2 || Math.Abs(v.L - work.L) <= 2;
    return side && Math.Abs(v.T - work.T) <= 2 && Math.Abs(v.B - work.B) <= 2;
  }

  /** Top-left "x,y" of the free area beside the PiP window ("" if none / no room). */
  public static string FreeOrigin(string title, int minFree) {
    var pips = FindPip(title);
    if (pips.Count != 1) return "";
    RECT v = Visible(pips[0]); RECT work = Work(pips[0]);
    int x0, x1;
    if (OnRight(v, work)) { x0 = work.L; x1 = Math.Min(v.L, work.R); }
    else { x0 = Math.Max(v.R, work.L); x1 = work.R; }
    if (x1 - x0 < minFree) return "";
    return x0 + "," + work.T;
  }

  /** Move target into the space next to the PiP window, full work-area height. */
  public static string PlaceBeside(IntPtr target, string title, int minFree) {
    var pips = FindPip(title);
    if (pips.Count == 0) return "no-pip";
    if (pips.Count > 1) return "ambiguous";
    RECT v = Visible(pips[0]); RECT work = Work(pips[0]);
    int x0, x1;
    if (OnRight(v, work)) { x0 = work.L; x1 = Math.Min(v.L, work.R); }
    else { x0 = Math.Max(v.R, work.L); x1 = work.R; }
    if (x1 - x0 < minFree) return "no-room";
    PlaceVisible(target, x0, work.T, x1 - x0, work.B - work.T);
    return "placed";
  }
}
`;

/**
 * Pin the floating Sessions window to the screen edge it is nearest to (a
 * first PiP window opens bottom-right, so: right; after the user drags it to
 * the left, Chrome reopens it there and it docks left).
 *
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ result: 'right'|'left'|'no-pip'|'ambiguous'|'unsupported'|'error', error?: string }>}
 */
export async function dockPipWindow(opts = {}) {
  if (process.platform !== 'win32') return { result: 'unsupported' };
  const script = `$ErrorActionPreference = 'Stop'
${PS_TYPE_LOADER}
${psUseType('CsmLayout', LAYOUT_CS)}[CsmLayout]::DpiAware()
$title = ${psString(PIP_WINDOW_TITLE)}
# Right after it opens, Chrome is still settling the PiP window's initial
# bounds and can override ours (verified: the first move landed ~60px off the
# edge). So: wait for the window, place it, check it stayed, re-place if not.
$res = 'no-pip'
for ($i = 0; $i -lt 10 -and $res -eq 'no-pip'; $i++) {
  $res = [CsmLayout]::Dock($title)
  if ($res -eq 'no-pip') { Start-Sleep -Milliseconds 150 }
}
for ($i = 0; $i -lt 6 -and ($res -eq 'right' -or $res -eq 'left'); $i++) {
  Start-Sleep -Milliseconds 250
  if ([CsmLayout]::IsDocked($title)) { break }
  $res = [CsmLayout]::Dock($title)
}
$free = ''
if ($res -eq 'right' -or $res -eq 'left') { $free = [CsmLayout]::FreeOrigin($title, ${MIN_FREE_WIDTH}) }
[Console]::Out.Write($res + ' ' + $free)`;
  const { stdout, error } = await runPowerShell(script, { timeoutMs: opts.timeoutMs ?? 10_000 });
  return parseDockOutput(stdout, error);
}

/**
 * `<side> [x,y]` → result + the free area's top-left, where terminals opened
 * while pinned start (`wt --pos`), so they appear in place instead of at
 * Windows Terminal's default spot. Exported for tests.
 * @param {string} stdout
 * @param {string} [error]
 * @returns {{ result: 'right'|'left'|'no-pip'|'ambiguous'|'error', free?: { x: number, y: number }|null, error?: string }}
 */
export function parseDockOutput(stdout, error) {
  const line = String(stdout || '').trim().split(/\r?\n/).pop() || '';
  const [res, xy] = line.split(' ');
  if (!['right', 'left', 'no-pip', 'ambiguous'].includes(res)) {
    return { result: 'error', error: error || (line ? line.slice(0, 200) : 'no output') };
  }
  const m = /^(-?\d+),(-?\d+)$/.exec(xy || '');
  return { result: res, free: m ? { x: Number(m[1]), y: Number(m[2]) } : null };
}

/**
 * PowerShell single-quoted string literal. Only used for our own constants.
 * @param {string} s
 */
function psString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

export { MIN_FREE_WIDTH, psString };
