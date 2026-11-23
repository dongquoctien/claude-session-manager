import { runPowerShell, PS_TYPE_LOADER, psUseType } from './powershell.js';

/**
 * Layout of the web UI's pinned Sessions window — a Chrome Document
 * Picture-in-Picture window — and of the terminals csm opens beside it.
 *
 * Two layouts:
 *  - docked: the list spans one screen edge top to bottom; terminals go in the
 *    space next to it.
 *  - floating: a round button in the bottom corner (like a chat widget). It
 *    opens into the list ("panel", with a round close button below it) and
 *    collapses back. Terminals take the work area minus the button's column.
 *
 * Verified on Chrome 157 / Windows 11:
 *  - a document-PiP window is a top-level `Chrome_WidgetWin_*` window that is
 *    always-on-top (WS_EX_TOPMOST), and its native title is the opener page's
 *    `<title>` — fixed when the window is created; later `document.title`
 *    changes don't reach it. Ordinary browser windows are not topmost and
 *    carry a " - Google Chrome" style suffix, so "visible + topmost + Chrome
 *    class + exact title" picks out our PiP window. Several matches (two csm
 *    pages pinned) → the page sends its own window position as a hint; no
 *    clear winner means "don't touch anything".
 *  - Chrome limits a PiP window to 240x58 (content) … 80% of the screen
 *    height — its answer to WM_WINDOWPOSCHANGING / WM_GETMINMAXINFO. A resize
 *    with SWP_NOSENDCHANGING skips that answer: the window takes any size
 *    (full work-area height, or a 56px button), Chrome renders it, and keeps
 *    it when moved without a size change. A move/drag THROUGH Chrome
 *    re-applies the minimum (a 64px window became 242px wide), so the
 *    floating button is never moved through Chrome: its title bar is clipped.
 *  - SetWindowRgn on the PiP window works and sticks (moves, resizes,
 *    activation): it clips Chrome's own top bar and makes the round shapes.
 *    Outside the region, clicks go to the windows below.
 *  - the web content is the `Chrome_RenderWidgetHostHWND` child: its rect
 *    gives Chrome's own bar height (34px at 96 DPI) and the 1px borders.
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
 * C# used by the dock/float scripts and the switch script (focus.js). Pure
 * Win32; compiled once and then loaded from a cached DLL (powershell.js).
 */
export const LAYOUT_CS = String.raw`
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public static class CsmLayout {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cb; public RECT mon; public RECT work; public uint flags; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
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
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern int SetWindowRgn(IntPtr h, IntPtr rgn, bool redraw);
  [DllImport("gdi32.dll")] static extern IntPtr CreateEllipticRgn(int l, int t, int r, int b);
  [DllImport("gdi32.dll")] static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int w, int h);
  [DllImport("gdi32.dll")] static extern int CombineRgn(IntPtr dst, IntPtr a, IntPtr b, int mode);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
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

  /** Why PickPip found nothing: "no-pip" or "ambiguous". */
  public static string PickError = "";

  /**
   * The PiP window: the only match — or, with several csm pages pinned, the
   * one whose window rect (as the page itself reports it: x, y, w, h) is
   * clearly the closest. hw = 0 means no hint.
   */
  public static IntPtr PickPip(string title, int hx, int hy, int hw, int hh) {
    var pips = FindPip(title);
    PickError = "";
    if (pips.Count == 0) { PickError = "no-pip"; return IntPtr.Zero; }
    if (pips.Count == 1) return pips[0];
    if (hw <= 0) { PickError = "ambiguous"; return IntPtr.Zero; }
    IntPtr best = IntPtr.Zero; int bestD = int.MaxValue, second = int.MaxValue;
    foreach (var p in pips) {
      RECT r; GetWindowRect(p, out r);
      int d = Math.Abs(r.L - hx) + Math.Abs(r.T - hy) + Math.Abs(r.R - r.L - hw) + Math.Abs(r.B - r.T - hh);
      if (d < bestD) { second = bestD; bestD = d; best = p; } else if (d < second) second = d;
    }
    if (bestD > 80 || second - bestD < 40) { PickError = "ambiguous"; return IntPtr.Zero; }
    return best;
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
   * it can't fit the new size into its own min/max. Chrome's PiP limits are
   * enforced that way; resized like this it takes the size we give it.
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
  static double Scale(IntPtr h) { uint d = 0; try { d = GetDpiForWindow(h); } catch { } return d > 0 ? d / 96.0 : 1.0; }
  static int Px(int css, double s) { return (int)Math.Round(css * s); }
  static string Rect(int x, int y, int w, int hh) { return x + "," + y + "," + w + "," + hh; }

  /**
   * Where the web content sits inside the visible frame — left, top (Chrome's
   * own bar), right, bottom — from the Chrome_RenderWidgetHostHWND child.
   */
  static int[] Insets(IntPtr p) {
    RECT v = Visible(p); RECT c = new RECT(); bool found = false;
    EnumChildWindows(p, (h, l) => {
      if (Cls(h) == "Chrome_RenderWidgetHostHWND") { GetWindowRect(h, out c); found = true; return false; }
      return true;
    }, IntPtr.Zero);
    if (!found || c.R <= c.L || c.T < v.T) return new int[] { 1, Px(34, Scale(p)), 1, 1 };
    return new int[] { c.L - v.L, c.T - v.T, v.R - c.R, v.B - c.B };
  }

  // --- docked --------------------------------------------------------------

  /** Pin the PiP window to the edge it is nearest to: top to bottom of the work area. */
  public static string DockH(IntPtr p) {
    SetWindowRgn(p, IntPtr.Zero, true); // back from the floating shapes
    RECT v = Visible(p); RECT work = Work(p);
    int w = v.R - v.L; bool right = OnRight(v, work);
    PlaceVisible(p, right ? work.R - w : work.L, work.T, w, work.B - work.T, true);
    return right ? "right" : "left";
  }

  public static string Dock(string title) {
    IntPtr p = PickPip(title, 0, 0, 0, 0);
    return p == IntPtr.Zero ? PickError : DockH(p);
  }

  /** Is the PiP window (still) flush with a side edge, top and bottom? */
  public static bool IsDockedH(IntPtr p) {
    RECT v = Visible(p); RECT work = Work(p);
    bool side = Math.Abs(v.R - work.R) <= 2 || Math.Abs(v.L - work.L) <= 2;
    return side && Math.Abs(v.T - work.T) <= 2 && Math.Abs(v.B - work.B) <= 2;
  }

  /** "x,y,w,h" of the free area beside the docked PiP window ("" if no room). */
  public static string FreeRectH(IntPtr p, int minFree) {
    RECT v = Visible(p); RECT work = Work(p);
    int x0, x1;
    if (OnRight(v, work)) { x0 = work.L; x1 = Math.Min(v.L, work.R); }
    else { x0 = Math.Max(v.R, work.L); x1 = work.R; }
    if (x1 - x0 < minFree) return "";
    return Rect(x0, work.T, x1 - x0, work.B - work.T);
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

  // --- floating ------------------------------------------------------------

  static RECT target;

  /**
   * Floating layout, sizes in CSS px (scaled to the monitor's DPI here):
   *  "fab"   — only the round button (fab x fab), margin away from the bottom
   *            corner on the side the window is on;
   *  "panel" — the list above it (panel wide, as tall as the work area
   *            allows, rounded corners) and a round close button where the
   *            button was.
   * The window region clips everything else, Chrome's own bar included.
   * Returns "<mode> <side> <x,y,w,h of the terminals' area>".
   */
  public static string FloatH(IntPtr p, string mode, int fabC, int gapC, int marginC, int panelC, int radiusC, int minFree) {
    RECT v = Visible(p); RECT work = Work(p); bool right = OnRight(v, work);
    double s = Scale(p);
    int fab = Px(fabC, s), gap = Px(gapC, s), m = Px(marginC, s), rad = Px(radiusC, s);
    int[] ins = Insets(p);
    RECT wr; GetWindowRect(p, out wr);
    int bl = v.L - wr.L, bt = v.T - wr.T; // invisible borders, left / top
    bool panel = mode == "panel";
    int cw = panel ? Math.Max(fab, Math.Min(Px(panelC, s), work.R - work.L - 2 * m)) : fab;
    int top = panel ? work.T + m : work.B - m - fab; // content top
    int ch = work.B - m - top;                        // content height
    int x = (right ? work.R - m - cw : work.L + m) - ins[0];
    int y = top - ins[1];
    int w = cw + ins[0] + ins[2], hh = ch + ins[1] + ins[3];
    PlaceVisible(p, x, y, w, hh, true);
    target.L = x; target.T = y; target.R = x + w; target.B = y + hh;
    int cx = bl + ins[0], cy = bt + ins[1]; // content origin, window coordinates
    IntPtr rg;
    if (!panel) {
      rg = CreateEllipticRgn(cx, cy, cx + fab + 1, cy + fab + 1);
    } else {
      int ph = ch - gap - fab;
      rg = CreateRoundRectRgn(cx, cy, cx + cw + 1, cy + ph + 1, 2 * rad, 2 * rad);
      int bx = right ? cx + cw - fab : cx;
      IntPtr b = CreateEllipticRgn(bx, cy + ph + gap, bx + fab + 1, cy + ph + gap + fab + 1);
      CombineRgn(rg, rg, b, 2); // RGN_OR
      DeleteObject(b);
    }
    SetWindowRgn(p, rg, true); // the system owns rg now
    int col = m + fab + m;
    int fx0 = right ? work.L : work.L + col, fx1 = right ? work.R - col : work.R;
    string free = fx1 - fx0 >= minFree ? Rect(fx0, work.T, fx1 - fx0, work.B - work.T) : "";
    return (panel ? "panel" : "fab") + " " + (right ? "right" : "left") + " " + free;
  }

  /** Is the window still where FloatH put it? (Chrome may still be settling.) */
  public static bool SettledH(IntPtr p) {
    RECT v = Visible(p);
    return Math.Abs(v.L - target.L) <= 2 && Math.Abs(v.T - target.T) <= 2
      && Math.Abs(v.R - target.R) <= 2 && Math.Abs(v.B - target.B) <= 2;
  }
}
`;

/** Floating layout sizes (CSS px). The page sends its own; these are the bounds. */
export const FLOAT_DEFAULTS = Object.freeze({ fab: 56, gap: 12, margin: 20, panel: 440, radius: 14 });
const FLOAT_LIMITS = { fab: [32, 128], gap: [0, 64], margin: [0, 200], panel: [280, 1200], radius: [0, 64] };

/**
 * Validated floating sizes (CSS px integers), defaults for anything missing.
 * @param {Partial<typeof FLOAT_DEFAULTS>} [input]
 */
export function floatMetrics(input = {}) {
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(FLOAT_LIMITS)) {
    const n = Math.round(Number(input && input[k]));
    out[k] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : FLOAT_DEFAULTS[k];
  }
  return out;
}

/**
 * The page's own window rect (screen px), to tell two pinned csm pages apart.
 * @param {unknown} hint
 * @returns {[number, number, number, number]}  zeros = no hint
 */
export function pipHint(hint) {
  const h = /** @type {any} */ (hint) || {};
  const nums = [h.x, h.y, h.w, h.h].map((v) => Math.round(Number(v)));
  if (nums.some((v) => !Number.isFinite(v) || Math.abs(v) > 100_000) || nums[2] <= 0 || nums[3] <= 0) return [0, 0, 0, 0];
  return /** @type {any} */ (nums);
}

/** PowerShell: find the PiP window (waiting for it right after it opened) into $pip. */
function findPipScript(hint) {
  const [hx, hy, hw, hh] = pipHint(hint);
  return `$title = ${psString(PIP_WINDOW_TITLE)}
$pip = [IntPtr]::Zero
for ($i = 0; $i -lt 10 -and $pip -eq [IntPtr]::Zero; $i++) {
  $pip = [CsmLayout]::PickPip($title, ${hx}, ${hy}, ${hw}, ${hh})
  if ($pip -eq [IntPtr]::Zero) { if ([CsmLayout]::PickError -eq 'no-pip') { [Threading.Thread]::Sleep(150) } else { break } }
}
`;
}

const DOCK_SCRIPT_BODY = `if ($pip -eq [IntPtr]::Zero) { [Console]::Out.Write([CsmLayout]::PickError + ' ') }
else {
  # Right after it opens, Chrome is still settling the PiP window's initial
  # bounds and can override ours (verified: the first move landed ~60px off
  # the edge). So: place it, check it stayed, re-place if not.
  $res = [CsmLayout]::DockH($pip)
  for ($i = 0; $i -lt 6; $i++) {
    [Threading.Thread]::Sleep(250)
    if ([CsmLayout]::IsDockedH($pip)) { break }
    $res = [CsmLayout]::DockH($pip)
  }
  [Console]::Out.Write($res + ' ' + [CsmLayout]::FreeRectH($pip, ${MIN_FREE_WIDTH}))
}`;

/**
 * Docked layout: pin the window to the screen edge it is nearest to, top to
 * bottom (a first PiP window opens bottom-right, so: right; after the user
 * drags it to the left, Chrome reopens it there and it docks left). Also
 * undoes the floating shapes.
 *
 * @param {{ hint?: object, timeoutMs?: number }} [opts]
 * @returns {Promise<LayoutResult>}
 */
export async function dockPipWindow(opts = {}) {
  if (process.platform !== 'win32') return { result: 'unsupported' };
  const script = `$ErrorActionPreference = 'Stop'
${PS_TYPE_LOADER}
${psUseType('CsmLayout', LAYOUT_CS)}[CsmLayout]::DpiAware()
${findPipScript(opts.hint)}${DOCK_SCRIPT_BODY}`;
  const { stdout, error } = await runPowerShell(script, { timeoutMs: opts.timeoutMs ?? 10_000 });
  return parseDockOutput(stdout, error);
}

/**
 * Floating layout: the round button ("fab") or the open list ("panel"), see
 * CsmLayout.FloatH. `settle`: right after the window opened, re-check a few
 * times that Chrome didn't override the first placement.
 *
 * @param {{ mode: 'fab'|'panel', hint?: object, metrics?: Partial<typeof FLOAT_DEFAULTS>, settle?: boolean }} params
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<LayoutResult>}
 */
export async function floatPipWindow(params, opts = {}) {
  if (process.platform !== 'win32') return { result: 'unsupported' };
  const mode = params && params.mode === 'panel' ? 'panel' : 'fab';
  const m = floatMetrics(params && params.metrics);
  const call = `[CsmLayout]::FloatH($pip, '${mode}', ${m.fab}, ${m.gap}, ${m.margin}, ${m.panel}, ${m.radius}, ${MIN_FREE_WIDTH})`;
  const script = `$ErrorActionPreference = 'Stop'
${PS_TYPE_LOADER}
${psUseType('CsmLayout', LAYOUT_CS)}[CsmLayout]::DpiAware()
${findPipScript(params && params.hint)}if ($pip -eq [IntPtr]::Zero) { [Console]::Out.Write([CsmLayout]::PickError + ' ') }
else {
  $res = ${call}
  for ($i = 0; $i -lt ${params && params.settle ? 6 : 1}; $i++) {
    [Threading.Thread]::Sleep(${params && params.settle ? 250 : 120})
    if ([CsmLayout]::SettledH($pip)) { break }
    $res = ${call}
  }
  [Console]::Out.Write($res)
}`;
  const { stdout, error } = await runPowerShell(script, { timeoutMs: opts.timeoutMs ?? 10_000 });
  return parseDockOutput(stdout, error);
}

/**
 * @typedef {Object} LayoutResult
 * @property {'right'|'left'|'fab'|'panel'|'no-pip'|'ambiguous'|'unsupported'|'error'} result
 *   right/left — docked on that side; fab/panel — floating
 * @property {'right'|'left'} [side]
 * @property {{ x: number, y: number, w: number, h: number }|null} [free]
 *   where terminals go: beside the docked list, or the work area minus the
 *   floating button's column. Its corner is also where they open (wt --pos).
 * @property {string} [error]
 */

/**
 * Parse a layout script's output: `<right|left> [x,y,w,h]`,
 * `<fab|panel> <side> [x,y,w,h]`, or `<no-pip|ambiguous>`. Exported for tests.
 * @param {string} stdout
 * @param {string} [error]
 * @returns {LayoutResult}
 */
export function parseDockOutput(stdout, error) {
  const line = String(stdout || '').trim().split(/\r?\n/).pop() || '';
  const parts = line.split(' ');
  const res = parts[0];
  if (res === 'no-pip' || res === 'ambiguous') return { result: res, free: null };
  let side;
  let rect;
  if (res === 'right' || res === 'left') { side = res; rect = parts[1]; }
  else if ((res === 'fab' || res === 'panel') && (parts[1] === 'right' || parts[1] === 'left')) { side = parts[1]; rect = parts[2]; }
  else return { result: 'error', error: error || (line ? line.slice(0, 200) : 'no output') };
  const m = /^(-?\d+),(-?\d+),(\d+),(\d+)$/.exec(rect || '');
  return {
    result: /** @type {any} */ (res),
    side,
    free: m ? { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) } : null,
  };
}

/**
 * PowerShell single-quoted string literal. Only used for our own constants.
 * @param {string} s
 */
function psString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

export { MIN_FREE_WIDTH, psString };
