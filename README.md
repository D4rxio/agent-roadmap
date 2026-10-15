# Roadmap — shared planning state for coding agents

A lightweight, file-based roadmap that lets multiple agents share the same execution plan, backlog,
priorities, dependencies and progress.

Every Claude Code session reads the same state when it starts and writes back what it did; subagents
tick off their own steps; you see the whole picture in a side pane. You no longer have to piece together
what happened across five chats, and a fresh session knows where things stand.

<p align="center"><img src="docs/pane.svg" width="720" alt="The Roadmap pane: tracks with progress bars and priorities, a checkpoint awaiting confirmation, steps with their state, and the sessions and subagents working now"></p>
<p align="center"><sub>Illustration with sample data.</sub></p>

**What it is not:** a project manager. There are no accounts, assignees, sprints, estimates, comments or
boards. It is a small shared state that agents and you both read and write — the plan, what is done,
what is next, what waits on whom — kept as plain JSON files.

- **Shared across sessions.** Start a new chat for every task: each one reads the roadmap when it starts
  and writes back what it did. Parallel sessions never overwrite each other.
- **Agents tick their own steps.** Put `#<track>/<id>` in a subagent's description (e.g.
  `#api/2.1 Map the endpoints`) and the step gets a green ✓ when the subagent finishes.
- **You stay in charge.** Agents report, you close: a step marked as a checkpoint waits for your
  **Confirm ✓**, and your priorities and backlog decisions always win over an agent's.
- **Memory for your agents.** A new session starts knowing the tracks, the open steps in priority order,
  what is blocked, and what is set aside in the backlog.

## Install

In a Claude Code terminal session:

```
/plugin install roadmap --marketplace D4rxio/claude-roadmap
```

Answer `y` to add the marketplace, then pick a scope. The desktop app's Code tab loads plugins installed
from a terminal at the user scope.

## Use

Ask Claude for a roadmap in plain words:

> lay out a roadmap track for the API work: discovery, implementation, release, with a checkpoint before release

or let it read and update one as it works. The pane opens on its own in the desktop app; anywhere else:

| Command | What it does |
|---|---|
| `/roadmap` | show or hide the pane |
| `/roadmap show`, `/roadmap hide` | open or close the pane |
| `/roadmap copy` | copy the whole roadmap as Markdown |
| `/roadmap band` | show or hide the one-line summary above the prompt |

### The pane

- **Tracks.** One card per workstream: progress bar (done, awaiting you, running, blocked), recent
  momentum ("yesterday +3 · moved 14:02"), and the steps when expanded.
  - Click a step's icon to move it ○ → ◐ → ✓ (your word, so it also closes a checkpoint).
  - Click the `P·` chip to raise its priority: P3 → P2 → P1 → P0.
  - Hover a step for **Backlog** (set it aside), and on your own items **✎** (rename) and **✕** (remove).
  - Hover a track header for **Backlog** to set the whole track aside.
  - **+ Add an item** at the bottom of a track adds your own step, marked **✎ you**. Agents may refine
    it, but they never lose it.
  - **⧉ Copy as Markdown** copies one track.
- **Days.** Steps done per day over the last two weeks, and what happened each day: done, started,
  sessions, agents.
- **Backlog.** Everything set aside, tracks and steps, with **↺ Restore**.
- **Needs you.** Checkpoints waiting for **Confirm ✓ / Reject**, and failed steps.
- **Working now.** Live sessions and subagents and what each one is doing this moment.

### Tools the model gets

| Tool | Purpose |
|---|---|
| `roadmap plan` | lay out or re-lay one track: phases, steps, checkpoints, `blocked_by` dependencies |
| `roadmap mark` | report a step's status with evidence; propose a priority or backlog (`<track>/*` for a whole track) |
| `roadmap status` | read every track's open steps and the sessions working now |

## Where the data lives

Everything stays on your machine, in `~/.claude/roadmap/`: one small JSON file per event, plus a
heartbeat file per live session. Nothing is sent anywhere. Other tools can take part by following
[the journal format](docs/journal-format.md).

To keep a roadmap with a project instead, set `CLAUDE_ROADMAP_DIR` to a folder inside the repository
(for example `.roadmap/`) and commit its `events/` folder: every event is its own file, so merging two
branches' roadmaps is merging two sets of files, with no conflicts. Keep `live/` out of git; it only says
which sessions are working right now.

## Develop

```
claude plugin validate .
claude plugin test .
```

To run your working copy instead of the installed one, add its folder to `CLAUDE_CODE_PLUGIN_DIRS`.

## Suggestions welcome

This started as a tool for one person juggling many parallel Claude sessions, and it is shaped by real
use. Ideas, rough edges and "it would be great if…" are all welcome: open an
[issue](https://github.com/D4rxio/claude-roadmap/issues) or a pull request. If you change the journal
format, update [docs/journal-format.md](docs/journal-format.md) and add a test in `tests/` — the board is
rebuilt from events in any order, so every new event kind needs a test that proves order and duplicates
do not change the result.

## License

MIT
