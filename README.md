# claude-session-manager

List and instantly reopen any **Claude Code** conversation across all your
folders — without remembering which directory it lived in.

Claude Code stores every conversation under `~/.claude/projects/<folder>/<id>.jsonl`.
To resume one you normally have to remember the folder, open a terminal, `cd`
there, and run `/resume`. With dozens of folders and hundreds of conversations
that gets painful fast. `csm` lists them all in one place and reopens the one
you pick in a new terminal, in the right directory, already resuming.

> Status: **Phase 1 (CLI)** working on Windows. Web UI and desktop app are
> planned — see [PLAN.md](./PLAN.md).

## Requirements

- Node.js >= 18
- Claude Code installed (`claude` on your PATH)
- Windows (Windows Terminal `wt.exe` preferred; falls back to PowerShell).
  macOS/Linux launching is planned.

## Install (local, from source)

```sh
git clone https://github.com/dongquoctien/claude-session-manager
cd claude-session-manager
npm install
```

Run via npm:

```sh
npm run csm -- list
```

Or link the `csm` command globally:

```sh
npm link -w @csm/cli
csm list
```

## Usage

```sh
csm list                 # all conversations, grouped by folder, newest first
csm list news-tok        # filter by a query (title / folder / branch / id)
csm search dashboard     # same as `list <query>`
csm open <id|prefix>     # open a terminal and resume that conversation
csm open 0ef59423        # id prefix is enough if unambiguous
csm help
```

Useful flags:

| Flag | Applies to | Meaning |
|------|-----------|---------|
| `--json` | list/search | machine-readable output |
| `--limit <n>` | list/search | cap number of rows |
| `--dry-run` | open | print the launch command, don't run it |
| `--fork` | open | resume with `--fork-session` (new id, keeps history) |
| `--terminal <wt\|powershell>` | open | force a terminal (default: auto) |

## How titles are resolved

About 30% of conversations have no AI-generated title, so `csm` falls back in
order: **aiTitle → last prompt → first user message → "Untitled · <date>"**.
Harness-injected text (command wrappers, system reminders) is ignored so it
never becomes a title.

## How it finds & opens conversations

- Scans every `*.jsonl` under `~/.claude/projects` (honors `CLAUDE_CONFIG_DIR`).
- Reads only the head of each file (streaming, capped) so even 50 MB+
  conversations don't slow it down — full scan of ~270 files runs in ~250 ms.
- Reads the real `cwd` and `gitBranch` recorded inside each conversation, so it
  opens the exact folder/worktree (it does **not** guess from the folder name).
- Conversations whose folder no longer exists are flagged as `(missing)`.

## License

MIT
