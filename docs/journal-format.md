# Journal format

The roadmap lives in `~/.claude/roadmap/` (override with the `CLAUDE_ROADMAP_DIR` environment variable).
Any tool may read it, and append to it under the same rules, so other agents and scripts can take part.

## Rules

- **Append only.** One event is one new file in `events/`, named `<epoch-ms>-<worker>-<random>.json`.
  Never edit or delete an event file. Nobody rewrites a shared "current state" file, so parallel
  sessions cannot lose each other's updates.
- The board (tracks, steps, sessions, agents) is computed from all events sorted by `at`. The order in
  which files arrive does not matter, and a duplicate changes nothing. Events of the same millisecond are
  ordered by kind (`session`, `plan`, `add`, `edit`, `agent`, `agent-end`, `step`, `triage`, `review`),
  step reports in the order work goes (`todo`, `running`, `blocked`, `failed`, `skipped`, `moved`, `done`), then
  by their JSON text — every reader folds them the same way.
- **A worker reports, the person closes.** A worker's `done` on a `checkpoint` step, or on a step that last
  `failed`, becomes `awaiting` until an event with `"origin": "person"` confirms it.
- `live/<session>.json` is a worker's heartbeat, rewritten by that worker only. A file older than 20 s
  belongs to a worker that stopped. Its optional `focus` (`<track>/<id>`) is the step that worker holds.

## Events

`at` is epoch milliseconds; `session` is the writer's session id.

```json
{"kind":"plan","at":0,"session":"s","track":"api","title":"API v2","actor":"claude",
 "phases":[{"name":"Verify","steps":[{"id":"2.1","title":"Load test","checkpoint":true,"blockedBy":["1.3"]}]}]}
{"kind":"step","at":0,"session":"s","track":"api","id":"2.1","status":"done",
 "evidence":"tests passed","note":"PR 12","origin":"agent","actor":"codex"}
{"kind":"session","at":0,"session":"s","title":"first line of the prompt","actor":"claude"}
{"kind":"agent","at":0,"session":"s","agentId":"a1","description":"#api/2.1 …","type":"Explore","track":"api","step":"2.1"}
{"kind":"agent-end","at":0,"session":"s","agentId":"a1","status":"done"}
{"kind":"add","at":0,"session":"s","track":"api","id":"u1","title":"Test on Safari","origin":"person"}
{"kind":"edit","at":0,"session":"s","track":"api","id":"u1","title":"Test on Safari and Firefox","origin":"person"}
{"kind":"edit","at":0,"session":"s","track":"api","id":"u1","removed":true,"origin":"person"}
{"kind":"triage","at":0,"session":"s","track":"api","id":"2.1","priority":"P1","origin":"person"}
{"kind":"triage","at":0,"session":"s","track":"docs","backlog":true,"origin":"person"}
{"kind":"triage","at":0,"session":"s","track":"docs","archived":true,"origin":"person"}
{"kind":"review","at":0,"session":"codex-1","track":"api","id":"2.1","actor":"codex","verdict":"pass","evidence":"no findings"}
```

- `status`: `todo | running | done | failed | blocked | skipped | moved`. `awaiting` is computed, never written.
  `skipped` needs a `reason`: the step will not be done. It leaves progress and stops blocking its
  dependents. A worker's `skipped` is a proposal that awaits the person; the person's is final.
- `moved` needs `movedTo` (`<track>/<id>`) and a `reason`: the step's obligation is not dropped but handed
  to another step, where it still has to be done. A worker's `moved` is a proposal that awaits the person;
  the person's is final. A moved step leaves progress; its dependents wait on where the obligation ends up
  (moves chain: `a → b → c` ends at `c`) and are free once that step is done or skipped. A chain that loops
  or ends at a step that no longer exists ends nowhere, so its dependents stay blocked. The end of a chain
  answers for every step moved along it, review policy included: it is held to the strictest policy among
  them — a source that has since left the plan included — so moving work is no way around its review.
  A confirmed move stands until the person's own word changes it: a worker's later report on the moved
  step (a `done`, an agent's end) is ignored. A `moved` without `movedTo` is ignored. Writers check a move
  when it is proposed and again when the person confirms it (the target must still exist and must not lead
  back through confirmed moves); a proposal that no longer stands is shown with why, and cannot be confirmed.
  The journal takes no locks, so two confirmations written at once can still close a loop; such a move
  ends nowhere (its dependents stay blocked) and readers show it to the person, who undoes one.
- Plan steps may carry `why`, `scope` and `doneWhen` (the step's brief); a plan whose `blockedBy`
  closes a loop must not be written.
- **Review policy.** A plan may carry `review` for the whole track, a step its own:
  `{ "required": true, "independence": "any" | "other-session" | "cross-model", "mode": "standard" | "adversarial" }`.
  `required` must be stated (`true` or `false`); `{}` is not a policy. `cross-model` means the reviewer is a
  different model family (the leading letters of `actor`, lower-cased: `claude-opus`, `claude_code` and
  `Claude` are all `claude`) from the implementer — the actor of the last worker `running`/`done` on the
  step. Steps new to a track must have a policy (their own or the track's); `{ "required": false }` opts
  out on purpose. A plan never lowers the policy a step has been under — its own or its track's, even
  after the step left a plan and came back: each part (required, independence, mode) is held at the
  strictest it ever was, however the step comes back (a plan, an `add`, an edit). A plan can raise it. A
  re-laid plan that omits `review` keeps what is in force.
- A policy is read failing closed: an object that does not say `"required": false` requires a review, a
  missing or unknown `independence` is `cross-model`, a missing or unknown `mode` is `standard`. Writers
  store that normal form (`{ "required": true, "independence": …, "mode": … }` or `{ "required": false }`).
- A worker's `done` on a step whose policy requires a review stays `awaiting` until a `review` meets the
  policy with `pass` or `findings`. A review reviews the work last reported done: it counts only if written
  strictly after the worker's latest `done`, while no `running` has reopened the work (a `running` in the
  same millisecond as the `done` counts as reopening it). Each new `done` is new work and needs a new
  review. A qualifying `fail` keeps it out; of qualifying reviews in the same millisecond a `fail` wins.
  The person's own `done` is final.
- **A cross-model pass never closes a step by itself.** It leaves the step `awaiting` the person, with
  the review shown (who, verdict, `via`, evidence); the person's confirm closes it. On one machine and
  account no agent can prove which model wrote a review — `codex sandbox` runs any command exactly as a
  Codex session would, and the implementer's own reports are no better attested — so the person is the
  one who vouches. `any` and `other-session` policies close on a qualifying pass as before.
- A worker's `running` on a step whose work is reported done and waiting reopens that work (the report
  stops counting; the writer becomes its implementer). Writers refuse it unless asked to reopen on
  purpose; a reviewer records a `review` instead, and "I am reviewing" is a chat's activity (its live
  file), never an event.
- A review is written by the reviewer itself, under its own `session` and `actor`, with `via` saying how
  the actor was established: `claude-code` (the mod's own tool, run by the host), `process` (the CLI found
  the nearest Codex or Claude process above it), `codex-sandbox` (inside Codex's sandbox, where the process
  tree cannot be read, `$CODEX_SANDBOX`) or `declared` (`--actor`, nothing behind it). A `declared` review
  never satisfies `cross-model`; reviews written before `via` existed still count. The CLI never records a
  review as Claude — Claude reviews through its own tool. This keeps identities from being mixed up by
  accident; it does not prove them, which is why a cross-model pass waits for the person.
- `archived` (track-level `triage`, the person's only) puts a track away; a later `archived: false` brings it back.
  Put away with every step done, skipped or moved, it is done; otherwise abandoned.
- `done` (track-level `triage`, the person's only, sent with `archived: true`) closes a track as done whatever
  its steps say; `done: false` takes that back (sent when the person abandons or reopens a track).
- **Projects.** `session`, `plan` and live files may carry `project`: the folder of the main repository the
  writer works in (found through git's common dir, so every worktree of one repository is one project;
  outside git, the working folder). A track's project is, in order: the person's track-level `triage` with
  `project` (a key, or `null` for none — the person's word only); else the project of the `plan` that
  created the track (a later plan never sets it);
  else the project most of the track's `plan`/`step`/`add`/`review` events came from (by their session's
  project); else none. A track in no project shows in every project. Readers show a chat its own project
  by default — its tracks, and the sessions and agents working in it (a session that never said where it
  works shows everywhere, like an unplaced track); `blocked_by` across projects is allowed and is shown
  as such (in every view, and in Markdown). A session's project is a timeline of what it said and when (its `session`
  events and live files): it works now where it said last, by time; an event, or an agent, belongs to the
  project its session was in at that moment, so a session that moves to another repository leaves its
  past where it happened. A project key is never empty: `/` stays `/`.
- Ids added at run time (the person's items, follow-ups) take a prefix and a short random part
  (`u7k2qx`, `fvyhmi`), so two writers never pick the same one.
- A `plan` re-laid for a track replaces that track's layout; steps with the same id keep their status.
- `add` and `edit` are laid over every plan: a step the person added survives a re-laid track (back into
  "Your items" if the plan leaves it out) and keeps its "added by you" mark. The latest word on a title
  wins, a plan's included; a removal holds until a later plan lays the step out again.
- `triage` is planning, not execution: `priority` is `P0` (most urgent) … `P3`, `null` clears it;
  `backlog: true` sets a step aside (or, with no `id`, a whole track): it keeps its status but leaves
  progress and the next-work list. Per field the person's latest word wins; an agent's applies only
  where the person has said nothing.

## Archive

Loose event files older than a day, once there are more than 200, are moved by a session into one
bundle `archive/<first-at>-<session>-<random>.jsonl`: a header line `{"bundle": 1, "count": N}`, then one
line per event `{"n": "<original file name>", "e": <event>}`. A bundle is written once and never
changed; the loose files are deleted only after the bundle has been read back and counted. Readers count
an event once by its name, and read a bundle again while it has fewer rows than its header says (it is
still being written).
