# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Carry over a Codex review that could not write.** `roadmap review <step> --from-codex <result.json |
  session id>` records a review Codex made in a read-only sandbox (claudex-loop reviews that way): the
  verdict comes from Codex's own session log, dated when Codex finished, recorded once as Codex
  (`via: "codex-session"`, with the session id to audit). `--follow-ups` files a passed review's findings.
- **A fail is recorded at any time.** A review of work not (yet) reported done used to be refused; a `fail`
  of it is now kept as a round of the step's history (claudex-loop's REVISE rounds come before any done),
  changing nothing. A `pass` or `findings` still counts only for work reported done before it and is
  refused otherwise, with what to do instead.
- **A diagnostics log per chat** (`<journal>/diag/<session>.log`, the last 300 lines): module loads,
  render failures and timeouts, slow renders, and renders per minute. The engine reports a failed pane
  only to its debug log, which the desktop app keeps off; this makes a blank pane traceable. Logs of
  chats gone for a week are dropped.
- **Review rounds.** A step keeps every review it had: the pane says which round a verdict is
  (`⚖ findings by codex · round 2, before: fail`) and the brief lists each round, marking those of earlier
  work. Only a review after the latest done still counts. Reviewers are told to record every round, a
  fail included, not only the last one.
- **Search above the tracks.** Type to narrow the Tracks view as you go: every word of the query, in any
  order, ignoring case and accents, over track titles, step titles and refs (`api/2.4`). A track whose title
  matches shows whole; otherwise only its matching steps, opened. A search looks through the backlog and
  the archive too. `✕ Clear` brings every track back.
- **A reviewer files its findings as follow-ups.** `roadmap review … --follow-up "title[:P1]"` (and
  `follow_ups` on the review tool) adds each finding as a follow-up step, set aside in the backlog, as a
  worker's `done` does — also after the person has accepted the review.

### Changed
- **Done, Backlog and Abandoned are three things.** A track whose every step is done, skipped or moved
  says **✓ Done** (done is done, whatever was decided on the way) and offers **Close**. Backlog is what will
  be done later. **Abandon** (it was "Archive") drops an unfinished track, which then says where it stopped
  (`closed at 40%`). A new **Done** tab lists closed tracks, and abandoned ones below them; **↺ Reopen** or
  **↺ Resume** brings one back; the agents' summary tells them apart too. Old archived tracks fall into
  Done or Abandoned by their steps: nothing to migrate.
- **Close a track as done yourself.** **⋯ → Done ✓** closes a track as done even with steps left open
  (a triage `done: true`, the person's word only), when the decision was made elsewhere.
- **Tracks keep one order, grouped by project.** They used to sort by priority, then by the latest
  change, so the list reshuffled whenever an agent worked. Now they stay as created until you move one
  (**↑ Up · ↓ Down · ⤒ Top** under ⋯, a person-only triage `rank`), the same in every chat, under a heading
  per project. This chat's track is no longer pulled to the top: the This chat line shows it.
- **Priority shows when it matters.** A track shows its priority only once set, in its colour; the `P·`
  placeholder is gone and the priority is set under ⋯. The ⌂ button names where it moves the track.
- **The header's Copy copies what the tab shows.** `⧉ Copy tracks`, `⧉ Copy backlog`, `⧉ Copy done`
  (done and abandoned apart) or `⧉ Copy days`, as Markdown; it used to copy every track whatever the tab.
  Chains keeps its own Copy as Mermaid.
- **A track's actions moved under ⋯.** Copy, Backlog, ⌂ project and Abandon no longer crowd the title on
  hover: one **⋯** opens them in a row under it, and each action closes the row.
- **Needs you leads with the step.** Each line starts with `track/id`, then the step's title; the track's
  long title no longer pushes the step out of sight.

## [0.5.2] — 2026-10-17

### Fixed
- **A pane could stay blank after `/reload-plugins`.** A (re)loaded module now asks its open panes to
  draw again (a pane left from the module before kept buttons that no longer answered), and a pane whose
  data does not come within three seconds draws the reason instead of the host's placeholder.
- **A reviewer could reopen the work it came to review.** Marking a step `running` once its work is
  reported done reopened it: the report stopped counting and the reviewer became its implementer. Now
  that is refused unless asked on purpose (`reopen` / `--reopen`); `roadmap review <ref> --start` shows a
  review in progress without touching the step, and the step's brief tells a reviewer up front.

## [0.5.1] — 2026-10-17

### Added
- **Chains: ⤢ Wide, Show done, hover titles, where you are.** ⤢ Wide opens the diagram alone in a pane
  of its own (Escape closes it). Show done draws the finished steps the tab folds away. Hovering a box
  shows its whole title. This chat's step is ringed and named above the diagram with its level in the
  chain.
- **docs/architecture.md** — how the modules fit together and where each rule lives.

### Changed
- **A clearer pane.** What is shown (the track, the project) stands out; its actions are dimmed.
- **The text tree indents only at a fork**, so a long chain reads down the page.
- **Needs you names whose review is owed.** "Confirm without Codex's review" (or Claude's, or another
  chat's) instead of a bare "Confirm without review" — your confirmation always comes last; and
  "Confirm despite the failed review" after a failed one.

### Fixed
- A chain through two other tracks no longer breaks in two; this chat's finished step is never folded
  away; a track with nothing open says so instead of claiming every step is done; a chain too large
  for the drawing element reads as text.

## [0.5.0] — 2026-10-17

### Added
- **Projects.** Tracks belong to the repository they were laid out from; every worktree of one
  repository is one project. The pane opens on this chat's project (plus tracks in no project), with a
  row to switch to another or **All**; hover a track's header for **⌂** to move it to another project.
  Chats and agents of other projects stay out too. The band, the agents' summary, `roadmap status` and
  Copy as Markdown stay on the chat's project and name the others in one line (`all` shows every one). A
  dependency on another project's step says which project it is in. Tracks laid out before projects take
  the project their chats worked in; those nobody can place show everywhere until you place them.
- **What to pick up next.** A track card shows **▸ next** — the step that waits on nothing and that
  nobody is on, most urgent first, then the one that unblocks most — and its longest open chain, in steps
  (never days). Each open step shows **⇢N**: how many open steps wait on it, down the chain, across
  tracks and through moves. Agents read the same in their summary and in a step's brief.
- **Chains tab.** One track at a time — this chat's by default — as boxes and arrows read top to bottom:
  the road ahead (finished steps that lead to nothing open fold away), each dependency drawn once, steps
  of other tracks it touches dashed, the next step outlined, the longest open chain in bold; a text tree
  in the terminal. **⧉ Copy as Mermaid** and `roadmap mermaid [track] [--out file.md]` give the diagram
  as a Mermaid block that GitHub, GitLab and Gitea render, for a PR, an issue or a doc; the same board
  always gives the same text.
- **A chat says when its plugin is outdated.** A chat keeps the code it started with; when the plugin's
  files on disk change, the pane says "↻ Roadmap updated — run /reload-plugins", with **Copy command**.
- **A move going nowhere comes to you.** Two moves confirmed at the same moment can close a loop; Needs
  you shows it with **Undo move**.

### Changed
- **A tidier top of the pane.** A short ⧉ Copy, so the tabs are never cut; "This chat" on one line.

### Fixed
- **A chat started before an update could show a blank pane.** The pane and the band now draw in a chat
  older than some of their state keys, and a pane that cannot draw says why instead of staying blank.
- CLI yes/no flags read `--all false` and `--failed false` as no.

## [0.4.0] — 2026-10-17

### Added
- **Review policy, enforced.** A step, or a whole track as a default, says how its work must be
  reviewed: `{ required, independence: any | other-session | cross-model, mode: standard | adversarial }`.
  Cross-model means a different model family from the implementer: Claude implements, Codex reviews, or
  the other way round. The reviewer records its verdict itself with the new `roadmap review` tool (CLI:
  `review`). A worker's done waits until a qualifying review passes; a failed review keeps it out, and
  each new done needs a new review. New steps must declare a policy; existing ones may go without.
  - **A cross-model pass is confirmed by you.** No process on one machine can prove which model wrote a
    review, so a cross-model pass leaves the step in **Needs you** with the reviewer, verdict and evidence
    beside **Confirm ✓**. `any` and `other-session` policies close on a pass by themselves.
  - **A plan can raise a policy, never lower it.** A step keeps the strictest policy it was ever under —
    its own or its track's — through re-laid plans, a step dropped and added back, and each part of the
    policy separately. A half-written policy is read as the strict one.
  - When Codex is installed beside Claude, a step's brief says how to have it review.
- **Moved: hand a step's obligation to another step.** For work that now belongs to another step — not
  done, not skipped: `mark <ref> moved --to <ref> --reason`. An agent proposes it; you confirm it with
  **Confirm move**. The moved step leaves progress; its dependents wait on the step the obligation went to
  (moves chain), and that step "also answers for" it — review policy included, so a move is no way around
  a review. A move that no longer stands (its target gone, or a loop) shows why and cannot be confirmed.
- **Archive a track.** A finished track offers **Archive** (any track does on hover). It leaves the list,
  the band, the status line and the agents' summary; its history stays in Days, and the Backlog tab's
  **Archived** section brings it back. Archiving is yours only: an agent's word on it is ignored.
- **Abandoned work is flagged.** A step marked running that nobody has touched or held for two hours
  shows as **◌ stale** in Needs you, with **Back to todo** and **Done ✓**; agents see it marked stale, so a
  new session can take it over.

### Changed
- **Events of the same millisecond fold one way** for every reader (by kind, then by the order work goes,
  then by content), so a board never depends on the order files were read in.
- The summary says what a step waits for — its review, your confirmation, a proposed skip or move.

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

[0.5.2]: https://github.com/D4rxio/agent-roadmap/releases/tag/v0.5.2
[0.5.1]: https://github.com/D4rxio/agent-roadmap/releases/tag/v0.5.1
[0.5.0]: https://github.com/D4rxio/agent-roadmap/releases/tag/v0.5.0
[0.4.0]: https://github.com/D4rxio/agent-roadmap/releases/tag/v0.4.0
[0.3.0]: https://github.com/D4rxio/agent-roadmap/releases/tag/v0.3.0
[0.2.0]: https://github.com/D4rxio/agent-roadmap/releases/tag/v0.2.0
[0.1.0]: https://github.com/D4rxio/agent-roadmap/releases/tag/v0.1.0
