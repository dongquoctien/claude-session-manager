# CLAUDE.md

Guidance for working in this repo. Read before making changes.

## What this is

`claude-session-manager` lists every Claude Code conversation under
`~/.claude/projects` and reopens the picked one in a new terminal, already
resuming, in the right directory. Ships as a CLI (`csm`), a local web UI, and
an Electron desktop app.

## Architecture

npm **workspaces monorepo**, plain **ESM JavaScript** (no TypeScript build, no
bundler — keep it that way; it runs directly on Node).

```
packages/
  core/     @csm/core  — scan/parse .jsonl, titles, launcher, favorites, trash,
                         live sessions + switch-to-window (open.js),
                         new session in a chosen folder (newSession.js,
                         folderPicker.js)
  cli/      @csm/cli   — `csm` bin (list/search/open/fav/rm/restore/trash)
  agent/    @csm/agent — zero-dep node:http server + static web UI host
  ui/       @csm/ui    — static HTML/JS/CSS (inline Lucide SVG icons)
  desktop/  @csm/desktop — Electron wrapper: starts the agent, loads its URL
```

`cli`, `agent`, `desktop` all `import` from `core`. The desktop app reuses the
**exact** agent + web UI (no Electron-specific UI path) — it just hosts the
agent on a random free port and opens its token URL in a BrowserWindow.

## Commands

```sh
npm install              # workspaces
npm test                 # node --test across packages
npm run csm -- <args>    # CLI
npm run web              # web UI (agent + browser)
npm run desktop          # Electron app (dev)
npm run desktop:dist     # build Windows .exe installer
```

## Data model (verified facts — don't re-derive)

- A conversation = `~/.claude/projects/<slug>/<uuid>.jsonl`.
- ~1 in 5 also has a sibling dir `<slug>/<uuid>/` (`tool-results/`, can be MB).
  **Any delete must move both.**
- The folder `<slug>` is a lossy encoding of the cwd — never decode it back;
  read the real `cwd`/`gitBranch` from inside the `.jsonl`.
- **A session UUID is NOT unique across slugs.** When a conversation is started
  in a git worktree then continued in the main repo, Claude Code leaves the
  *same* `<uuid>.jsonl` under both slugs — typically a tiny stub (~119 B, dead
  worktree) plus the real transcript (MB+, live folder). So `findSession` keys
  on id **and** disambiguates: same-UUID hits auto-prefer the live/larger/newer
  copy (`preferReal`), and only *distinct* ids sharing a prefix are `ambiguous`.
  Callers can pin a copy with `opts.slug` (CLI `--folder`, web sends
  `projectSlug` on open/delete) so the wrong file is never opened or trashed.
- **`gitBranch` changes over a conversation's life** (user checks out other
  branches mid-session). Claude Code's `/resume` shows the LATEST branch, so we
  read it from the file TAIL (`readTail`), not the head — the head branch
  is the oldest. Using the head made web disagree with `/resume`.
- `aiTitle` may sit deep in the file; `lastPrompt` around line ~16. The parser
  streams the head, capped (`MAX_HEAD_LINES`), so 50MB+ files stay fast.
- ~30% of conversations have no `aiTitle` → 5-tier title fallback
  (`customName → aiTitle → lastPrompt → first user msg → "Untitled · date"`);
  harness wrappers (`<local-command-stdout>`, `<command-name>`, …) are filtered.
- **`/rename` writes `{"type":"custom-title","customTitle":…}` into the
  `.jsonl`** (plus an `agent-name` record, which also mirrors AI titles — don't
  use it). Renaming again appends a new record, so the **latest** wins, and
  Claude Code keeps re-appending the current one near EOF (measured ≤ ~33KB
  from the end), while the first one can be 88k+ lines in. So the parser reads
  it from the **tail** (same pass as `gitBranch`), head as fallback. It's the
  top `customName` title tier.
- **`~/.claude/sessions/<pid>.json` `name` is mostly NOT a rename.** Every live
  process gets a `name`; `nameSource: "derived"` is auto-generated from the
  folder (`oh-api-08`, `claude-session-manager-10`). Only `nameSource: "user"`
  is a `/rename`. `sessionNames.js` keeps just those, keyed by the `sessionId`
  *inside* the file (PIDs recycle; latest `updatedAt` wins), as a fallback
  after the `.jsonl` title. Reading every `name` there was a bug: derived names
  replaced real titles.
- **`~/.claude/sessions/` is the registry of RUNNING processes** → the source
  of "open right now" (`liveSessions.js`). One `<pid>.json` per running
  interactive `claude`: `sessionId`, `status` (`busy` | `idle` | `waiting`,
  absent for the first second of startup), `waitingFor`, `statusUpdatedAt`,
  `kind`, `entrypoint`. Removed on a normal exit, but **left behind when the
  process is killed** (verified: `Stop-Process -Force`) — so liveness is
  "file exists AND PID alive". `procStart` is the process creation time as a
  Windows FILETIME, equal to the real creation time to the 100ns; it's the
  PID-reuse guard (`verifyLiveSessions`: one PowerShell call per new process,
  cached; FILETIMEs exceed 2^53 → compare as BigInt).
- **A `claude` started from inside another Claude session is a "child
  session"**: it inherits `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`,
  `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_*`, `CLAUDE_PID`…, and then
  saves NO transcript and is NOT registered in `~/.claude/sessions`.
  `launchEnv()` strips exactly those markers (never all `CLAUDE_CODE_*`: user
  config like `CLAUDE_CODE_GIT_BASH_PATH` must survive). Windows Terminal hands
  the caller's env to the new tab, so stripping at spawn is enough.
- Honors `CLAUDE_CONFIG_DIR` (tests rely on this to use a temp dir).

## Launcher gotchas (hard-won — keep the fixes)

- **`wt` needs `--`:** `wt -d <cwd> -- claude --resume <id>`. Without `--`, wt
  parses claude's flags as its own and claude launches without `--resume`.
- **wt splits on `;` even after `--`** (a `;` starts another command/tab).
  Every wt arg goes through `wtEscape` (`;` → `\;`); verified that `x\;y`
  arrives as `x;y` and a start folder `semi;colon` opens correctly. A `"`
  does NOT survive wt's re-quoting (`quo"te` → `quote`), so session names
  are stripped of quotes (`cleanSessionName`).
- **`claude --resume` needs the FULL UUID**, not a prefix/title. The CLI/agent
  resolve prefix → UUID before launching; never pass a prefix to claude.
- **wt.exe detection:** it's a 0-byte App Execution Alias under WindowsApps, so
  `fs.existsSync` is false even though it runs — trust `where.exe` exit status.
- **Color:** the spawned child inherits env; strip `NO_COLOR`/`CLICOLOR`
  (`colorEnv()`) or claude renders colorless.
- `--dangerously-skip-permissions` is ON by default (CLI `--safe` opts out;
  web "skip perms" toggle).
- Cross-platform: `terminal` can be `wt|powershell|macos|linux|auto`.
- **Open = switch if already running** (`open.js`, shared by CLI + agent):
  live → `focusSessionWindow`; not live / `gone` / `stale` → launch; `fork`
  always launches (new id). If the window can't be raised (`no-window`,
  non-Windows, error) it returns `running` and spawns NOTHING — never a second
  `claude` on one transcript. Live state is read fresh at open time, not from
  the 3s scan cache. The session itself is looked up in the LAST scan
  whatever its age (`findForAction`; rescan only if the id is missing or its
  file is gone) — a rescan on every click cost ~200ms.

## New session in a chosen folder (`core/newSession.js`, `/api/new`)

The web UI's `+` (also in the pinned window) starts a NEW conversation — what
`cd <folder>` + `claude --dangerously-skip-permissions` does by hand. Verified:
- **csm picks the id: `claude --session-id <uuid> [--name <name>]`.** The
  registry entry then carries that `sessionId` (and the name, with
  `nameSource: "user"`) as soon as claude has started, so the Running count
  (and the registry fallback of placement) work before any transcript
  exists. **No `.jsonl` is written until the first message** — the
  row appears in the list only then.
- **Registration is late — don't wait for it to place a window.** claude
  writes its registry file only once startup is done (~0.7s normally, 27s
  measured once with MCP servers timing out) and, in a folder it has never
  seen, only after the user answers its **"trust this folder?"** prompt —
  shown even with `--dangerously-skip-permissions`. So `placeLaunched` finds
  the new process by the session id on its command line (`--resume <id>` /
  `--session-id <id>`, WMI via `[wmisearcher]`, created after the launch;
  wt/OpenConsole skipped) and places it as soon as it exists (~0.6–0.9s after
  the click, verified also while the trust prompt waits). Registry-based
  `placeWhenLive` (90s) is only the fallback. Fork works too (the forked
  process still carries the original id; older processes are filtered out).
- **No jump:** the dock call returns the top-left of the free area beside the
  pinned list (`FreeOrigin`); the agent keeps it (`pipFree`) and launches
  pinned terminals with `wt --pos=x,y` (one argument: a negative x must not
  look like a flag; verified wt honours it), so the window appears in place
  and is then only resized to fit.
- Folder input: full path only (Windows: drive or UNC — a bare `\x` would mean
  "the agent's drive"), must exist and be a directory; `"…"` from Explorer's
  "Copy as path" and a leading `~` are accepted. Recent folders = distinct
  `cwd` of scanned conversations whose folder still exists (case-insensitive
  on Windows), newest first.
- **Folder dialog (`core/folderPicker.js`, `/api/folders/pick`):** a browser
  can't return a real folder path, so the agent shows the Windows
  IFileOpenDialog (`FOS_PICKFOLDERS`) via PowerShell + Add-Type, on its own
  STA thread. From the background agent it opens **in front, focused and
  topmost** (also above the pinned PiP window) because it is owned by an
  invisible TopMost WinForms form that is first pulled to the foreground
  (same AttachThreadInput / Alt-tap trick as focus.js). The dialog opens with
  its corner at the owner, so a WinForms timer (runs inside the modal loop)
  centers it on the work area of the monitor under the mouse. Result is
  printed as base64(UTF-8 JSON) — a Vietnamese folder name survives the
  console code page. One dialog at a time (`busy`); killed after 10 min.

## Switching to a running session (Windows, `core/focus.js`)

Hard-won, verified on real windows — keep it:
- **PID → window: `AttachConsole(pid)` + `GetConsoleWindow()`.** Under WT that
  is a `PseudoConsoleWindow` whose `GA_ROOTOWNER` is the exact
  `CASCADIA_HOSTING_WINDOW_CLASS` window. Do NOT use the parent PID's main
  window: one `WindowsTerminal.exe` hosts many windows.
- **Tab: title marker.** While attached, `SetConsoleTitle(<unique marker>)`,
  find the WT tab with that name via UI Automation, `SelectionItemPattern
  .Select()`, then restore the title. Exact even when tabs share a title
  (fresh sessions are all "Claude Code"). Title matching is only a fallback.
- **Foreground lock:** `SetForegroundWindow` → `AttachThreadInput` → Alt-tap,
  then `FlashWindowEx` (`flashed`). Works from the background agent (web UI);
  the desktop app's helper is a child of the foreground Electron process.
- **How the helpers run (`core/powershell.js`):** `powershell.exe
  -EncodedCommand <tiny bootstrap>` (absolute `%SystemRoot%` path, no temp
  file, no execution-policy issue) that reads the real script from **stdin**
  as base64 UTF-8. The script used to BE the `-EncodedCommand` (UTF-16 +
  base64 = 2.7 bytes/char): with its embedded C# it was 32,200 of Windows'
  32,767-char command-line limit, and a ~70-char Vietnamese title overflowed
  it (spawn ENAMETOOLONG → "couldn't bring up"). Titles go into the script
  only as base64 literals, so they can't inject code. Nothing is written to
  stdout while attached to the target console.
- **Speed (measured, warm):** ~0.35–0.4s from click to the window in front,
  of which ~0.2s is just PowerShell starting (unavoidable without a resident
  process — deliberately not done). What made it 0.8–1s before:
  - `Add-Type -TypeDefinition` runs the C# compiler every call (~150ms per
    type). `psUseType`/`Use-CsmType` compile once into
    `%TEMP%\csm-ps\<Type>-<sha>.dll` and then `Assembly.LoadFrom` it (~12ms);
    an edited type gets a new hash, older builds are deleted on compile.
  - Cmdlets that auto-load a module: `ConvertFrom-Json` ~100ms (Utility),
    `Get-Process` ~45ms (Management); also ConvertTo-Json, New-Object,
    Start-Sleep, Get-Date, Join-Path, `Add-Type -AssemblyName`. The hot path
    uses .NET only (a test enforces it); the JSON result is built by hand.
  - **PowerShell names are case-insensitive:** a loop variable `$p` IS the
    params object `$P` (that bug broke the launched-process search once).
- The PID comes from the registry, never from the client request.

## Pinned Sessions window (web, Chrome/Edge — `core/dock.js`, "Pin" button)

The Sessions list can float in a Document Picture-in-Picture window pinned to
a screen edge; terminals opened/switched to go in the space beside it
(`/api/open` with `place: true`). Verified on Chrome 157 — keep these:
- **Finding the PiP window natively:** a visible, **topmost**
  `Chrome_WidgetWin_*` window whose title is **exactly** the page `<title>`
  (`PIP_WINDOW_TITLE`, a test keeps it in sync with index.html). The title is
  fixed at creation: later `document.title` changes (opener or PiP doc) never
  reach it, so a per-window marker is impossible. ≠1 match → touch nothing.
- **Chrome caps PiP height at 80% of the screen** (`requestWindow` and edge
  drags), via its answer to WM_WINDOWPOSCHANGING/WM_GETMINMAXINFO. Docking
  resizes it with **`SWP_NOSENDCHANGING`**, which skips that: the PiP then
  spans the whole work area, Chrome renders it at that size and keeps it when
  the window is moved (verified: 1032px of a 1032px work area). Dragging an
  edge by hand still goes through Chrome and stays capped — re-pin to get the
  full height back.
- **First move races Chrome:** right after opening, Chrome is still settling
  the initial bounds and overrode ours (~60px off the edge). `dockPipWindow`
  re-checks and re-places until it stays flush.
- Dock side = the half the window is in, so Chrome's own "reopen where it
  was" remembers the user's side. Placement works on the VISIBLE frame
  (`DWMWA_EXTENDED_FRAME_BOUNDS`, invisible borders excluded), per-monitor
  DPI aware.
- **Web side, moving DOM into the PiP document:** nodes are moved (listeners
  survive) and put back on `pagehide`. Things that DON'T follow the node:
  `<use href="#i-…">` resolves in its own document (clone the sprite in);
  a `ResizeObserver` only sees its own window's document (create one from
  the PiP window); listeners on `document` (keydown, dropdown outside-click,
  modal Escape) must be bound on the node's `ownerDocument`; stylesheet must
  finish loading before measuring (else `--filterbar-h` is wrong and sticky
  headers overlap rows).
- The page is responsive down to 320px (the PiP is ~480px). There used to be
  `min-width: 700px` on `html, body` for the old Electron window — it forced
  horizontal overflow in the PiP; only Monitor/Office keep a 700px floor.

## Live list (`agent/src/live.js`, `/api/live`)

Separate from `/api/stream` on purpose: the metrics stream re-scans every
transcript (~7s CPU cold, ~200ms per push), the live feed only reads the tiny
registry (~0.1ms). One hub per agent: fs.watch on `~/.claude/sessions` + 5s
poll (catches killed processes, whose files don't change), push only on
change, watch only while a client listens. The Sessions tab stays subscribed;
it patches badges in place and refetches the list once when an unknown
session id goes live.

## Delete = move-to-trash (never rm)

`core/trash.js` moves the `.jsonl` + sibling dir into
`~/.claude/.csm-trash/<ts>-<uuid>/` with a `.csm-meta.json`, fully restorable.
Guards: UUID-shaped id only + `assertInside(projectsDir)` against traversal;
restore refuses to overwrite an existing conversation; `rename` with copy+rm
fallback on `EXDEV`.

## Agent security (don't weaken)

Binds `127.0.0.1` only; per-run timing-safe token (header or `?token=`); Host
allowlist (anti DNS-rebind); static path-traversal guard. Mutating endpoints
(`/api/open`, `/api/delete`, `/api/restore`) only accept a sessionId present in
the current scan — never an arbitrary path or command. The one exception is
`/api/new`: it takes a folder, which must be an existing directory given as a
full path; the program is always `claude`, the session id is generated
server-side, and the client only adds an optional name (control chars and
quotes stripped, one argv entry, never through a shell) and the
skip-permissions flag.

## Web UI build/serve notes

- Static files served by the agent with `cache-control: no-store` → editing
  CSS/JS shows up on reload, no rebuild. The desktop `.exe` bundles a snapshot,
  so UI changes need `npm run desktop:dist` to appear there.
- Token is injected into `index.html` via the `%%CSM_TOKEN%%` placeholder
  (deliberately not a JS identifier, so `replaceAll` can't corrupt a variable).
- Full-page scroll: `body { min-height: 100% }` (NOT `height: 100%`, which
  clamps body to the viewport and breaks sticky bars on scroll).
- No emoji in the UI — inline Lucide SVG sprite + `icon(name)` helper.

## Building the .exe (Windows)

`electron-builder` extracts `winCodeSign` which contains macOS symlinks →
needs **Windows Developer Mode ON** (or admin) or extraction fails. If a build
errors on `app-builder.exe` ENOENT, run
`npm install app-builder-bin --no-save --force` once. Electron binary can be
fetched via `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`.
`release/` is gitignored.

## Conventions

- Keep ESM JS + JSDoc; no TS, no bundler.
- Tests: `node:test`, no external deps. Run `npm test` before committing.
- When testing delete/launch against real data, use **throwaway** sessions —
  never delete the user's real conversations.
