## Shared roadmap

A roadmap shared with every Claude Code session on this machine lives in `~/.claude/roadmap`. Read and
update it with the `roadmap` CLI; never edit its files by hand.

```
R="node ~/.claude/mods/roadmap/cli/roadmap.mjs"
```

- **At the start of a task**, run `$R status` to see the tracks, the open steps in priority order (P0
  first), what is blocked, what is in the backlog, and which chats are working on what.
- **Before working on a step**, read its brief: `$R step <track>/<id>` (why, scope, done when, what it
  waits on and unblocks). If it says another chat holds the step, ask the person before taking it.
- **When you start**, mark it: `$R mark <track>/<id> running`.
- **When you finish**, close it with a report:
  `$R done <track>/<id> --shipped "what was delivered" --evidence "tests, commit, PR" --follow-up "title:P2"`.
  Follow-ups go to the backlog; the person decides when they are worked on.
- **For analysis and architecture**: `$R json` gives the whole board; `$R md [track]` gives Markdown.
  To lay out or re-lay a track, write the plan as JSON and run `$R plan <track> plan.json` — give each
  step `why`, `scope` and `done_when`, mark sign-offs as `checkpoint`, dependencies as `blocked_by`.
  Re-laying keeps statuses and the person's own items; a plan with a dependency loop is refused.
- **Not doing a step**: `$R mark <track>/<id> skipped --reason "why"` proposes leaving it out (not
  blocked, not failed — it will not be done); the person confirms the skip.
- **Priorities and backlog**: `$R mark <track>/<id> --priority P1` or `--backlog true`
  (`<track>/*` for a whole track). These are proposals: the person's own choice always stands.

Rules: you report, the person closes. A checkpoint you mark done waits for the person's confirmation in
the Roadmap pane. Never work on a backlog step or track unless asked.
