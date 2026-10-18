## Shared roadmap

A roadmap shared with every Claude Code session on this machine lives in `~/.claude/roadmap`. Read and
update it with the `roadmap` CLI; never edit its files by hand.

```
R="node ~/.claude/mods/roadmap/cli/roadmap.mjs"
```

- **At the start of a task**, run `$R status` to see this project's tracks (the repository you run it in),
  the open steps in priority order (P0 first), what is blocked, what is in the backlog, and which chats are
  working on what. `$R status --all` shows every project.
- **Before working on a step**, read its brief: `$R step <track>/<id>` (why, scope, done when, what it
  waits on and unblocks). If it says another chat holds the step, ask the person before taking it.
- **When you start**, mark it: `$R mark <track>/<id> running`.
- **When you finish**, close it with a report:
  `$R done <track>/<id> --shipped "what was delivered" --evidence "tests, commit, PR" --follow-up "title:P2"`.
  Follow-ups go to the backlog; the person decides when they are worked on.
- **For analysis and architecture**: `$R json` gives the whole board; `$R md [track]` gives Markdown;
  `$R mermaid [track] [--out file.md]` gives what waits on what as a Mermaid diagram for a doc or a PR.
  To lay out or re-lay a track, write the plan as JSON and run `$R plan <track> plan.json` — give each
  step `why`, `scope` and `done_when`, mark sign-offs as `checkpoint`, dependencies as `blocked_by`.
  Re-laying keeps statuses and the person's own items; a plan with a dependency loop is refused.
- **Reviewing**: when asked to review a step (often another model's work), check it against the step's
  brief, then record the verdict yourself: `$R review <track>/<id> --verdict pass|findings|fail --evidence "what you checked"`.
  **Never `mark … running` to review**: running means you work on the implementation — it would reopen
  the work and drop the report you came to review (the CLI refuses it without `--reopen`). To show you
  are on it, `$R review <track>/<id> --start` (writes nothing). Record **every round**, a `fail` included,
  not only the last one: after a fail the implementer fixes and reports done again, you review again, and
  the person sees each round in the pane. Findings that need work later go with the review as
  `--follow-up "title[:P1]"` (repeatable): each becomes a follow-up step in the backlog — also after the
  person has accepted the review (record one more round with the same verdict and the follow-ups).
  A step with a cross-model policy needs a review by a different model family for the work last reported
  done (a new done needs a new review); its pass then waits for the person to confirm. The CLI records you as
  `codex` from inside Codex whatever `--actor` says; a bare `--actor` never counts as cross-model.
- **Laying out new steps**: every new step needs a review policy (on the step or as the track's default),
  e.g. `"review": { "required": true, "independence": "cross-model", "mode": "adversarial" }`.
- **Moving a step's obligation**: when its work now belongs to another step, `$R mark <track>/<id> moved --to <track>/<id> --reason "why"`
  proposes handing it over (not done, not skipped: the work is still owed, there). The person confirms;
  then the other step answers for it, its dependents included, under the stricter review policy of the two.
- **Not doing a step**: `$R mark <track>/<id> skipped --reason "why"` proposes leaving it out (not
  blocked, not failed — it will not be done); the person confirms the skip.
- **Priorities and backlog**: `$R mark <track>/<id> --priority P1` or `--backlog true`
  (`<track>/*` for a whole track). These are proposals: the person's own choice always stands.

Rules: you report, the person closes. A checkpoint you mark done waits for the person's confirmation in
the Roadmap pane. Never work on a backlog step or track unless asked.
