# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-10-16

### Added
- **Done ✓ on hover**: one press marks a step completed (the person's word, so it also closes a
  checkpoint or a step awaiting confirmation). Before, it took two clicks on the step's icon.
- **Collapsible phases**: a phase with work left (or holding this chat's step) starts open, a finished
  one (everything done or skipped) starts closed; click a phase's header to open or close it, and this
  chat remembers the choice.
- **Copy on hover**: a track header's **Copy** copies its title without folding it; a step's **Copy**
  copies `#<track>/<id> <title>`, ready to paste into a prompt or a subagent's description.

### Fixed
- **Long rows wrapped and scrolling cut off half the pane.** A row whose title carried styled parts
  (an icon, a strikethrough, “✎ you”, “● this chat”) wrapped onto several lines on the desktop surface
  despite truncation, while the pane counts one line per row, so scrolling a long list left half the
  view blank. Every row is now one line: styled parts sit side by side and only the title is cut with
  “…”. A test guards it.
- **The pane failed to draw on Claude Code before 2.1.295.** Those engines accept only a plain string
  inside a Button; ours carried styled text, so the pane was refused (found by Codex running the tests
  with an older `claude`). Buttons now carry a label and draw styled content only where the engine
  supports it (version checked at session start); the suite passes on 2.1.287 and 2.1.295.

### Changed
- **One action core.** Laying out a plan, marking, finishing, reading a step and the status now live in
  `hooks/actions.ts`, run by both the Claude Code tools and the CLI; the two are thin I/O layers. A rule
  change is one edit and one test, and Claude and other agents behave the same by construction.

## [0.2.0] — 2026-10-15

### Added
- **Step brief.** Steps can carry `why`, `scope` (what not to touch) and `done_when` (done criteria).
  The new `roadmap step <track>/<id>` tool gives an agent the full brief before it starts: why, scope,
  done criteria, what the step waits on and what it unblocks, its priority and backlog state.
- **Structured hand-off.** The new `roadmap done` tool closes a step with what shipped, the evidence and
  follow-ups. Follow-ups become new steps in a "Follow-ups" phase, set aside in the backlog, so nothing
  found during the work is lost and the person decides when it is picked up.
- **Each chat holds its item.** A chat takes hold of the step it starts, finishes or delegates to a
  tagged subagent, or that the person pins. Its pane leads with "This chat", opens that track first,
  and every pane marks which chat holds which step. A brief warns when another live chat already holds
  the step.
- **Skipped steps.** A step can be marked `skipped` with a short reason: it will not be done — not
  blocked, not failed. It leaves the track's progress and no longer holds its dependents back. An agent
  can only propose a skip; the person confirms it ("Confirm skip") or sends the step back to work.
  In the pane: hover a step → **Skip** → type the reason.
- **CLI for other agents and scripts** (`cli/roadmap.mjs`, Node ≥ 23.6, no dependencies): `status`,
  `step`, `json`, `md`, `plan`, `mark`, `done` on the same journal with the same rules, so Codex or
  any other tool that can run a command takes part. A ready-to-paste instruction block for an
  agent's `AGENTS.md` is in `cli/AGENTS-snippet.md`.

### Changed
- **Dependency loops are refused.** A plan whose `blocked_by` closes a loop, across tracks too, is
  rejected with the loop spelled out; references to steps that do not exist yet are warned about.
- **Faster with a long history.** Loose events older than a day, once there are more than 200, are
  packed into one immutable archive bundle and removed; heartbeats of sessions gone for a week are
  pruned. The board is recomputed only when something changed (and every 30 s for relative times),
  not every 3 s in every open chat.
- **Ids that cannot collide.** Items added by the person and follow-ups get a short random id
  (`u7k2qx`, `fvyhmi`) instead of a counter, so two chats adding at the same moment never pick the
  same one.

### Fixed
- A chat that read an archive bundle while another chat was still writing it could miss events until
  restarted. Bundles now carry a header with their event count, and a partial read is read again.
- Reading a dependency's brief no longer moves a chat off the step it holds.

## [0.1.0] — 2026-10-15

First public release: a roadmap pane shared by every Claude Code session — tracks, phases and steps,
a daily timeline, priorities and a backlog for steps and whole tracks, the person's own items,
person-confirmed checkpoints, subagents ticking off their steps, Copy as Markdown, and an append-only
event journal so parallel sessions never lose each other's updates.

[0.3.0]: https://github.com/D4rxio/agent-roadmap/releases/tag/v0.3.0
[0.2.0]: https://github.com/D4rxio/agent-roadmap/releases/tag/v0.2.0
[0.1.0]: https://github.com/D4rxio/agent-roadmap/releases/tag/v0.1.0
