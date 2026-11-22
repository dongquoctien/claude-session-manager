import { runPowerShell } from './powershell.js';

/**
 * Native "choose a folder" dialog for the web UI's New session button.
 *
 * A browser can't hand a page the real path of a folder the user picks (the
 * File System Access API returns an opaque handle), so the agent shows the
 * Windows folder picker itself: the Vista-style Common Item Dialog
 * (IFileOpenDialog + FOS_PICKFOLDERS — the same one Explorer uses, with
 * address bar, Quick access and New folder), via PowerShell + Add-Type like
 * focus.js and dock.js.
 *
 * The agent runs in the background, so the dialog is given an invisible,
 * always-on-top owner window that is pulled to the foreground first: it then
 * opens in front of the browser — and of the floating (always-on-top)
 * Sessions window — on the monitor where the mouse is. The dialog runs on its
 * own STA thread (COM requirement). Output is base64(UTF-8 JSON) so a folder
 * name in any script survives the console code page.
 */

/**
 * @typedef {Object} PickResult
 * @property {'picked'|'cancelled'|'busy'|'unsupported'|'error'} result
 *   busy — a picker opened by an earlier click is still on screen
 * @property {string} [path]   the chosen folder (`picked`)
 * @property {string} [error]
 */

export const PICKER_CS = String.raw`
using System; using System.Drawing; using System.Runtime.InteropServices; using System.Threading; using System.Windows.Forms;
public static class CsmPick {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogCo { }
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint n, IntPtr specs);
    void SetFileTypeIndex(uint i);
    void GetFileTypeIndex(out uint i);
    void Advise(IntPtr sink, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem si);
    void SetFolder(IShellItem si);
    void GetFolder(out IShellItem si);
    void GetCurrentSelection(out IShellItem si);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem si);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem si);
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);
  [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumThreadWindows(uint tid, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);

  const uint FOS_NOCHANGEDIR = 0x8, FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_PATHMUSTEXIST = 0x800;
  const uint SIGDN_FILESYSPATH = 0x80058000;
  const int HR_CANCELLED = unchecked((int)0x800704C7);

  static string result, error;

  public static string Pick(string title, string initial) {
    result = null; error = null;
    var t = new Thread(() => { try { result = Run(title, initial); } catch (Exception e) { error = e.Message; } });
    t.SetApartmentState(ApartmentState.STA);
    t.Start();
    t.Join();
    if (error != null) throw new Exception(error);
    return result;
  }

  static void Raise(IntPtr h) {
    if (SetForegroundWindow(h) && GetForegroundWindow() == h) return;
    uint dummy; IntPtr fg = GetForegroundWindow();
    uint fgT = GetWindowThreadProcessId(fg, out dummy), me = GetCurrentThreadId();
    if (fgT != 0 && fgT != me && AttachThreadInput(me, fgT, true)) {
      BringWindowToTop(h); SetForegroundWindow(h); AttachThreadInput(me, fgT, false);
      if (GetForegroundWindow() == h) return;
    }
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
  }

  // The dialog opens with its corner at the owner window; once it is up,
  // move it to the middle of the work area (same thread: the modal loop
  // keeps running WinForms timers).
  static IntPtr FindDialog() {
    IntPtr found = IntPtr.Zero;
    EnumThreadWindows(GetCurrentThreadId(), (h, l) => {
      var s = new System.Text.StringBuilder(64); GetClassName(h, s, 64);
      if (s.ToString() == "#32770" && IsWindowVisible(h)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  static void Center(IntPtr d, Rectangle wa) {
    RECT r; if (!GetWindowRect(d, out r)) return;
    int w = r.R - r.L, hh = r.B - r.T;
    int x = Math.Max(wa.Left, wa.Left + (wa.Width - w) / 2), y = Math.Max(wa.Top, wa.Top + (wa.Height - hh) / 2);
    SetWindowPos(d, IntPtr.Zero, x, y, 0, 0, 0x1 | 0x4 | 0x10);
  }

  static string Run(string title, string initial) {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    var owner = new Form();
    owner.FormBorderStyle = FormBorderStyle.None;
    owner.ShowInTaskbar = false;
    owner.TopMost = true;
    owner.Opacity = 0;
    owner.StartPosition = FormStartPosition.Manual;
    owner.Size = new Size(1, 1);
    Rectangle wa = Screen.FromPoint(Cursor.Position).WorkingArea;
    owner.Location = new Point(wa.Left + wa.Width / 2, wa.Top + wa.Height / 3);
    owner.Show();
    // Started hidden (windowsHide), the process's first ShowWindow may be
    // turned into SW_HIDE: show it again so it can take the foreground.
    if (!IsWindowVisible(owner.Handle)) ShowWindow(owner.Handle, 4);
    Raise(owner.Handle);
    IFileDialog dlg = null;
    try {
      dlg = (IFileDialog)new FileOpenDialogCo();
      uint o; dlg.GetOptions(out o);
      dlg.SetOptions(o | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR);
      if (!String.IsNullOrEmpty(title)) dlg.SetTitle(title);
      if (!String.IsNullOrEmpty(initial)) {
        try { IShellItem f; SHCreateItemFromParsingName(initial, IntPtr.Zero, typeof(IShellItem).GUID, out f); dlg.SetFolder(f); } catch { }
      }
      var timer = new System.Windows.Forms.Timer();
      timer.Interval = 10;
      int ticks = 0;
      timer.Tick += (s, e) => {
        IntPtr d = FindDialog();
        if (d != IntPtr.Zero) { Center(d, wa); timer.Stop(); }
        else if (++ticks > 300) timer.Stop();
      };
      timer.Start();
      int hr = dlg.Show(owner.Handle);
      timer.Stop();
      if (hr == HR_CANCELLED) return null;
      if (hr != 0) Marshal.ThrowExceptionForHR(hr);
      IShellItem item; dlg.GetResult(out item);
      string p; item.GetDisplayName(SIGDN_FILESYSPATH, out p);
      return p;
    } finally {
      if (dlg != null) Marshal.ReleaseComObject(dlg);
      owner.Close();
      owner.Dispose();
    }
  }
}
`;

/**
 * `__CSM_PARAMS__` becomes base64(JSON) — no quote characters, so a folder
 * name can't break out of the literal. The C# sits in a single-quoted
 * (verbatim) here-string.
 */
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$P = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__CSM_PARAMS__')) | ConvertFrom-Json
$r = [ordered]@{ result = $null; path = $null; error = $null }
try {
  Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
__CSM_PICKER__
'@
  $picked = [CsmPick]::Pick([string]$P.title, [string]$P.initial)
  if ($picked) { $r.result = 'picked'; $r.path = $picked } else { $r.result = 'cancelled' }
} catch { $r.result = 'error'; $r.error = $_.Exception.Message }
$json = $r | ConvertTo-Json -Compress
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
`;

/**
 * @param {{ title?: string, initial?: string|null }} params
 * @returns {string}
 */
export function buildPickerScript({ title = '', initial = null } = {}) {
  const json = JSON.stringify({ title: title || '', initial: initial || null });
  return PS_SCRIPT
    .replace('__CSM_PARAMS__', () => Buffer.from(json, 'utf8').toString('base64'))
    .replace('__CSM_PICKER__', () => PICKER_CS);
}

/**
 * Decode the helper's stdout (base64 of UTF-8 JSON).
 * @param {string} stdout
 * @returns {PickResult|null}
 */
export function parsePickerOutput(stdout) {
  try {
    const r = JSON.parse(Buffer.from(String(stdout).trim(), 'base64').toString('utf8'));
    if (!r || typeof r.result !== 'string') return null;
    /** @type {PickResult} */
    const out = { result: r.result };
    if (r.path) out.path = r.path;
    if (r.error) out.error = r.error;
    return out;
  } catch {
    return null;
  }
}

let picking = false;

/**
 * Show the folder picker and wait for the user. One at a time: while a
 * dialog is open, another call answers `busy` instead of stacking a second.
 *
 * @param {{ title?: string, initial?: string|null }} [params]
 *   initial — folder the dialog opens in (ignored when it doesn't exist)
 * @param {{ timeoutMs?: number, run?: typeof runPowerShell, platform?: NodeJS.Platform }} [opts]
 * @returns {Promise<PickResult>}
 */
export async function pickFolder(params = {}, opts = {}) {
  if ((opts.platform || process.platform) !== 'win32') return { result: 'unsupported' };
  if (picking) return { result: 'busy' };
  picking = true;
  try {
    // Someone may leave the dialog open for a while; after 10 minutes the
    // helper is ended (which closes the dialog) so nothing lingers.
    const r = await (opts.run || runPowerShell)(buildPickerScript(params), { timeoutMs: opts.timeoutMs ?? 600_000 });
    return parsePickerOutput(r.stdout) || { result: 'error', error: r.error || 'no result from the folder picker' };
  } finally {
    picking = false;
  }
}
