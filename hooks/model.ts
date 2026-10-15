import type {
  RoadmapPriority,
  RoadmapAgent,
  RoadmapOrigin,
  RoadmapBoard,
  RoadmapEvent,
  RoadmapLive,
  RoadmapSession,
  RoadmapStatus,
  RoadmapStep,
  RoadmapTrack,
  RoadmapWindow,
} from '../types'

export const STATUSES: RoadmapStatus[] = ['todo', 'running', 'done', 'failed', 'blocked', 'awaiting']
/** A live file older than this is a session that stopped working. */
export const LIVE_MS = 20_000

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
export function fold(events: RoadmapEvent[], lives: RoadmapLive[], now: number): RoadmapBoard {
  const sorted = [...events].sort((a, b) => a.at - b.at)
  const tracks = new Map<string, RoadmapTrack>()
  const sessions = new Map<string, RoadmapSession>()
  const agents = new Map<string, RoadmapAgent>()
  type Word = {
    at: number
    status: RoadmapStatus
    note?: string
    evidence?: string
    startedAt?: number
    origin: RoadmapOrigin
    by?: string
  }
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
      const steps: RoadmapStep[] = [...laid].map(([id, t]) => ({
        track: e.track,
        id,
        title: t.title,
        phase: t.phase,
        status: 'todo',
        checkpoint: t.checkpoint === true,
        blockedBy: (t.blockedBy ?? []).map(r => (r.includes('/') ? r.replace(/^#/, '') : `${e.track}/${r}`)),
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
        origin,
        by: origin === 'person' ? 'you' : (s?.title ?? e.actor),
      })
      if (s && origin !== 'person') s.track = e.track
    } else if (e.kind === 'session') {
      const s = sessions.get(e.session)
      if (s) {
        s.title = e.title
        s.actor = e.actor ?? s.actor
        s.track = e.track ?? s.track
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
          say(e.track, e.step, { at: e.at, status: 'running', startedAt: e.at, origin: 'agent', by: e.description })
        }
      }
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
    say(a.track, a.step, { at: last, status: failed ? 'failed' : 'done', origin: 'agent', by: a.description })
  }

  layOverPersonEdits(tracks, sorted)
  applyTriage(tracks, sorted, sessions)

  for (const t of tracks.values()) {
    for (const step of t.steps) {
      const said = (words.get(key(t.name, step.id)) ?? []).sort((a, b) => a.at - b.at)
      step.agents = [...agents.values()].filter(a => a.track === t.name && a.step === step.id).map(a => a.id)
      // Plan vs execution: a worker reports, the person closes. A worker's `done` on a
      // checkpoint, or out of `failed`, waits for the person instead.
      let status: RoadmapStatus = 'todo'
      for (const w of said) {
        const gated: boolean = w.origin !== 'person' && w.status === 'done' && (step.checkpoint || status === 'failed')
        status = gated ? 'awaiting' : w.status
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
      step.endedAt = status === 'done' || status === 'failed' ? latest.at : undefined
    }
  }

  // A step waiting on unfinished steps is blocked until they are done.
  const doneRefs = new Set(
    [...tracks.values()].flatMap(t => t.steps.filter(s => s.status === 'done').map(s => key(t.name, s.id))),
  )
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
      if (live.title) s.title = live.title
      s.track = s.track ?? live.track
    } else {
      sessions.set(live.session, {
        id: live.session,
        title: live.title || live.session.slice(0, 8),
        actor: 'claude',
        track: live.track,
        startedAt: live.at,
        lastAt: live.at,
        isLive,
        activity: isLive ? live.activity : undefined,
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

  return {
    // Most important first (P0 … unprioritized), then the most recently moved.
    tracks: [...tracks.values()].sort((a, b) => trackRank(a) - trackRank(b) || b.updatedAt - a.updatedAt),
    sessions: [...sessions.values()].sort((a, b) => b.lastAt - a.lastAt),
    agents: [...agents.values()].sort((a, b) => b.startedAt - a.startedAt),
    at: now,
  }
}

export const ICONS: Record<RoadmapStatus, string> = {
  todo: '○',
  running: '◐',
  done: '✓',
  failed: '✗',
  blocked: '⊘',
  awaiting: '◆',
}

/** What needs the person, across every track. */
export function attention(board: RoadmapBoard): { awaiting: RoadmapStep[]; blocked: RoadmapStep[]; failed: RoadmapStep[] } {
  const all = board.tracks.filter(t => !t.backlog).flatMap(t => t.steps)
  return {
    awaiting: all.filter(s => s.status === 'awaiting'),
    blocked: all.filter(s => s.status === 'blocked' && !s.backlog),
    failed: all.filter(s => s.status === 'failed' && !s.backlog),
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
      const phaseName = e.phase && t.phases.some(p => p.name === e.phase) ? e.phase : YOUR_PHASE
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
  }
  for (const t of tracks.values()) {
    const tp = prio.get(t.name)
    const tb = back.get(t.name)
    t.priority = tp?.value ?? undefined
    t.backlog = tb?.value === true
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

export const PRIORITIES: RoadmapPriority[] = ['P0', 'P1', 'P2', 'P3']

function trackRank(t: RoadmapTrack): number {
  return t.priority ? PRIORITIES.indexOf(t.priority) : PRIORITIES.length
}

/** P0 first, unprioritized last; ties keep the plan's order. */
export function byPriority(a: RoadmapStep, b: RoadmapStep): number {
  const rank = (s: RoadmapStep) => (s.priority ? PRIORITIES.indexOf(s.priority) : PRIORITIES.length)
  return rank(a) - rank(b)
}

/** The next free id for a step the person adds: u1, u2, … */
export function nextPersonId(track: RoadmapTrack, events: RoadmapEvent[]): string {
  const used = new Set([...track.steps.map(s => s.id), ...events.filter(e => e.kind === 'add' && e.track === track.name).map(e => (e as { id: string }).id)])
  let n = 1
  while (used.has(`u${n}`)) n++
  return `u${n}`
}

/** The track's progress over the steps that count: backlog steps are set aside. */
export function progress(track: RoadmapTrack): { done: number; total: number } {
  const active = track.steps.filter(s => !s.backlog)
  return { done: active.filter(s => s.status === 'done').length, total: active.length }
}

/** What the model reads at a session's start and from the status tool. */
export function summary(board: RoadmapBoard, opts: { open?: number } = {}): string {
  if (board.tracks.length === 0) return 'The roadmap has no tracks yet.'
  const lines: string[] = []
  for (const t of board.tracks.filter(x => !x.backlog)) {
    const { done, total } = progress(t)
    lines.push(`- ${t.priority ? `${t.priority} ` : ''}${t.name} — ${t.title}: ${done}/${total} done`)
    // Open work, most important first: what a new session should pick up.
    const open = t.steps.filter(s => s.status !== 'done' && !s.backlog).sort(byPriority)
    for (const s of open.slice(0, opts.open ?? 6)) {
      const why = s.status === 'blocked' ? ` (blocked by ${s.blockedBy.join(', ')})` : s.status === 'awaiting' ? ' (awaiting the person)' : ''
      lines.push(`    ${ICONS[s.status]} ${s.priority ? `${s.priority} ` : ''}${t.name}/${s.id} ${s.title}${s.checkpoint ? ' [checkpoint]' : ''}${s.addedBy ? ' [added by the person]' : ''}${why}`)
    }
    if (open.length > (opts.open ?? 6)) lines.push(`    … ${open.length - (opts.open ?? 6)} more open`)
    const shelved = t.steps.filter(s => s.backlog)
    if (shelved.length) {
      lines.push(`    backlog (set aside, not to work on unless asked): ${shelved.map(s => `${t.name}/${s.id}`).join(', ')}`)
    }
  }
  const shelvedTracks = board.tracks.filter(x => x.backlog)
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
  kind: 'done' | 'started' | 'failed' | 'awaiting' | 'session' | 'agent'
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

export function trackMarkdown(track: RoadmapTrack, now: number, offsetMin: number): string {
  const { done, total } = progress(track)
  const lines = [`## ${track.title} — ${total ? Math.round((done / total) * 100) : 0}% (${done}/${total})`, '']
  for (const p of track.phases) {
    const own = track.steps.filter(s => p.stepIds.includes(s.id))
    const own2 = own.filter(s => !s.backlog)
    if (own2.length === 0) continue
    lines.push(`### ${p.name} (${own2.filter(s => s.status === 'done').length}/${own2.length})`)
    for (const s of own2) {
      const box = s.status === 'done' ? '[x]' : '[ ]'
      const tags = [
        s.status !== 'done' && s.status !== 'todo' ? s.status : '',
        s.checkpoint ? 'checkpoint' : '',
        s.addedBy ? 'added by you' : '',
        s.status === 'blocked' ? `waits on ${s.blockedBy.join(', ')}` : '',
        s.evidence ?? '',
        s.note ?? '',
        s.lastAt && s.status !== 'todo' ? when(s.lastAt, now, offsetMin) : '',
      ].filter(Boolean)
      lines.push(`- ${box} ${s.priority ? `**${s.priority}** ` : ''}${track.name}/${s.id} ${s.title}${tags.length ? ` — ${tags.join('; ')}` : ''}`)
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
  return board.tracks.map(t => trackMarkdown(t, now, offsetMin)).join('\n\n')
}
