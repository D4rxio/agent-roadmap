// The roadmap's actions, once: what laying out a plan, marking, finishing, reading a step or the
// status means. Pure — no file, no engine: each action takes the journal as it stands and the input,
// and returns the events to append, the text to answer with and what the caller should do next (the
// step this chat now holds, a toast). The Claude Code tools (register.tsx) and the CLI (cli/roadmap.mjs)
// are thin layers that read, call one of these and write what it returns, so both behave the same.

import type { RoadmapEvent, RoadmapLive, RoadmapPriority, RoadmapReviewPolicy, RoadmapStatus } from '../types'
import {
  FOLLOW_UPS,
  PRIORITIES,
  STATUSES,
  brief,
  findCycle,
  family,
  fold,
  nextId,
  policyText,
  qualifies,
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
  /** How `actor` was established (see the review event's `via`). */
  via?: string
  /** Which front end writes: the mod's own tools, or the shared CLI. */
  channel?: 'tool' | 'cli'
  /** What this machine offers for a review by another model, e.g. Codex installed beside Claude. */
  hints?: { codexInstalled?: boolean; cli?: string }
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

const INDEPENDENCE = ['any', 'other-session', 'cross-model'] as const

/** A review policy from tool input, or an error saying what is wrong with it. */
export function readPolicy(raw: unknown): { policy?: RoadmapReviewPolicy; error?: string } {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object') return { error: 'review must be an object: { required, independence, mode }' }
  const r = raw as Record<string, unknown>
  if (r.required !== true && r.required !== false && r.required !== 'true' && r.required !== 'false') {
    return { error: 'review.required must be true or false — say it explicitly; { "required": false } opts out on purpose' }
  }
  const required = r.required === true || r.required === 'true'
  const independence = r.independence === undefined ? (required ? 'cross-model' : 'any') : r.independence
  if (!INDEPENDENCE.includes(independence as never)) {
    return { error: `review.independence is one of ${INDEPENDENCE.join(', ')}` }
  }
  const mode = r.mode === undefined ? undefined : r.mode
  if (mode !== undefined && mode !== 'standard' && mode !== 'adversarial') return { error: 'review.mode is standard or adversarial' }
  return { policy: { required, independence: independence as RoadmapReviewPolicy['independence'], mode: mode as RoadmapReviewPolicy['mode'] } }
}

/** What an agent is told about a step that waits: for a review its policy requires, or for the person. */
function waiting(
  s: { reviewPending?: boolean; reviewState?: string; passedReview?: { actor: string }; review?: { independence?: string }; implementer?: { actor: string } } | undefined,
): string {
  if (s?.reviewState === 'reviewed' && !s.reviewPending) {
    return `reviewed by ${s.passedReview?.actor ?? 'another model'}; awaiting the person's confirmation (a cross-model review is confirmed by the person)`
  }
  if (s?.reviewPending) {
    const who = s.review?.independence === 'cross-model' ? `a cross-model review (the reviewer must not be ${family(s.implementer?.actor)})` : 'an independent review'
    return s.reviewState === 'failed'
      ? `waits for ${who}: the last one failed — fix the findings and have it reviewed again`
      : `waits for ${who} before it counts as done — have it reviewed and recorded with roadmap review`
  }
  return "awaiting the person's confirmation (checkpoint or reopened after failure)"
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
          review: readPolicy(s.review).policy,
          reviewError: readPolicy(s.review).error,
        }
      })
      .filter(s => s.id && !ids.has(s.id) && ids.add(s.id)),
  }))
  const bad = phases.flatMap(p => p.steps.filter(s => s.reviewError).map(s => `${s.id}: ${s.reviewError}`))
  const trackPolicy = readPolicy(input.review)
  if (trackPolicy.error) bad.push(`track: ${trackPolicy.error}`)
  if (bad.length) return refused(`Not laid out: ${bad.join('; ')}.`)
  // Steps new to this track must say how their work is reviewed — on the step, or as the track's
  // default (this plan's or an earlier one's). Steps that already exist may go without.
  const before = fold(ctx.events, [], ctx.now).tracks.find(t => t.name === track)
  const existing = new Set(before?.steps.map(s => s.id) ?? [])
  const fallback = trackPolicy.policy ?? before?.review
  const unruled = phases.flatMap(p => p.steps.filter(s => !existing.has(s.id) && !s.review && !fallback).map(s => s.id))
  if (unruled.length) {
    return refused(
      `Not laid out: new steps need a review policy (${unruled.join(', ')}). Give \`review\` on each new step or on the track: ` +
        '{ "required": true, "independence": "cross-model", "mode": "adversarial" } — independence is any, ' +
        'other-session or cross-model (a different model family from the implementer). { "required": false } opts out on purpose.',
    )
  }
  const planned: RoadmapEvent = {
    kind: 'plan',
    at: ctx.now,
    session: ctx.session,
    track,
    title: input.title === undefined ? undefined : String(input.title),
    phases: phases.map(p => ({ name: p.name, steps: p.steps.map(({ reviewError: _e, ...step }) => step) })),
    review: trackPolicy.policy,
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
  const laidOut = would.tracks.find(t => t.name === track)
  const kept = phases.flatMap(p =>
    p.steps.filter(s => s.review && JSON.stringify(laidOut?.steps.find(x => x.id === s.id)?.review) !== JSON.stringify(s.review)).map(s => s.id),
  )
  const keptTrack = trackPolicy.policy && JSON.stringify(laidOut?.review) !== JSON.stringify(trackPolicy.policy)
  const warn =
    (dangling.length ? ` Note: blocked_by names steps that do not exist (yet): ${dangling.join(', ')}.` : '') +
    (kept.length || keptTrack
      ? ` Kept the stricter review policy already in force for ${[...(keptTrack ? ['the track'] : []), ...kept].join(', ')}: a plan can raise a policy, not lower it (the person may still confirm a step without review in the pane).`
      : '')
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
        ? `${ref2} → ${waiting(s)}.`
        : `${ref2} → ${s?.status ?? status}.`
  return {
    ok: true,
    text: said,
    emit,
    track: ref.track,
    focus: status === 'running' ? ref2 : undefined,
    toast: s?.status === 'done' ? `✓ ${ref2}` : s?.status === 'awaiting' && !s.reviewPending ? `◆ ${ref2} awaits your confirmation` : s?.reviewPending ? `⚖ ${ref2} waits for a review` : undefined,
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
  const state = s?.status === 'awaiting' ? waiting(s) : (s?.status ?? status)
  const ups = added.length
    ? `\nFollow-ups set aside in the backlog for the person to schedule:\n${added.map(x => `- ${x}`).join('\n')}`
    : ''
  return {
    ok: true,
    text: `${ref2} → ${state}.${ups}`,
    emit,
    track: ref.track,
    focus: ref2,
    toast: s?.status === 'done' ? `✓ ${ref2}` : s?.status === 'awaiting' && !s.reviewPending ? `◆ ${ref2} awaits your confirmation` : s?.reviewPending ? `⚖ ${ref2} waits for a review` : undefined,
  }
}

/** Record a review of a step's work, as the reviewer. Says whether it satisfies the step's policy. */
export function reviewAction(ctx: ActionContext, input: Record<string, unknown>): ActionResult {
  const now = fold(ctx.events, [], ctx.now)
  const ref = parseRef(String(input.step ?? ''), now.tracks, ctx.track)
  const step = ref && now.tracks.find(t => t.name === ref.track)?.steps.find(s => s.id === ref.id)
  if (!ref || !step) return unknownStep(ctx, input.step)
  if (step.reportedAt === undefined) {
    return refused(
      `${ref.track}/${ref.id} has no work reported done to review: a review reviews the work a worker last reported done, so record it after that done.`,
    )
  }
  if (ctx.channel === 'cli' && family(ctx.actor) === 'claude') {
    return refused('Claude records reviews with its own roadmap review tool, where the host vouches for who it is — not through the CLI.')
  }
  const verdict = input.verdict
  if (verdict !== 'pass' && verdict !== 'findings' && verdict !== 'fail') {
    return refused('verdict is pass, findings (passed with findings to follow up) or fail.')
  }
  const ev: RoadmapEvent = {
    kind: 'review',
    at: ctx.now,
    session: ctx.session,
    track: ref.track,
    id: ref.id,
    actor: ctx.actor,
    verdict,
    evidence: text(input.evidence),
    note: text(input.note),
    via: ctx.via,
  }
  const ref2 = `${ref.track}/${ref.id}`
  const s = after(ctx, [ev], ref.track, ref.id)
  const counts = step.review?.required
    ? qualifies(step.review, step.implementer, { actor: ctx.actor, session: ctx.session, verdict, at: ctx.now, via: ctx.via })
    : true
  const why = !counts
    ? step.review?.independence === 'cross-model' && ctx.via === 'declared'
      ? ` It does not satisfy the policy: "${ctx.actor}" is only declared (--actor), with no host behind it, and a cross-model review needs one. Run the review from inside the other model's own tool.`
      : step.review?.independence === 'cross-model'
      ? ` It does not satisfy the policy: the reviewer (${family(ctx.actor)}) is the same model family as the implementer (${family(step.implementer?.actor)}). Ask another model to review.`
      : ' It does not satisfy the policy: the reviewer is the session that implemented it.'
    : ''
  const state =
    s?.status === 'done'
      ? 'done'
      : s?.status === 'awaiting'
        ? `awaiting (${s.reviewPending ? 'review still owed' : s.reviewState === 'reviewed' ? 'reviewed: a cross-model review is confirmed by the person in the Roadmap pane' : 'the person confirms'})`
        : s?.status
  return {
    ok: true,
    text: `Review of ${ref2} recorded: ${verdict}.${why} The step is ${state}.`,
    emit: [ev],
    track: ref.track,
    toast: counts ? `⚖ ${ref2} reviewed: ${verdict}` : undefined,
  }
}

/** One step's brief. Takes hold of the step only when this chat holds nothing yet. */
export function stepAction(ctx: ActionContext, input: Record<string, unknown>): ActionResult {
  const board = fold(ctx.events, ctx.lives, ctx.now)
  const ref = parseRef(String(input.step ?? ''), board.tracks, ctx.track)
  const base = ref && brief(board, ref.track, ref.id, ctx.session)
  if (!ref || !base) return unknownStep(ctx, input.step)
  const step = board.tracks.find(t => t.name === ref.track)?.steps.find(s => s.id === ref.id)
  const lines = [base]
  if (step?.review?.required) {
    const impl = family(step.implementer?.actor ?? ctx.actor)
    if (step.review.independence === 'cross-model' && impl === 'claude' && ctx.hints?.codexInstalled) {
      lines.push(
        `Codex is installed here: when the work is ready, have Codex review it (e.g. the codex-review skill of claudex-loop, ` +
          `or \`codex exec\`), and have Codex itself record the verdict with: ` +
          `${ctx.hints.cli ?? 'node ~/.claude/mods/roadmap/cli/roadmap.mjs'} review ${ref.track}/${ref.id} --verdict pass|findings|fail --evidence "…"`,
      )
    }
  }
  const said = lines.join('\n')
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
