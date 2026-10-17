# Journal format

The roadmap lives in `~/.claude/roadmap/` (override with the `CLAUDE_ROADMAP_DIR` environment variable).
Any tool may read it, and append to it under the same rules, so other agents and scripts can take part.

## Rules

- **Append only.** One event is one new file in `events/`, named `<epoch-ms>-<worker>-<random>.json`.
  Never edit or delete an event file. Nobody rewrites a shared "current state" file, so parallel
  sessions cannot lose each other's updates.
- The board (tracks, steps, sessions, agents) is computed from all events sorted by `at`. The order in
  which files arrive does not matter, and a duplicate changes nothing.
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

- `status`: `todo | running | done | failed | blocked | skipped`. `awaiting` is computed, never written.
  `skipped` needs a `reason`: the step will not be done. It leaves progress and stops blocking its
  dependents. A worker's `skipped` is a proposal that awaits the person; the person's is final.
- Plan steps may carry `why`, `scope` and `doneWhen` (the step's brief); a plan whose `blockedBy`
  closes a loop must not be written.
- **Review policy.** A plan may carry `review` for the whole track, a step its own:
  `{ "required": true, "independence": "any" | "other-session" | "cross-model", "mode": "standard" | "adversarial" }`.
  `cross-model` means the reviewer is a different model family (the `actor` up to its first `-`) from the
  implementer — the actor of the last worker `running`/`done` on the step. Steps new to a track must have a
  policy (their own or the track's); `{ "required": false }` opts out on purpose.
- A worker's `done` on a step whose policy requires a review stays `awaiting` until a `review` recorded
  since the step last went `running` meets the policy with `pass` or `findings`; a qualifying `fail` keeps
  it out. The person's own `done` is final. A review is written by the reviewer itself, under its own
  `session` and `actor`.
- `archived` (track-level `triage`, the person's only) hides a track; a later `archived: false` brings it back.
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
