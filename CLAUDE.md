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
  core/     @csm/core  — scan/parse .jsonl, titles, launcher, favorites, trash
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
  read it from the file TAIL (`readTailBranch`), not the head — the head branch
  is the oldest. Using the head made web disagree with `/resume`.
- `aiTitle` may sit deep in the file; `lastPrompt` around line ~16. The parser
  streams the head, capped (`MAX_HEAD_LINES`), so 50MB+ files stay fast.
- ~30% of conversations have no `aiTitle` → 4-tier title fallback
  (`aiTitle → lastPrompt → first user msg → "Untitled · date"`); harness
  wrappers (`<local-command-stdout>`, `<command-name>`, …) are filtered out.
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
