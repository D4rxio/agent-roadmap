# Roadmap — shared planning state for coding agents

[![release](https://img.shields.io/github/v/release/D4rxio/agent-roadmap?label=release)](https://github.com/D4rxio/agent-roadmap/releases)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A lightweight, file-based roadmap that lets multiple agents share the same execution plan, backlog,
priorities, dependencies and progress. Built for parallel Claude Code workflows, but the journal format
is tool-agnostic: any agent or script that can write a JSON file can take part.

Every Claude Code session reads the same state when it starts and writes back what it did; subagents
tick off their own steps; you see the whole picture in a side pane. You no longer have to piece together
what happened across five chats, and a fresh session knows where things stand.

<p align="center"><img src="docs/pane.svg" width="720" alt="The Roadmap pane: tracks with progress bars and priorities, a checkpoint awaiting confirmation, steps with their state, and the sessions and subagents working now"></p>
<p align="center"><sub>Illustration with sample data.</sub></p>

## What's new in 0.3.0

- **Done ✓ and Copy on hover** — finish a step in one press; copy a track title or `#track/id title`.
- **Collapsible phases** — phases with work left start open, finished ones start closed.
- **Long lists scroll cleanly** — every row is one line, cut with "…" instead of wrapping.
- **Works on older Claude Code** — the pane draws on engines before 2.1.295 too.
- **One action core** — the Claude tools and the CLI run the same code, so they behave the same.

Full history: [CHANGELOG.md](CHANGELOG.md).

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
  what is blocked, what is set aside in the backlog, and which chat holds which step.
- **Works beyond Claude Code.** A small CLI gives Codex or any script the same roadmap from a terminal.

## Install

In a Claude Code terminal session:

```
/plugin install roadmap --marketplace D4rxio/agent-roadmap
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
  - Hover a step for **Done ✓** to finish it in one press (your word, so it also closes a checkpoint),
    or click its icon to move it ○ → ◐ → ✓.
  - Click a phase's header to open or close it; phases with work left start open, finished ones closed.
  - Click the `P·` chip to raise its priority: P3 → P2 → P1 → P0.
  - Hover a step for **Copy** (`#track/id title`, ready for a prompt), **Pin** (this chat holds it), **Skip** (with a reason: it will not be done) and
    **Backlog** (set it aside), and on your own items **✎** (rename) and **✕** (remove).
  - Hover a track header for **Copy** (its title) or **Backlog** (set the whole track aside).
  - **+ Add an item** at the bottom of a track adds your own step, marked **✎ you**. Agents may refine
    it, but they never lose it.
  - **⧉ Copy as Markdown** copies one track.
- **Days.** Steps done per day over the last two weeks, and what happened each day: done, started,
  sessions, agents.
- **Backlog.** Everything set aside, tracks and steps, with **↺ Restore**.
- **This chat.** The step this chat holds, first thing in its pane; every pane marks which chat holds which step.
- **Needs you.** Checkpoints and proposed skips waiting for **Confirm / Reject**, and failed steps.
- **Working now.** Live sessions and subagents and what each one is doing this moment.

### Tools the model gets

| Tool | Purpose |
|---|---|
| `roadmap plan` | lay out or re-lay one track: phases, steps with `why` / `scope` / `done_when`, checkpoints, `blocked_by` (loops are refused) |
| `roadmap step` | read one step's brief before working on it |
| `roadmap mark` | report a status with evidence (`skipped` needs a reason); propose a priority or backlog (`<track>/*` for a whole track) |
| `roadmap done` | close a step: what shipped, evidence, follow-ups (filed in the backlog) |
| `roadmap status` | read every track's open steps and who is working on what |

## Other agents: the CLI

Codex, scripts or any agent that can run a command use the same roadmap through `cli/roadmap.mjs`
(Node ≥ 23.6, no dependencies; it runs the plugin's own model, so the rules are the same):

```
node cli/roadmap.mjs status                 # open steps by priority, who is working on what
node cli/roadmap.mjs step api/2.1           # a step's brief
node cli/roadmap.mjs json                   # the whole board, for analysis
node cli/roadmap.mjs plan api plan.json     # lay out a track from JSON
node cli/roadmap.mjs mark api/2.1 running
node cli/roadmap.mjs done api/2.1 --shipped "…" --evidence "…" --follow-up "title:P2"
```

[`cli/AGENTS-snippet.md`](cli/AGENTS-snippet.md) is a ready-to-paste block for an agent's `AGENTS.md`.
An agent running in a sandbox needs write access to the journal folder only (for Codex:
`[sandbox_workspace_write] writable_roots = ["<home>/.claude/roadmap"]`).

## Where the data lives

Everything stays on your machine, in `~/.claude/roadmap/`: one small JSON file per event, plus a
heartbeat file per live session. Nothing is sent anywhere. Other tools can take part by following
[the journal format](docs/journal-format.md).

To keep a roadmap with a project instead, set `CLAUDE_ROADMAP_DIR` to a folder inside the repository
(for example `.roadmap/`) and commit its `events/` folder: every event is its own file, so merging two
branches' roadmaps is merging two sets of files, with no conflicts. Keep `live/` out of git; it only says
which sessions are working right now.

## Why an event journal instead of one `roadmap.json`?

The obvious design is one file holding the current roadmap that every agent reads, edits and writes back.
With several sessions working at once, that loses work: two agents read version 12, both write their own
version 13, and the second write silently erases the first. Locks would fix it, but a crashed session
leaves its lock behind.

So nothing here is ever rewritten. Every change — a plan, a status, an added item, a priority — is a new
small file in `events/`, and the roadmap you see is computed from all of them:

- **No lost updates.** Two sessions writing at the same moment write two different files.
- **Order does not matter.** Events are applied by their timestamp, so files that arrive late, out of
  order or twice give the same roadmap. That is what lets a session that was offline for an hour, or a
  second machine syncing the folder, join without conflicts.
- **Rules live in the fold, not in the writers.** "A worker's `done` on a checkpoint waits for the
  person", "the person's priority beats an agent's", "your items survive a re-laid plan" are decided
  when the events are read. An agent cannot get around them by writing a different state.
- **History for free.** Every event says who did what and when, which is what the Days view shows.
- **Easy to version.** Point it at a folder in a repository and merging two branches is merging two
  sets of files.

## Develop

```
claude plugin validate .
claude plugin test .
```

To run your working copy instead of the installed one, add its folder to `CLAUDE_CODE_PLUGIN_DIRS`.

## Suggestions welcome

This started as a tool for one person juggling many parallel Claude sessions, and it is shaped by real
use. Ideas, rough edges and "it would be great if…" are all welcome: open an
[issue](https://github.com/D4rxio/agent-roadmap/issues) or a pull request. If you change the journal
format, update [docs/journal-format.md](docs/journal-format.md) and add a test in `tests/` — the board is
rebuilt from events in any order, so every new event kind needs a test that proves order and duplicates
do not change the result.

## License

MIT
