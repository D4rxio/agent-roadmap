// The roadmap's actions, once: what laying out a plan, marking, finishing, reading a step or the
// status means. Pure — no file, no engine: each action takes the journal as it stands and the input,
// and returns the events to append, the text to answer with and what the caller should do next (the
// step this chat now holds, a toast). The Claude Code tools (register.tsx) and the CLI (cli/roadmap.mjs)
// are thin layers that read, call one of these and write what it returns, so both behave the same.

import type { RoadmapEvent, RoadmapLive, RoadmapPriority, RoadmapStatus } from '../types'
import {
  FOLLOW_UPS,
  PRIORITIES,
  STATUSES,
  brief,
  findCycle,
  fold,
  nextId,
  parseRef,
  slug,
  summary,
} from './model.ts'

export type ActionContext = {
  events: RoadmapEvent[]
  lives: RoadmapLive[]
  now: number
  /** The writer's session id. */
  session: string
  /** Who writes: `claude`, `codex`, … (an agent; the person's own words come from the pane). */
  actor: string
  /** The track this chat last worked in, for a bare step id. */
  track?: string
  /** The step this chat holds, if any. */
  focus?: string
}

export type ActionResult = {
  /** False when the input was refused; nothing is to be written then. */
  ok: boolean
  text: string
  /** Events to append, in order. */
  emit: RoadmapEvent[]
  /** The step this chat now holds (`<track>/<id>`), when the action takes hold of one. */
  focus?: string
  /** The track this chat now works in. */
  track?: string
  toast?: string
}

const refused = (text: string): ActionResult => ({ ok: false, text, emit: [] })

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

function unknownStep(ctx: ActionContext, step: unknown): ActionResult {
  return refused(`No step "${String(step)}". Known:\n${summary(fold(ctx.events, [], ctx.now), { open: 50 })}`)
}

/** The step as it stands once `extra` events are applied. */
function after(ctx: ActionContext, extra: RoadmapEvent[], track: string, id: string) {
  return fold([...ctx.events, ...extra], [], ctx.now).tracks.find(t => t.name === track)?.steps.find(s => s.id === id)
}

/** Lay out (or re-lay) one track. Refuses a layout whose dependencies close a loop. */
export function planAction(ctx: ActionContext, input: Record<string, unknown>): ActionResult {
  const track = slug(String(input.track ?? ''))
  if (!track) return refused('A track name is required (e.g. "api").')
  const raw = Array.isArray(input.phases) ? (input.phases as { name?: unknown; steps?: unknown }[]) : []
  const ids = new Set<string>()
  const phases = raw.map(p => ({
    name: String(p.name ?? ''),
    steps: (Array.isArray(p.steps) ? (p.steps as Record<string, unknown>[]) : [])
      .map(s => {
        const deps = s.blocked_by ?? s.blockedBy
        return {
          id: String(s.id ?? '').trim(),
          title: String(s.title ?? s.id ?? ''),
          checkpoint: s.checkpoint === true ? true : undefined,
          blockedBy: Array.isArray(deps) && deps.length ? deps.map(String) : undefined,
          why: text(s.why),
          scope: text(s.scope),
          doneWhen: text(s.done_when ?? s.doneWhen),
        }
      })
      .filter(s => s.id && !ids.has(s.id) && ids.add(s.id)),
  }))
  const planned: RoadmapEvent = {
    kind: 'plan',
    at: ctx.now,
    session: ctx.session,
    track,
    title: input.title === undefined ? undefined : String(input.title),
    phases,
    actor: ctx.actor,
  }
  const would = fold([...ctx.events, planned], [], ctx.now)
  const loop = findCycle(would.tracks)
  if (loop) {
    return refused(
      `Not laid out: blocked_by closes a loop, so none of these could ever start: ${loop.join(' → ')}. Break one link and lay the track out again.`,
    )
  }
  const known = new Set(would.tracks.flatMap(t => t.steps.map(x => `${t.name}/${x.id}`)))
  const dangling = [
    ...new Set(would.tracks.find(t => t.name === track)?.steps.flatMap(x => x.blockedBy.filter(r => !known.has(r))) ?? []),
  ]
  const warn = dangling.length ? ` Note: blocked_by names steps that do not exist (yet): ${dangling.join(', ')}.` : ''
  return {
    ok: true,
    text: `Track "${track}" laid out: ${phases.length} phases, ${ids.size} steps.${warn}`,
    emit: [planned],
    track,
  }
}

/** Report a status, or propose a priority / backlog, for a step or (`<track>/*`) a whole track. */
export function markAction(ctx: ActionContext, input: Record<string, unknown>): ActionResult {
  const status =
    STATUSES.includes(input.status as RoadmapStatus) && input.status !== 'awaiting' ? (input.status as RoadmapStatus) : undefined
  const priority =
    input.priority === 'none'
      ? null
      : PRIORITIES.includes(input.priority as RoadmapPriority)
        ? (input.priority as RoadmapPriority)
        : undefined
  const backlog =
    typeof input.backlog === 'boolean' ? input.backlog : input.backlog === 'true' ? true : input.backlog === 'false' ? false : undefined
  if (input.status !== undefined && !status) {
    return refused(`Unknown status; use one of ${STATUSES.filter(s => s !== 'awaiting').join(', ')}.`)
  }
  if (!status && priority === undefined && backlog === undefined) {
    return refused('Give a status, a priority (P0…P3 or none) or backlog (true/false).')
  }
  const reason = text(input.reason)
  if (status === 'skipped' && !reason) {
    return refused('A skip needs a reason: why will this step not be done? Pass `reason`.')
  }
  const now = fold(ctx.events, [], ctx.now)
  const whole = String(input.step ?? '').match(/^#?([\w.-]+)\/\*$/)
  if (whole) {
    const name = slug(whole[1] ?? '')
    if (!now.tracks.some(t => t.name === name)) return refused(`No track "${name}".`)
    if (status) return refused('A whole track takes a priority or backlog, not a status.')
    const ev: RoadmapEvent = { kind: 'triage', at: ctx.now, session: ctx.session, track: name, priority, backlog, origin: 'agent' }
    const t = fold([...ctx.events, ev], [], ctx.now).tracks.find(x => x.name === name)
    const kept = t?.triagedBy === 'you' ? " (the person's own choice stands)" : ''
    return { ok: true, text: `${name}: priority ${t?.priority ?? 'none'}, ${t?.backlog ? 'in backlog' : 'active'}${kept}.`, emit: [ev] }
  }
  const ref = parseRef(String(input.step ?? ''), now.tracks, ctx.track)
  if (!ref || !now.tracks.find(t => t.name === ref.track)?.steps.some(s => s.id === ref.id)) return unknownStep(ctx, input.step)
  const ref2 = `${ref.track}/${ref.id}`
  const emit: RoadmapEvent[] = []
  if (priority !== undefined || backlog !== undefined) {
    emit.push({ kind: 'triage', at: ctx.now, session: ctx.session, track: ref.track, id: ref.id, priority, backlog, origin: 'agent' })
  }
  if (!status) {
    const s = after(ctx, emit, ref.track, ref.id)
    const kept = s?.triagedBy === 'you' ? " (the person's own choice stands)" : ''
    return {
      ok: true,
      text: `${ref2}: priority ${s?.priority ?? 'none'}, ${s?.backlog ? 'in backlog' : 'active'}${kept}.`,
      emit,
      track: ref.track,
    }
  }
  emit.push({
    kind: 'step',
    at: ctx.now + 1,
    session: ctx.session,
    track: ref.track,
    id: ref.id,
    status,
    note: text(input.note),
    evidence: text(input.evidence),
    reason,
    origin: 'agent',
    actor: ctx.actor,
  })
  const s = after(ctx, emit, ref.track, ref.id)
  const said =
    s?.status === 'awaiting' && s.proposed === 'skipped'
      ? `${ref2} → skip proposed; the person confirms or rejects it in the Roadmap pane.`
      : s?.status === 'awaiting'
        ? `${ref2} → awaiting the person's confirmation (checkpoint or reopened after failure).`
        : `${ref2} → ${s?.status ?? status}.`
  return {
    ok: true,
    text: said,
    emit,
    track: ref.track,
    focus: status === 'running' ? ref2 : undefined,
    toast: s?.status === 'done' ? `✓ ${ref2}` : s?.status === 'awaiting' ? `◆ ${ref2} awaits your confirmation` : undefined,
  }
}

/** Close work on a step: what shipped, the evidence, and follow-ups filed in the backlog. */
export function doneAction(ctx: ActionContext, input: Record<string, unknown>): ActionResult {
  const now = fold(ctx.events, [], ctx.now)
  const ref = parseRef(String(input.step ?? ''), now.tracks, ctx.track)
  if (!ref || !now.tracks.find(t => t.name === ref.track)?.steps.some(s => s.id === ref.id)) return unknownStep(ctx, input.step)
  const shipped = text(input.shipped)
  if (!shipped) return refused('Say what shipped: `shipped` is required.')
  const ref2 = `${ref.track}/${ref.id}`
  const status: RoadmapStatus = input.status === 'failed' ? 'failed' : 'done'
  const emit: RoadmapEvent[] = [
    {
      kind: 'step',
      at: ctx.now,
      session: ctx.session,
      track: ref.track,
      id: ref.id,
      status,
      note: shipped,
      evidence: text(input.evidence),
      origin: 'agent',
      actor: ctx.actor,
    },
  ]
  const raw = Array.isArray(input.follow_ups) ? (input.follow_ups as { title?: unknown; priority?: unknown }[]) : []
  const added: string[] = []
  let at = ctx.now + 1
  for (const f of raw) {
    const title = text(f.title)
    if (!title) continue
    const all = [...ctx.events, ...emit]
    const track = fold(all, [], ctx.now).tracks.find(t => t.name === ref.track)
    if (!track) break
    const id = nextId(track, all, 'f')
    const priority = PRIORITIES.includes(f.priority as RoadmapPriority) ? (f.priority as RoadmapPriority) : undefined
    emit.push({ kind: 'add', at: at++, session: ctx.session, track: ref.track, id, title, phase: FOLLOW_UPS, origin: 'agent' })
    emit.push({ kind: 'triage', at: at++, session: ctx.session, track: ref.track, id, backlog: true, priority, origin: 'agent' })
    added.push(`${ref.track}/${id} ${title}`)
  }
  const s = after(ctx, emit, ref.track, ref.id)
  const state =
    s?.status === 'awaiting' ? "awaiting the person's confirmation (checkpoint or reopened after failure)" : (s?.status ?? status)
  const ups = added.length
    ? `\nFollow-ups set aside in the backlog for the person to schedule:\n${added.map(x => `- ${x}`).join('\n')}`
    : ''
  return {
    ok: true,
    text: `${ref2} → ${state}.${ups}`,
    emit,
    track: ref.track,
    focus: ref2,
    toast: s?.status === 'done' ? `✓ ${ref2}` : s?.status === 'awaiting' ? `◆ ${ref2} awaits your confirmation` : undefined,
  }
}

/** One step's brief. Takes hold of the step only when this chat holds nothing yet. */
export function stepAction(ctx: ActionContext, input: Record<string, unknown>): ActionResult {
  const board = fold(ctx.events, ctx.lives, ctx.now)
  const ref = parseRef(String(input.step ?? ''), board.tracks, ctx.track)
  const said = ref && brief(board, ref.track, ref.id, ctx.session)
  if (!ref || !said) return unknownStep(ctx, input.step)
  return { ok: true, text: said, emit: [], track: ref.track, focus: ctx.focus ? undefined : `${ref.track}/${ref.id}` }
}

/** Every track's open steps, and the other chats working now. */
export function statusAction(ctx: ActionContext): ActionResult {
  const board = fold(ctx.events, ctx.lives, ctx.now)
  const live = board.sessions.filter(s => s.isLive && s.id !== ctx.session)
  const others = live.length
    ? `\nOther sessions working now:\n${live
        .map(s => `- ${s.title}${s.focus ? ` [holds ${s.focus}]` : s.track ? ` [${s.track}]` : ''}${s.activity ? ` → ${s.activity}` : ''}`)
        .join('\n')}`
    : ''
  return { ok: true, text: summary(board, { open: 50 }) + others, emit: [] }
}
