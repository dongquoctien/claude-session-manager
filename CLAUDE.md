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
                         live sessions + switch-to-window (open.js)
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
  the 3s scan cache.

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
- The script runs via `powershell.exe -EncodedCommand` (absolute
  `%SystemRoot%` path, no temp file, no execution-policy issue); params are
  embedded as base64 JSON so a title can't inject code. Nothing is written to
  stdout while attached to the target console. ~0.7s per switch.
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
- **Chrome caps PiP height (~85% of the work area)** — "full height" is as
  tall as Chrome allows. Width/position can be set with SetWindowPos.
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
the current scan — never an arbitrary path or command.

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
