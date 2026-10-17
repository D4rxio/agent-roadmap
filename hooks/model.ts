import type {
  RoadmapReview,
  RoadmapReviewPolicy,
  RoadmapPriority,
  RoadmapAgent,
  RoadmapOrigin,
  RoadmapProject,
  RoadmapBoard,
  RoadmapEvent,
  RoadmapLive,
  RoadmapSession,
  RoadmapStatus,
  RoadmapStep,
  RoadmapTrack,
  RoadmapWindow,
} from '../types'

export const STATUSES: RoadmapStatus[] = ['todo', 'running', 'done', 'failed', 'blocked', 'awaiting', 'skipped', 'moved']
/** A live file older than this is a session that stopped working. */
export const LIVE_MS = 20_000
/** A running step nobody has touched or held for this long is flagged as probably abandoned. */
export const STALE_MS = 2 * 3_600_000

export function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/**
 * A step reference: `api/2.1`, `#api/2.1`, or `2.1` inside `fallbackTrack`
 * (else the one track holding that id).
 */
export function parseRef(
  ref: string,
  tracks: RoadmapTrack[],
  fallbackTrack?: string,
): { track: string; id: string } | undefined {
  const clean = ref.trim().replace(/^#/, '')
  const slash = clean.indexOf('/')
  if (slash > 0) {
    const track = slug(clean.slice(0, slash))
    const id = clean.slice(slash + 1)
    return track && id ? { track, id } : undefined
  }
  if (!clean) return undefined
  if (fallbackTrack) {
    const own = tracks.find(t => t.name === fallbackTrack)
    if (!own || own.steps.some(s => s.id === clean)) return { track: fallbackTrack, id: clean }
  }
  const holders = tracks.filter(t => t.steps.some(s => s.id === clean))
  return holders.length === 1 && holders[0] ? { track: holders[0].name, id: clean } : undefined
}

/** The first `#track/id` or `#id` in an agent's description that names a known step. */
export function refInText(
  text: string,
  tracks: RoadmapTrack[],
  fallbackTrack?: string,
): { track: string; id: string } | undefined {
  for (const m of text.matchAll(/#([\w.-]+(?:\/[\w.-]+)?)/g)) {
    const ref = parseRef(m[1] ?? '', tracks, fallbackTrack)
    const track = ref && tracks.find(t => t.name === ref.track)
    if (ref && track?.steps.some(s => s.id === ref.id)) return ref
  }
  return undefined
}

/**
 * Folds the journal into the board. Order-agnostic: events are sorted by time,
 * the latest plan of a track lays it out, the latest word on a step wins
 * (an explicit mark or an agent's start/end), duplicates change nothing.
 */
const KIND_ORDER: string[] = ['session', 'plan', 'add', 'edit', 'agent', 'agent-end', 'step', 'triage', 'review']
const STATUS_ORDER: string[] = ['todo', 'running', 'blocked', 'failed', 'skipped', 'moved', 'done']

export function fold(events: RoadmapEvent[], lives: RoadmapLive[], now: number): RoadmapBoard {
  // Time first; events of the same millisecond in a fixed order — by kind (a plan before the work on
  // it, an agent's start before its end), step reports in the order work goes (running before done),
  // then by content — so the board never depends on the order files happened to be read in.
  const sorted = [...events]
    .map(e => ({ e, r: KIND_ORDER.indexOf(e.kind) * 10 + (e.kind === 'step' ? STATUS_ORDER.indexOf(e.status) : 0), k: JSON.stringify(e) }))
    .sort((a, b) => a.e.at - b.e.at || a.r - b.r || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .map(x => x.e)
  const tracks = new Map<string, RoadmapTrack>()
  const sessions = new Map<string, RoadmapSession>()
  const agents = new Map<string, RoadmapAgent>()
  type Word = {
    at: number
    status: RoadmapStatus
    note?: string
    evidence?: string
    reason?: string
    movedTo?: string
    startedAt?: number
    origin: RoadmapOrigin
    by?: string
    actor?: string
    session?: string
  }
  const reviews = new Map<string, RoadmapReview[]>()
  // The strictest review policy each step has ever been under (its own or its track's), by
  // track/id: it outlives the step leaving a plan, so dropping and re-adding an id cannot shed it.
  const floors = new Map<string, RoadmapReviewPolicy>()
  const words = new Map<string, Word[]>()
  const key = (track: string, id: string) => `${track}/${id}`

  const touch = (session: string, at: number) => {
    const s = sessions.get(session)
    if (s) s.lastAt = Math.max(s.lastAt, at)
    else
      sessions.set(session, {
        id: session,
        title: session.slice(0, 8),
        actor: 'claude',
        startedAt: at,
        lastAt: at,
        isLive: false,
      })
  }
  const say = (track: string, id: string, word: Word) => {
    const k = key(track, id)
    words.set(k, [...(words.get(k) ?? []), word])
  }

  for (const e of sorted) {
    touch(e.session, e.at)
    if (e.kind === 'plan') {
      const old = tracks.get(e.track)
      const phases = e.phases.map(p => ({ name: p.name, stepIds: p.steps.map(s => s.id) }))
      const laid = new Map(e.phases.flatMap(p => p.steps.map(s => [s.id, { ...s, phase: p.name }] as const)))
      const trackReview = stricter(policyOf(e.review), old?.review)
      // A plan (an agent's) can raise a step's review policy, never lower it: what this plan puts in
      // force (the step's own, else the track's) is held to the strictest the step was ever under.
      const reviewOf = (id: string, own: RoadmapReviewPolicy | undefined) => {
        const k = key(e.track, id)
        const floor = floors.get(k)
        const effective = stricter(own ?? trackReview, floor)
        if (effective) floors.set(k, effective)
        return same(effective, own ?? trackReview) ? own : effective
      }
      const steps: RoadmapStep[] = [...laid].map(([id, t]) => ({
        track: e.track,
        id,
        title: t.title,
        phase: t.phase,
        status: 'todo',
        checkpoint: t.checkpoint === true,
        blockedBy: (t.blockedBy ?? []).map(r => (r.includes('/') ? r.replace(/^#/, '') : `${e.track}/${r}`)),
        why: t.why,
        scope: t.scope,
        doneWhen: t.doneWhen,
        // A re-laid step that omits `review` keeps its own; the floor above keeps the rest.
        review: reviewOf(id, policyOf(t.review) ?? old?.steps.find(x => x.id === id)?.review),
        reviews: [],
        agents: [],
        backlog: false,
      }))
      tracks.set(e.track, {
        name: e.track,
        title: e.title ?? old?.title ?? e.track,
        phases,
        steps,
        createdAt: old?.createdAt ?? e.at,
        updatedAt: e.at,
        backlog: false,
        archived: false,
        review: trackReview,
        // The first plan that says where it was laid out sets the track's project; later plans, from
        // wherever, do not move it.
        project: old?.project ?? e.project,
        projectBy: old?.project ? old.projectBy : e.project ? 'plan' : undefined,
      })
      const s = sessions.get(e.session)
      if (s) s.track = e.track
    } else if (e.kind === 'step') {
      const s = sessions.get(e.session)
      const origin = e.origin ?? 'agent'
      say(e.track, e.id, {
        at: e.at,
        status: e.status,
        note: e.note,
        evidence: e.evidence,
        reason: e.reason,
        movedTo: e.movedTo ? (e.movedTo.includes('/') ? e.movedTo.replace(/^#/, '') : `${e.track}/${e.movedTo}`) : undefined,
        origin,
        by: origin === 'person' ? 'you' : (s?.title ?? e.actor),
        actor: e.actor ?? s?.actor,
        session: e.session,
      })
      if (s && origin !== 'person') s.track = e.track
    } else if (e.kind === 'session') {
      const s = sessions.get(e.session)
      if (s) {
        s.title = e.title
        s.actor = e.actor ?? s.actor
        s.track = e.track ?? s.track
        s.project = e.project ?? s.project
        s.startedAt = Math.min(s.startedAt, e.at)
      }
    } else if (e.kind === 'agent') {
      if (!agents.has(e.agentId)) {
        agents.set(e.agentId, {
          id: e.agentId,
          session: e.session,
          description: e.description,
          type: e.type,
          track: e.track,
          step: e.step,
          status: 'running',
          startedAt: e.at,
          tools: 0,
        })
        if (e.track && e.step) {
          say(e.track, e.step, { at: e.at, status: 'running', startedAt: e.at, origin: 'agent', by: e.description, actor: 'claude', session: e.session })
        }
      }
    } else if (e.kind === 'review') {
      const k = key(e.track, e.id)
      reviews.set(k, [...(reviews.get(k) ?? []), { actor: e.actor, session: e.session, verdict: e.verdict, at: e.at, evidence: e.evidence, note: e.note, via: e.via }])
    } else if (e.kind === 'agent-end') {
      const a = agents.get(e.agentId)
      if (a && a.status === 'running') {
        a.status = e.status
        a.endedAt = e.at
      }
    }
  }

  // An agent's end speaks for its step once every agent on that step has ended.
  for (const a of agents.values()) {
    if (!a.track || !a.step || a.status === 'running') continue
    const peers = [...agents.values()].filter(p => p.track === a.track && p.step === a.step)
    if (peers.some(p => p.status === 'running')) continue
    const last = Math.max(...peers.map(p => p.endedAt ?? 0))
    if (a.endedAt !== last) continue
    const failed = peers.some(p => p.status === 'failed')
    say(a.track, a.step, { at: last, status: failed ? 'failed' : 'done', origin: 'agent', by: a.description, actor: 'claude', session: a.session })
  }

  layOverPersonEdits(tracks, sorted)
  applyTriage(tracks, sorted, sessions)
  inferProjects(tracks, sorted, sessions, lives)

  // Moves the person confirmed (a step's last word is the person's `moved`), each followed to where the
  // obligation ends up. A broken or looping chain ends nowhere: nothing it was meant to satisfy is.
  const exists = new Set([...tracks.values()].flatMap(t => t.steps.map(s => key(t.name, s.id))))
  // A confirmed move stands until the person's own word changes it: a worker's later report (a done, an
  // agent's end) cannot undo it — the work is owed elsewhere now.
  const moves = new Map<string, string>()
  for (const [k, list] of words) {
    let to: string | undefined
    for (const w of [...list].sort((a, b) => a.at - b.at)) {
      if (w.origin !== 'person' || (w.status === 'moved' && !w.movedTo)) continue
      to = w.status === 'moved' ? w.movedTo : undefined
    }
    if (to) moves.set(k, to)
  }
  const finalOf = (k: string): string | undefined => {
    const seen = new Set([k])
    let at = moves.get(k)
    while (at !== undefined) {
      if (seen.has(at) || !exists.has(at)) return undefined
      seen.add(at)
      const next = moves.get(at)
      if (next === undefined) return at
      at = next
    }
    return undefined
  }
  // The obligation travels with its review policy: a target answers for the strictest policy of every
  // step moved onto it, so moving work is no way around its review.
  const policyIn = new Map<string, RoadmapReviewPolicy | undefined>()
  for (const t of tracks.values()) {
    for (const s of t.steps) policyIn.set(key(t.name, s.id), stricter(s.review ?? t.review, floors.get(key(t.name, s.id))))
  }
  const carried = new Map<string, { from: string[]; policy?: RoadmapReviewPolicy }>()
  for (const k of moves.keys()) {
    const end = finalOf(k)
    if (!end) continue
    const c = carried.get(end) ?? { from: [] }
    c.from.push(k)
    // A source that has since left the plan still hands on the strictest policy it was ever under.
    c.policy = stricter(stricter(policyIn.get(k), floors.get(k)), c.policy)
    carried.set(end, c)
  }

  for (const t of tracks.values()) {
    for (const step of t.steps) {
      const said = (words.get(key(t.name, step.id)) ?? []).sort((a, b) => a.at - b.at)
      step.agents = [...agents.values()].filter(a => a.track === t.name && a.step === step.id).map(a => a.id)
      // Plan vs execution: a worker reports, the person closes. A worker's `done` on a
      // checkpoint, or out of `failed`, waits for the person instead; so does any skip a worker
      // proposes, since leaving work out is a decision about scope.
      let status: RoadmapStatus = 'todo'
      let proposed: 'done' | 'skipped' | 'moved' | undefined
      let skipReason: string | undefined
      let move: { to: string; reason?: string } | undefined
      for (const w of said) {
        const worker = w.origin !== 'person'
        if (worker && status === 'moved') continue
        // Leaving work out, or handing it to another step, is a decision about scope: a worker proposes it.
        if (worker && (w.status === 'skipped' || (w.status === 'moved' && w.movedTo))) {
          status = 'awaiting'
          proposed = w.status
          skipReason = w.status === 'skipped' ? (w.reason ?? w.note) : undefined
          move = w.status === 'moved' ? { to: w.movedTo!, reason: w.reason ?? w.note } : undefined
          continue
        }
        if (w.status === 'moved' && !w.movedTo) continue
        const gated: boolean = worker && w.status === 'done' && (step.checkpoint || status === 'failed')
        status = gated ? 'awaiting' : w.status
        proposed = gated ? 'done' : undefined
        skipReason = w.status === 'skipped' ? (w.reason ?? w.note) : undefined
        move = w.status === 'moved' ? { to: w.movedTo!, reason: w.reason ?? w.note } : undefined
      }
      step.proposed = status === 'awaiting' ? proposed : undefined
      step.skipReason = skipReason
      step.movedTo = move?.to
      step.moveReason = move?.reason
      const k0 = key(t.name, step.id)
      step.movedFinal = status === 'moved' ? finalOf(k0) : undefined
      // A proposed move the person could not confirm as it stands: its target is gone, or following the
      // moves already confirmed from there leads back here.
      step.moveProblem = undefined
      if (status === 'awaiting' && proposed === 'moved' && move) {
        let at: string | undefined = move.to
        const seen = new Set<string>()
        while (at !== undefined && !step.moveProblem) {
          if (at === k0) step.moveProblem = `it would loop back here through ${move.to}`
          else if (!exists.has(at)) step.moveProblem = at === move.to ? `${move.to} no longer exists` : `the moves from ${move.to} end at ${at}, which no longer exists`
          else if (seen.has(at)) step.moveProblem = `the moves from ${move.to} go round in a loop`
          seen.add(at)
          at = moves.get(at)
        }
      }
      step.carries = carried.get(k0)?.from
      // Review: the policy in force, who implemented, which reviews count, and whether done may stand.
      // The floor applies however the step came to be — laid by a plan, brought back by an `add` or an
      // edit — so no route around a plan sheds the policy a step was under.
      step.review = stricter(stricter(step.review ?? t.review, floors.get(k0)), carried.get(k0)?.policy)
      const work = said.filter(w => w.origin !== 'person' && (w.status === 'running' || w.status === 'done'))
      const last = work[work.length - 1]
      step.implementer = last?.actor || last?.session ? { actor: last.actor ?? 'unknown', session: last.session ?? '' } : undefined
      // A review reviews the work last reported done: it counts only if written strictly after the
      // worker's latest done, and only while no running has reopened the work since. A new done (new
      // work) needs a new review; a review written before the work, or in the same millisecond, never counts.
      const lastRun = [...said].reverse().find(w => w.status === 'running')
      const lastDone = [...work].reverse().find(w => w.status === 'done')
      // A running in the same millisecond as the done may have reopened it: unsure, so no review counts.
      step.reportedAt = lastDone && lastDone.at > (lastRun?.at ?? Number.NEGATIVE_INFINITY) ? lastDone.at : undefined
      const since = step.reportedAt ?? Number.POSITIVE_INFINITY
      step.reviews = (reviews.get(key(t.name, step.id)) ?? []).filter(r => r.at > since).sort((a, b) => a.at - b.at)
      if (step.review?.required) {
        const counted = step.reviews.filter(r => qualifies(step.review!, step.implementer, r))
        const latestAt = counted.length ? counted[counted.length - 1]!.at : undefined
        const latest = counted.filter(r => r.at === latestAt)
        // A cross-model pass is a report to the person, never a close: any process here can claim to
        // be another model (`codex sandbox` runs anything as Codex), so only the person's confirm closes it.
        step.reviewState = !latest.length
          ? 'missing'
          : latest.some(r => r.verdict === 'fail')
            ? 'failed'
            : step.review.independence === 'cross-model'
              ? 'reviewed'
              : 'satisfied'
        step.passedReview = step.reviewState === 'reviewed' || step.reviewState === 'satisfied' ? latest[latest.length - 1] : undefined
        // A worker's done waits for a qualifying review; the person's own done is final (an override).
        const doneWord = [...said].reverse().find(w => w.status === 'done')
        if (status === 'done' && doneWord && doneWord.origin !== 'person' && step.reviewState !== 'satisfied') {
          status = 'awaiting'
          step.proposed = 'done'
        }
        step.reviewPending = status === 'awaiting' && (step.reviewState === 'missing' || step.reviewState === 'failed') && step.proposed === 'done'
      }
      const latest = said[said.length - 1]
      if (!latest) continue
      step.status = status
      step.note = [...said].reverse().find(w => w.note !== undefined)?.note
      step.evidence = [...said].reverse().find(w => w.evidence !== undefined)?.evidence
      step.lastBy = latest.by
      step.lastAt = latest.at
      const firstActive = said.find(w => w.status !== 'todo' && w.status !== 'blocked')
      step.startedAt = status === 'todo' ? undefined : (firstActive?.startedAt ?? firstActive?.at)
      step.endedAt = status === 'done' || status === 'failed' || status === 'skipped' || status === 'moved' ? latest.at : undefined
    }
  }

  // A step waiting on unfinished steps is blocked until they are done — or skipped: a step that
  // will not be done must not hold its dependents back for ever. A moved step is finished when the
  // step its obligation went to is: its dependents now wait on that one.
  const closed = new Set(
    [...tracks.values()].flatMap(t =>
      t.steps.filter(s => s.status === 'done' || s.status === 'skipped').map(s => key(t.name, s.id)),
    ),
  )
  const doneRefs = new Set([
    ...closed,
    ...[...tracks.values()].flatMap(t =>
      t.steps.filter(s => s.status === 'moved' && s.movedFinal && closed.has(s.movedFinal)).map(s => key(t.name, s.id)),
    ),
  ])
  for (const t of tracks.values()) {
    for (const step of t.steps) {
      if (step.status === 'todo' && step.blockedBy.some(r => !doneRefs.has(r))) step.status = 'blocked'
    }
  }

  for (const live of lives) {
    const isLive = now - live.at < LIVE_MS
    const s = sessions.get(live.session)
    if (s) {
      s.lastAt = Math.max(s.lastAt, live.at)
      s.isLive = isLive
      s.activity = isLive ? live.activity : undefined
      s.focus = isLive ? live.focus : undefined
      if (live.title) s.title = live.title
      s.track = s.track ?? live.track
      // Where it works now: a session can move between repositories (a CLI session id reused elsewhere).
      s.project = live.project ?? s.project
    } else {
      sessions.set(live.session, {
        id: live.session,
        title: live.title || live.session.slice(0, 8),
        actor: 'claude',
        track: live.track,
        project: live.project,
        startedAt: live.at,
        lastAt: live.at,
        isLive,
        activity: isLive ? live.activity : undefined,
        focus: isLive ? live.focus : undefined,
      })
    }
    for (const seen of live.agents) {
      const a = agents.get(seen.agentId)
      if (a) {
        a.activity = seen.activity
        a.tools = Math.max(a.tools, seen.tools)
      }
    }
  }

  // Abandoned work: running, last moved a while ago, and nobody on it — no chat holding it recently
  // (a heartbeat naming it within the window, live or not) and no running agent tagged with it.
  for (const t of tracks.values()) {
    for (const step of t.steps) {
      if (step.status !== 'running' || now - (step.lastAt ?? now) < STALE_MS) continue
      const ref = `${t.name}/${step.id}`
      const held = lives.some(l => l.focus === ref && now - l.at < STALE_MS)
      const worked = [...agents.values()].some(a => a.status === 'running' && a.track === t.name && a.step === step.id)
      step.stale = !held && !worked
    }
  }

  return {
    // Most important first (P0 … unprioritized), then the most recently moved.
    tracks: [...tracks.values()].sort((a, b) => trackRank(a) - trackRank(b) || b.updatedAt - a.updatedAt),
    sessions: [...sessions.values()].sort((a, b) => b.lastAt - a.lastAt),
    agents: [...agents.values()].sort((a, b) => b.startedAt - a.startedAt),
    projects: projectsOf([...tracks.values()], [...sessions.values()]),
    at: now,
  }
}

/**
 * A track nobody placed takes the project of the chats that worked on it: the one most of its events came
 * from. A track whose chats never said (events written before projects existed) stays unplaced.
 */
function inferProjects(tracks: Map<string, RoadmapTrack>, sorted: RoadmapEvent[], sessions: Map<string, RoadmapSession>, lives: RoadmapLive[]) {
  const of = (session: string) => sessions.get(session)?.project ?? lives.find(l => l.session === session)?.project
  const votes = new Map<string, Map<string, number>>()
  for (const e of sorted) {
    if (e.kind !== 'plan' && e.kind !== 'step' && e.kind !== 'add' && e.kind !== 'review') continue
    const p = of(e.session)
    if (!p) continue
    const v = votes.get(e.track) ?? new Map<string, number>()
    v.set(p, (v.get(p) ?? 0) + 1)
    votes.set(e.track, v)
  }
  for (const t of tracks.values()) {
    if (t.projectBy) continue
    const v = [...(votes.get(t.name) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    if (v[0]) {
      t.project = v[0][0]
      t.projectBy = 'inferred'
    }
  }
}

/** The last part of a project's key: `/x/repos/api` → `api`. */
export function projectLabel(key: string): string {
  return key.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || key
}

/** Every project named by a track or a session, each with a name unique among them. */
function projectsOf(tracks: RoadmapTrack[], sessions: RoadmapSession[]): RoadmapProject[] {
  const keys = [...new Set([...tracks.map(t => t.project), ...sessions.map(s => s.project)].filter((k): k is string => !!k))]
  const parts = new Map(keys.map(k => [k, k.split(/[\\/]/).filter(Boolean)]))
  // Its folder's name; where two share it, as many parent folders as it takes to tell them apart.
  const nameOf = (key: string) => {
    const own = parts.get(key) ?? []
    for (let n = 1; n <= own.length; n++) {
      const tail = own.slice(-n).join('/')
      if (!keys.some(o => o !== key && (parts.get(o) ?? []).slice(-n).join('/') === tail)) {
        return n === 1 ? projectLabel(key) : `${projectLabel(key)} (${own.slice(-n, -1).join('/')})`
      }
    }
    return key
  }
  // A folder can itself be called "a (x)", so a made-up name may still meet a real one: those fall back to
  // their full path, which no two projects share.
  const named = new Map(keys.map(k => [k, nameOf(k)]))
  const taken = (k: string) => keys.some(o => o !== k && named.get(o) === named.get(k))
  for (const k of keys.filter(taken)) named.set(k, k)
  return keys
    .map(key => ({
      key,
      name: named.get(key) ?? key,
      tracks: tracks.filter(t => t.project === key && !t.archived).length,
      archived: tracks.filter(t => t.project === key && t.archived).length,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * The board one project sees: its own tracks and those nobody placed, and the sessions (and their agents)
 * working in it or not saying where. `undefined` or `'*'` is every project. Tracks left out are named in `elsewhere`,
 * so a dependency on one can say it lives in another project.
 */
export function forProject(board: RoadmapBoard, project: string | undefined): RoadmapBoard {
  if (!project || project === '*') return board
  const name = (key: string) => board.projects.find(p => p.key === key)?.name ?? projectLabel(key)
  // Like tracks: a chat in another project stays out; one that never said where it works shows everywhere.
  const sessions = board.sessions.filter(s => !s.project || s.project === project)
  const ids = new Set(sessions.map(s => s.id))
  return {
    ...board,
    tracks: board.tracks.filter(t => !t.project || t.project === project),
    sessions,
    agents: board.agents.filter(a => ids.has(a.session)),
    elsewhere: Object.fromEntries(board.tracks.filter(t => t.project && t.project !== project).map(t => [t.name, name(t.project!)])),
  }
}

/**
 * " (in project api)" when `ref` points into a track of another project than `from`'s — whether this board
 * shows that track (All) or left it out (one project) — else "".
 */
export function externalNote(board: RoadmapBoard, ref: string, from?: string): string {
  const name = ref.split('/')[0] ?? ''
  const hidden = board.elsewhere?.[name]
  if (hidden) return ` (in project ${hidden})`
  const owner = board.tracks.find(t => t.name === name)?.project
  const here = from === undefined ? undefined : board.tracks.find(t => t.name === from)?.project
  if (!owner || owner === here) return ''
  return ` (in project ${board.projects.find(p => p.key === owner)?.name ?? projectLabel(owner)})`
}

export const ICONS: Record<RoadmapStatus, string> = {
  todo: '○',
  running: '◐',
  done: '✓',
  failed: '✗',
  blocked: '⊘',
  awaiting: '◆',
  skipped: '↷',
  moved: '↪',
}

/** What needs the person, across every track. */
export function attention(board: RoadmapBoard): {
  awaiting: RoadmapStep[]
  blocked: RoadmapStep[]
  failed: RoadmapStep[]
  stale: RoadmapStep[]
  brokenMoves: RoadmapStep[]
} {
  const all = board.tracks.filter(t => !t.backlog && !t.archived).flatMap(t => t.steps)
  return {
    // A move whose chain ends nowhere (two moves confirmed at once into a loop, or a target gone): its
    // dependents stay blocked until the person undoes one.
    brokenMoves: all.filter(s => s.status === 'moved' && !s.movedFinal),
    awaiting: all.filter(s => s.status === 'awaiting'),
    blocked: all.filter(s => s.status === 'blocked' && !s.backlog),
    failed: all.filter(s => s.status === 'failed' && !s.backlog),
    stale: all.filter(s => s.stale && !s.backlog),
  }
}

export const YOUR_PHASE = 'Your items'

/**
 * Applies the person's own adds and the edits of any step over the plans. A plan replaces a
 * track's layout, so an added step the latest plan left out is put back (into its phase, or
 * "Your items"); a title is the latest word on it, plan or edit; a removal holds until a later
 * plan lays the step out again.
 */
function layOverPersonEdits(tracks: Map<string, RoadmapTrack>, sorted: RoadmapEvent[]) {
  const titledAt = new Map<string, number>()
  for (const t of tracks.values()) for (const s of t.steps) titledAt.set(`${t.name}/${s.id}`, t.updatedAt)
  for (const e of sorted) {
    if (e.kind !== 'add' && e.kind !== 'edit') continue
    const t = tracks.get(e.track)
    if (!t) continue
    const k = `${t.name}/${e.id}`
    const step = t.steps.find(s => s.id === e.id)
    if (e.kind === 'add') {
      if (step) {
        if (e.origin === 'person') step.addedBy = 'you'
        if (e.at > (titledAt.get(k) ?? 0)) {
          step.title = e.title
          titledAt.set(k, e.at)
        }
        continue
      }
      const phaseName = e.phase || YOUR_PHASE
      let phase = t.phases.find(p => p.name === phaseName)
      if (!phase) {
        phase = { name: phaseName, stepIds: [] }
        t.phases.push(phase)
      }
      phase.stepIds.push(e.id)
      t.steps.push({
        track: t.name,
        id: e.id,
        title: e.title,
        phase: phaseName,
        status: 'todo',
        checkpoint: false,
        blockedBy: [],
        agents: [],
        backlog: false,
        reviews: [],
        addedBy: e.origin === 'person' ? 'you' : undefined,
      })
      titledAt.set(k, e.at)
      continue
    }
    if (!step || e.at <= (titledAt.get(k) ?? 0)) continue
    if (e.removed) {
      t.steps = t.steps.filter(s => s.id !== e.id)
      for (const p of t.phases) p.stepIds = p.stepIds.filter(id => id !== e.id)
      t.phases = t.phases.filter(p => p.stepIds.length > 0 || p.name !== YOUR_PHASE)
    } else if (e.title) {
      step.title = e.title
    }
    titledAt.set(k, e.at)
  }
}

/**
 * Priority and backlog, per field: the person's latest word wins; an agent's latest applies only
 * where the person has said nothing, so no agent reprioritizes what the person decided.
 */
function applyTriage(
  tracks: Map<string, RoadmapTrack>,
  sorted: RoadmapEvent[],
  sessions: Map<string, RoadmapSession>,
) {
  type Said = { at: number; person: boolean; by: string }
  const prio = new Map<string, Said & { value: RoadmapPriority | null }>()
  const back = new Map<string, Said & { value: boolean }>()
  const archived = new Map<string, boolean>()
  const placed = new Map<string, string | null>()
  const wins = (old: Said | undefined, next: Said) => !old || (next.person ? true : !old.person)
  for (const e of sorted) {
    if (e.kind !== 'triage') continue
    const k = e.id === undefined ? e.track : `${e.track}/${e.id}`
    const person = e.origin === 'person'
    const by = person ? 'you' : (sessions.get(e.session)?.title ?? 'an agent')
    if (e.priority !== undefined && wins(prio.get(k), { at: e.at, person, by })) {
      prio.set(k, { at: e.at, person, by, value: e.priority })
    }
    if (e.backlog !== undefined && wins(back.get(k), { at: e.at, person, by })) {
      back.set(k, { at: e.at, person, by, value: e.backlog })
    }
    // Archiving is the person's decision alone: a worker's word on it is ignored.
    if (e.archived !== undefined && person && e.id === undefined) archived.set(e.track, e.archived)
    // So is placing a track in a project.
    if (e.project !== undefined && person && e.id === undefined) placed.set(e.track, e.project)
  }
  for (const t of tracks.values()) {
    const tp = prio.get(t.name)
    const tb = back.get(t.name)
    t.priority = tp?.value ?? undefined
    t.backlog = tb?.value === true
    t.archived = archived.get(t.name) === true
    if (placed.has(t.name)) {
      t.project = placed.get(t.name) ?? undefined
      t.projectBy = 'you'
    }
    t.triagedBy = [tp, tb].filter((x): x is NonNullable<typeof x> => !!x).sort((x, y) => y.at - x.at)[0]?.by
    for (const s of t.steps) {
      const k = `${t.name}/${s.id}`
      const p = prio.get(k)
      const b = back.get(k)
      s.priority = p?.value ?? undefined
      s.backlog = b?.value === true
      const last = [p, b].filter((x): x is NonNullable<typeof x> => !!x).sort((x, y) => y.at - x.at)[0]
      s.triagedBy = last?.by
    }
  }
}

/** The model family an actor belongs to: `claude`, `codex`, … (`claude-opus` and `claude` are one). */
export function family(actor: string | undefined): string {
  // The leading letters only: claude, Claude, claude-opus, claude_code, claude.opus are all "claude".
  return (actor ?? '').toLowerCase().match(/^[a-z]+/)?.[0] ?? 'unknown'
}

const INDEPENDENCE = ['any', 'other-session', 'cross-model'] as const

/**
 * A review policy as written in the journal, read one way everywhere and failing closed: a policy that
 * does not say `required: false` requires a review; a missing or unknown independence is cross-model
 * (the strictest, as the plan tool's default); a missing or unknown mode is standard.
 */
export function policyOf(raw: unknown): RoadmapReviewPolicy | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as { required?: unknown; independence?: unknown; mode?: unknown }
  if (r.required === false || r.required === 'false') return { required: false }
  const independence = (INDEPENDENCE as readonly unknown[]).includes(r.independence)
    ? (r.independence as RoadmapReviewPolicy['independence'])
    : 'cross-model'
  return { required: true, independence, mode: r.mode === 'adversarial' ? 'adversarial' : 'standard' }
}

/**
 * The stricter of two policies, part by part: required if either requires, the stronger
 * independence and the stronger mode of the two. A later plan can raise a policy, never lower any part.
 */
export function stricter(next: RoadmapReviewPolicy | undefined, prev: RoadmapReviewPolicy | undefined): RoadmapReviewPolicy | undefined {
  if (!prev?.required) return next ?? prev
  if (!next?.required) return prev
  const rank = (p: RoadmapReviewPolicy) => INDEPENDENCE.indexOf(p.independence ?? 'cross-model')
  return {
    required: true,
    independence: INDEPENDENCE[Math.max(rank(next), rank(prev))],
    mode: next.mode === 'adversarial' || prev.mode === 'adversarial' ? 'adversarial' : 'standard',
  }
}

function same(a: RoadmapReviewPolicy | undefined, b: RoadmapReviewPolicy | undefined): boolean {
  if (!a?.required || !b?.required) return !a?.required && !b?.required
  return (a.independence ?? 'cross-model') === (b.independence ?? 'cross-model') && (a.mode ?? 'standard') === (b.mode ?? 'standard')
}

/** Whether a review counts under a policy, given who implemented the step. */
export function qualifies(
  policy: RoadmapReviewPolicy,
  implementer: { actor: string; session: string } | undefined,
  review: RoadmapReview,
): boolean {
  if (!implementer) return true
  // Cross-model needs a reviewer whose identity a host established: a bare --actor proves nothing.
  if (policy.independence === 'cross-model') return review.via !== 'declared' && family(review.actor) !== family(implementer.actor)
  if (policy.independence === 'other-session') return review.session !== implementer.session
  return true
}

/** One line naming a policy: "cross-model review (adversarial)". */
export function policyText(policy: RoadmapReviewPolicy | undefined): string {
  if (!policy?.required) return 'no review required'
  const who = policy.independence === 'cross-model' ? 'cross-model' : policy.independence === 'other-session' ? 'independent' : 'any'
  return `${who} review${policy.mode === 'adversarial' ? ' (adversarial)' : ''} required`
}

export const PRIORITIES: RoadmapPriority[] = ['P0', 'P1', 'P2', 'P3']

function trackRank(t: RoadmapTrack): number {
  return t.priority ? PRIORITIES.indexOf(t.priority) : PRIORITIES.length
}

/** P0 first, unprioritized last; ties keep the plan's order. */
export function byPriority(a: RoadmapStep, b: RoadmapStep): number {
  const rank = (s: RoadmapStep) => (s.priority ? PRIORITIES.indexOf(s.priority) : PRIORITIES.length)
  return rank(a) - rank(b)
}

/**
 * A fresh id with a prefix (u for the person's items, f for follow-ups) and a short random part:
 * two chats adding at the same moment never pick the same id, which a counter would.
 */
export function nextId(track: RoadmapTrack, events: RoadmapEvent[], prefix: string): string {
  const used = new Set([...track.steps.map(s => s.id), ...events.filter(e => e.kind === 'add' && e.track === track.name).map(e => (e as { id: string }).id)])
  for (;;) {
    const id = `${prefix}${Math.random().toString(36).slice(2, 7).padEnd(5, '0')}`
    if (!used.has(id)) return id
  }
}

export function nextPersonId(track: RoadmapTrack, events: RoadmapEvent[]): string {
  return nextId(track, events, 'u')
}

export const FOLLOW_UPS = 'Follow-ups'

/** A loop in the `blocked_by` graph across all tracks, as `a → b → … → a`, or undefined. */
export function findCycle(tracks: RoadmapTrack[]): string[] | undefined {
  const edges = new Map<string, string[]>()
  for (const t of tracks) for (const s of t.steps) edges.set(`${t.name}/${s.id}`, s.blockedBy)
  const state = new Map<string, 1 | 2>()
  const path: string[] = []
  const visit = (node: string): string[] | undefined => {
    if (state.get(node) === 2) return undefined
    if (state.get(node) === 1) return [...path.slice(path.indexOf(node)), node]
    state.set(node, 1)
    path.push(node)
    for (const next of edges.get(node) ?? []) {
      if (!edges.has(next)) continue
      const loop = visit(next)
      if (loop) return loop
    }
    path.pop()
    state.set(node, 2)
    return undefined
  }
  for (const node of edges.keys()) {
    const loop = visit(node)
    if (loop) return loop
  }
  return undefined
}

/** Everything an agent needs before working on one step: what, why, the boundaries, when it is done. */
export function brief(board: RoadmapBoard, track: string, id: string, me?: string): string | undefined {
  const t = board.tracks.find(x => x.name === track)
  const s = t?.steps.find(x => x.id === id)
  if (!t || !s) return undefined
  const ref = (r: string) => {
    const [tn, sid] = [r.slice(0, r.indexOf('/')), r.slice(r.indexOf('/') + 1)]
    const owner = board.tracks.find(x => x.name === tn)
    const dep = owner?.steps.find(x => x.id === sid)
    const other = owner?.project && owner.project !== t.project ? ` [in project ${board.projects.find(p => p.key === owner.project)?.name ?? projectLabel(owner.project)}]` : ''
    return dep
      ? `${ICONS[dep.status]} ${r}${other} ${dep.title} (${dep.status}${dep.status === 'skipped' ? `: ${dep.skipReason ?? 'no reason'}` : ''}${dep.status === 'moved' ? ` to ${dep.movedFinal ?? `${dep.movedTo ?? '?'}, chain broken`} — this waits on that step now` : ''})`
      : `? ${r} (unknown)`
  }
  const dependents = board.tracks.flatMap(x =>
    x.steps.filter(y => y.blockedBy.includes(`${track}/${id}`)).map(y => `${ICONS[y.status]} ${x.name}/${y.id} ${y.title}`),
  )
  const lines = [
    `${track}/${id} — ${s.title}`,
    `Track: ${t.title}${t.backlog ? ' (track in backlog)' : ''} · phase: ${s.phase}${t.project ? ` · project: ${board.projects.find(p => p.key === t.project)?.name ?? projectLabel(t.project)}` : ''}`,
    `Status: ${s.status}${s.status === 'skipped' ? ` (${s.skipReason ?? 'no reason'})` : ''}${s.status === 'awaiting' && s.proposed === 'skipped' ? ` (a skip is proposed: ${s.skipReason ?? 'no reason'})` : ''}${s.status === 'awaiting' && s.proposed === 'moved' ? ` (a move to ${s.movedTo ?? '?'} is proposed: ${s.moveReason ?? 'no reason'})` : ''}${s.priority ? ` · priority ${s.priority}` : ''}${s.backlog ? ' · IN BACKLOG — do not work on it unless asked' : ''}${s.checkpoint ? ' · checkpoint: the person closes it' : ''}${s.addedBy ? ' · added by the person' : ''}`,
    s.stale
      ? 'Stale: marked running, but no chat or agent has been on it for hours — probably abandoned. Take it over (mark it running) or ask the person.'
      : '',
    s.status === 'moved'
      ? s.movedFinal
        ? `Moved: its obligation now lives in ${s.movedFinal}${s.movedTo !== s.movedFinal ? ` (through ${s.movedTo})` : ''}${s.moveReason ? ` — ${s.moveReason}` : ''}. Do the work there, not here.`
        : `Moved to ${s.movedTo ?? '?'}, but that chain of moves is broken or loops: the obligation ends nowhere, so its dependents stay blocked. Ask the person.`
      : '',
    s.carries?.length ? `Also answers for: ${s.carries.join(', ')} (their obligations were moved here; done here counts for them).` : '',
    s.why ? `Why: ${s.why}` : 'Why: (not written — ask, or infer it from the track and say so)',
    s.scope ? `Scope: ${s.scope}` : '',
    s.doneWhen ? `Done when: ${s.doneWhen}` : 'Done when: (not written — agree it before you call it done)',
    s.review?.required
      ? `Review: ${policyText(s.review)}${s.implementer ? ` · implemented by ${family(s.implementer.actor)}` : ''}${
          s.review.independence === 'cross-model' && s.implementer ? ` → the reviewer must not be ${family(s.implementer.actor)}` : ''
        }. ${
          s.reviewState === 'satisfied'
            ? 'A qualifying review passed.'
            : s.reviewState === 'reviewed'
              ? `A cross-model review passed (${s.passedReview?.actor ?? 'another model'}${s.passedReview?.via ? `, via ${s.passedReview.via}` : ''}); the person confirms it in the Roadmap pane — no agent can prove which model wrote a review.`
              : s.reviewState === 'failed'
              ? 'The last qualifying review FAILED: fix the findings, then get it reviewed again.'
              : 'No qualifying review yet: a worker\'s done waits for one.'
        }`
      : s.review
        ? 'Review: not required for this step.'
        : '',
    ...s.reviews.map(r => `  review by ${r.actor}${r.via === 'declared' ? ' (declared, unverified)' : ''}: ${r.verdict}${r.evidence ? ` — ${r.evidence}` : ''}${r.note ? ` (${r.note})` : ''}`),
    s.blockedBy.length ? `Waits on:\n${s.blockedBy.map(r => `  ${ref(r)}`).join('\n')}` : '',
    dependents.length ? `Unblocks:\n${dependents.map(x => `  ${x}`).join('\n')}` : '',
    s.evidence ? `Last evidence: ${s.evidence}` : '',
    s.note ? `Last note: ${s.note}` : '',
    s.lastBy && s.lastAt ? `Last moved by: ${s.lastBy}` : '',
    ...board.sessions
      .filter(x => x.isLive && x.id !== me && x.focus === `${track}/${id}`)
      .map(x => `Another chat holds this step right now: "${x.title}" — coordinate with the person before working on it too.`),
    'When you finish: roadmap done with what shipped, the evidence, and any follow-ups.',
  ]
  return lines.filter(Boolean).join('\n')
}

/** The track's progress over the steps that count: backlog, skipped and moved steps are set aside. */
export function progress(track: RoadmapTrack): { done: number; total: number } {
  const active = track.steps.filter(s => !s.backlog && s.status !== 'skipped' && s.status !== 'moved')
  return { done: active.filter(s => s.status === 'done').length, total: active.length }
}

/** What the model reads at a session's start and from the status tool. */
export function summary(whole: RoadmapBoard, opts: { open?: number; project?: string } = {}): string {
  if (whole.tracks.length === 0) return 'The roadmap has no tracks yet.'
  // A chat sees its own project's tracks (and those nobody placed); the others get one line.
  const board = forProject(whole, opts.project)
  const lines: string[] = []
  const here = opts.project && opts.project !== '*' ? whole.projects.find(p => p.key === opts.project) : undefined
  if (here) lines.push(`Project: ${here.name}`)
  if (!board.tracks.some(x => !x.archived)) lines.push('- no tracks in this project yet')
  for (const t of board.tracks.filter(x => !x.backlog && !x.archived)) {
    const { done, total } = progress(t)
    lines.push(`- ${t.priority ? `${t.priority} ` : ''}${t.name} — ${t.title}: ${done}/${total} done`)
    // Open work, most important first: what a new session should pick up.
    const open = t.steps.filter(s => s.status !== 'done' && s.status !== 'skipped' && s.status !== 'moved' && !s.backlog).sort(byPriority)
    for (const s of open.slice(0, opts.open ?? 6)) {
      const why =
        s.status === 'blocked'
          ? ` (blocked by ${s.blockedBy.map(r => `${r}${externalNote(board, r, t.name)}`).join(', ')})`
          : s.status === 'awaiting'
            ? s.proposed === 'skipped'
              ? ` (a skip awaits the person: ${s.skipReason ?? 'no reason'})`
              : s.proposed === 'moved'
                ? ` (a move to ${s.movedTo ?? '?'} awaits the person: ${s.moveReason ?? 'no reason'})`
                : s.reviewPending
                ? s.reviewState === 'failed'
                  ? ' (review failed: fix the findings, then ask for a new review)'
                  : ' (waits for its review)'
                : s.reviewState === 'reviewed'
                  ? ` (reviewed by ${s.passedReview?.actor ?? 'another model'}: ${s.passedReview?.verdict ?? 'pass'} — the person confirms)`
                  : ' (awaiting the person)'
            : s.stale
              ? ' (stale: running, but nobody has been on it for hours — take it over or ask)'
              : ''
      const rv =
        s.review?.required && s.reviewState !== 'satisfied' && s.reviewState !== 'reviewed'
          ? ` [${policyText(s.review)}${s.review.independence === 'cross-model' && s.implementer ? `: reviewer ≠ ${family(s.implementer.actor)}` : ''}${s.reviewState === 'failed' ? '; last review failed' : ''}]`
          : ''
      const carries = s.carries?.length ? ` [also answers for ${s.carries.join(', ')}]` : ''
      lines.push(`    ${ICONS[s.status]} ${s.priority ? `${s.priority} ` : ''}${t.name}/${s.id} ${s.title}${s.checkpoint ? ' [checkpoint]' : ''}${s.addedBy ? ' [added by the person]' : ''}${rv}${carries}${why}`)
    }
    if (open.length > (opts.open ?? 6)) lines.push(`    … ${open.length - (opts.open ?? 6)} more open`)
    const skipped = t.steps.filter(s => s.status === 'skipped')
    if (skipped.length) {
      lines.push(`    skipped (decided not to do): ${skipped.map(s => `${t.name}/${s.id} — ${s.skipReason ?? 'no reason'}`).join('; ')}`)
    }
    const moved = t.steps.filter(s => s.status === 'moved')
    if (moved.length) {
      lines.push(
        `    moved (obligation handed to another step): ${moved.map(s => `${t.name}/${s.id} → ${s.movedFinal ?? `${s.movedTo ?? '?'} (chain broken)`}${s.moveReason ? ` — ${s.moveReason}` : ''}`).join('; ')}`,
      )
    }
    const shelved = t.steps.filter(s => s.backlog)
    if (shelved.length) {
      lines.push(`    backlog (set aside, not to work on unless asked): ${shelved.map(s => `${t.name}/${s.id}`).join(', ')}`)
    }
  }
  const elsewhere = opts.project && opts.project !== '*' ? whole.projects.filter(p => p.key !== opts.project && p.tracks > 0) : []
  if (elsewhere.length) {
    lines.push(
      `- other projects (not this chat's; roadmap status with all shows them): ${elsewhere.map(p => `${p.name} (${p.tracks} track${p.tracks === 1 ? '' : 's'})`).join(', ')}`,
    )
  }
  const archivedTracks = board.tracks.filter(x => x.archived)
  if (archivedTracks.length) {
    lines.push(`- archived tracks (closed by the person, not to work on): ${archivedTracks.map(x => x.name).join(', ')}`)
  }
  const shelvedTracks = board.tracks.filter(x => x.backlog && !x.archived)
  if (shelvedTracks.length) {
    lines.push(`- tracks in backlog (set aside whole, not to work on unless asked): ${shelvedTracks.map(x => x.name).join(', ')}`)
  }
  return lines.join('\n')
}

export const WINDOW_MS: Record<RoadmapWindow, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  all: Number.POSITIVE_INFINITY,
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** One row of the timeline: where in [t0, t1] the span sits, `width` cells wide. */
export function timelineBar(
  t0: number,
  t1: number,
  start: number | undefined,
  end: number | undefined,
  width: number,
): { before: string; bar: string; after: string } {
  const empty = { before: '·'.repeat(Math.max(0, width)), bar: '', after: '' }
  if (start === undefined || width < 4 || (end !== undefined && end < t0)) return empty
  const span = Math.max(1, t1 - t0)
  const from = Math.min(width - 1, Math.max(0, Math.floor(((start - t0) / span) * width)))
  const to = Math.min(width, Math.max(from + 1, Math.ceil((((end ?? t1) - t0) / span) * width)))
  return { before: '·'.repeat(from), bar: '━'.repeat(to - from), after: '·'.repeat(width - to) }
}

export function progressBar(done: number, total: number, width: number): string {
  if (total === 0 || width <= 0) return '░'.repeat(Math.max(0, width))
  const full = Math.round((done / total) * width)
  return '█'.repeat(full) + '░'.repeat(width - full)
}

/** `Bash: npm test`, `Read: register.tsx`: one short line for a tool call. */
export function describeCall(e: Record<string, unknown>): string {
  const tool = String(e.tool ?? '').replace(/^mcp__([^_]+)__/, '$1 ')
  const pick = ['description', 'command', 'file_path', 'pattern', 'query', 'url', 'path', 'prompt']
    .map(k => e[k])
    .find(v => typeof v === 'string' && v.trim()) as string | undefined
  if (!pick) return tool
  const arg = /[\\/]/.test(pick) && !pick.includes(' ') ? (pick.split(/[\\/]/).pop() ?? pick) : pick
  const one = arg.replace(/\s+/g, ' ').trim()
  return `${tool}: ${one.length > 40 ? one.slice(0, 39) + '…' : one}`
}

// ── Days: what happened when ─────────────────────────────────────────────

const DAY_MS = 86_400_000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The local day number of `at`, `offsetMin` the host's UTC offset in minutes. */
export function dayOf(at: number, offsetMin: number): number {
  return Math.floor((at + offsetMin * 60_000) / DAY_MS)
}

export function dayLabel(day: number, today: number): string {
  if (day === today) return 'Today'
  if (day === today - 1) return 'Yesterday'
  const d = new Date(day * DAY_MS)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

export function clock(at: number, offsetMin: number): string {
  const d = new Date(at + offsetMin * 60_000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/** `14:02` today, `yesterday`, `3d ago`, `13 Oct` further back. */
export function when(at: number, now: number, offsetMin: number): string {
  const today = dayOf(now, offsetMin)
  const day = dayOf(at, offsetMin)
  if (day === today) return clock(at, offsetMin)
  if (day === today - 1) return 'yesterday'
  if (today - day < 7) return `${today - day}d ago`
  const d = new Date(day * DAY_MS)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

export type DayEntry = {
  at: number
  kind: 'done' | 'started' | 'failed' | 'awaiting' | 'skipped' | 'moved' | 'session' | 'agent'
  text: string
  track?: string
}

export type Day = { day: number; label: string; done: number; entries: DayEntry[] }

/** Every day with activity, newest first: steps finished or started, sessions and agents. */
export function days(board: RoadmapBoard, now: number, offsetMin: number, limit = 14): Day[] {
  const today = dayOf(now, offsetMin)
  const byDay = new Map<number, DayEntry[]>()
  const add = (at: number | undefined, entry: Omit<DayEntry, 'at'>) => {
    if (at === undefined) return
    const day = dayOf(at, offsetMin)
    if (today - day >= limit) return
    byDay.set(day, [...(byDay.get(day) ?? []), { ...entry, at }])
  }
  for (const t of board.tracks) {
    for (const s of t.steps) {
      const label = `${t.name}/${s.id} ${s.title}`
      if (s.status === 'done') add(s.endedAt, { kind: 'done', text: label, track: t.name })
      if (s.status === 'failed') add(s.endedAt, { kind: 'failed', text: label, track: t.name })
      if (s.status === 'skipped') add(s.endedAt, { kind: 'skipped', text: `${label} — ${s.skipReason ?? ''}`, track: t.name })
      if (s.status === 'moved') add(s.endedAt, { kind: 'moved', text: `${label} → ${s.movedFinal ?? s.movedTo ?? '?'}`, track: t.name })
      if (s.status === 'awaiting') add(s.lastAt, { kind: 'awaiting', text: label, track: t.name })
      if (s.startedAt !== undefined && dayOf(s.startedAt, offsetMin) !== dayOf(s.endedAt ?? -1, offsetMin)) {
        add(s.startedAt, { kind: 'started', text: label, track: t.name })
      }
    }
  }
  for (const s of board.sessions) add(s.startedAt, { kind: 'session', text: s.title, track: s.track })
  for (const a of board.agents) add(a.startedAt, { kind: 'agent', text: a.description, track: a.track })
  return [...byDay]
    .sort((a, b) => b[0] - a[0])
    .map(([day, entries]) => ({
      day,
      label: dayLabel(day, today),
      done: entries.filter(x => x.kind === 'done').length,
      entries: entries.sort((a, b) => b.at - a.at),
    }))
}

/** Steps a track finished on each of the last `count` days, oldest first. */
export function doneSeries(board: RoadmapBoard, now: number, offsetMin: number, count = 14, track?: string): number[] {
  const today = dayOf(now, offsetMin)
  const out = new Array<number>(count).fill(0)
  for (const t of board.tracks) {
    if (track && t.name !== track) continue
    for (const s of t.steps) {
      if (s.status !== 'done' || s.endedAt === undefined) continue
      const back = today - dayOf(s.endedAt, offsetMin)
      if (back >= 0 && back < count) out[count - 1 - back] = (out[count - 1 - back] ?? 0) + 1
    }
  }
  return out
}

// ── Copy: a track as Markdown ────────────────────────────────────────────

export function trackMarkdown(track: RoadmapTrack, now: number, offsetMin: number, board?: RoadmapBoard): string {
  const { done, total } = progress(track)
  const lines = [`## ${track.title} — ${total ? Math.round((done / total) * 100) : 0}% (${done}/${total})`, '']
  for (const p of track.phases) {
    const own = track.steps.filter(s => p.stepIds.includes(s.id))
    const own2 = own.filter(s => !s.backlog)
    if (own2.length === 0) continue
    lines.push(`### ${p.name} (${own2.filter(s => s.status === 'done').length}/${own2.length})`)
    for (const s of own2) {
      const box = s.status === 'done' ? '[x]' : s.status === 'skipped' ? '[-]' : s.status === 'moved' ? '[>]' : '[ ]'
      const tags = [
        s.status === 'skipped'
          ? `skipped: ${s.skipReason ?? 'no reason'}`
          : s.status === 'moved'
            ? `moved to ${s.movedFinal ?? `${s.movedTo ?? '?'} (chain broken)`}${s.moveReason ? `: ${s.moveReason}` : ''}`
            : s.status !== 'done' && s.status !== 'todo'
              ? s.status
              : '',
        s.carries?.length ? `also answers for ${s.carries.join(', ')}` : '',
        s.checkpoint ? 'checkpoint' : '',
        s.addedBy ? 'added by you' : '',
        s.status === 'blocked' ? `waits on ${s.blockedBy.map(r => `${r}${board ? externalNote(board, r, track.name) : ''}`).join(', ')}` : '',
        s.evidence ?? '',
        s.note ?? '',
        s.lastAt && s.status !== 'todo' ? when(s.lastAt, now, offsetMin) : '',
      ].filter(Boolean)
      lines.push(`- ${box} ${s.priority ? `**${s.priority}** ` : ''}${track.name}/${s.id} ${s.title}${tags.length ? ` — ${tags.join('; ')}` : ''}`)
      if (s.why) lines.push(`  - why: ${s.why}`)
      if (s.scope) lines.push(`  - scope: ${s.scope}`)
      if (s.doneWhen) lines.push(`  - done when: ${s.doneWhen}`)
      if (s.review?.required) {
        lines.push(`  - review: ${policyText(s.review)}${s.reviews.length ? `; ${s.reviews.map(r => `${r.actor} ${r.verdict}`).join(', ')}` : '; none yet'}`)
      }
    }
    lines.push('')
  }
  const shelved = track.steps.filter(s => s.backlog).sort(byPriority)
  if (shelved.length) {
    lines.push(`### Backlog (${shelved.length})`)
    for (const s of shelved) {
      lines.push(`- [ ] ${s.priority ? `**${s.priority}** ` : ''}${track.name}/${s.id} ${s.title}${s.status !== 'todo' ? ` — ${s.status}` : ''}`)
    }
  }
  return lines.join('\n').trim()
}

export function boardMarkdown(board: RoadmapBoard, now: number, offsetMin: number): string {
  return board.tracks.filter(t => !t.archived).map(t => trackMarkdown(t, now, offsetMin, board)).join('\n\n')
}
