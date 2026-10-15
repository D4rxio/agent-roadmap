import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  RoadmapBoard,
  RoadmapEvent,
  RoadmapPriority,
  RoadmapLive,
  RoadmapStatus,
} from '../types'
import {
  LIVE_MS,
  attention,
  STATUSES,
  describeCall,
  duration,
  fold,
  parseRef,
  progress,
  refInText,
  slug,
  summary,
  PRIORITIES,
  boardMarkdown,
  nextPersonId,
  trackMarkdown,
} from './model'
import { drawBand, drawPane } from './view'
import type { RoadmapView } from './view'

const PANE = 'roadmap'
const TOOL_PLAN = 'mcp__roadmap__plan'
const TOOL_MARK = 'mcp__roadmap__mark'
const TOOL_STATUS = 'mcp__roadmap__status'
const EMPTY: RoadmapBoard = { tracks: [], sessions: [], agents: [], at: 0 }

const board = atom({ plugin: 'roadmap', key: 'board' } as const, EMPTY)
const view = atom({ plugin: 'roadmap', key: 'view' } as const, 'tracks')
const expanded = atom({ plugin: 'roadmap', key: 'expanded' } as const, [])
const paneOpen = atom({ plugin: 'roadmap', key: 'paneOpen' } as const, false)
const showBand = atom({ plugin: 'roadmap', key: 'band' } as const, true)
const tzOffset = atom({ plugin: 'roadmap', key: 'tz' } as const, 0)
const editing = atom({ plugin: 'roadmap', key: 'editing' } as const, '')

// The module's own memory of the shared journal; a reload re-reads it from disk.
const journal = {
  dir: '',
  me: '',
  title: '',
  track: undefined as string | undefined,
  activity: undefined as string | undefined,
  activeAt: 0,
  isOpened: false,
  seen: new Set<string>(),
  events: [] as RoadmapEvent[],
  lives: new Map<string, { mtimeMs: number; live: RoadmapLive }>(),
  agents: new Map<string, { activity?: string; tools: number }>(),
}


/** The first line of a prompt that is words, not a tag (pasted blocks open with one). */
function titleOf(text: string): string {
  const line = text
    .replace(/<[^>]*>/g, ' ')
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0)
  return (line ?? 'pasted content').slice(0, 60)
}

function rand(): string {
  return Math.random().toString(36).slice(2, 8)
}

function parse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

async function republish($: EngineInterface) {
  const next = fold(journal.events, [...journal.lives.values()].map(l => l.live), Date.now())
  await update($, board, () => next)
  const live = next.sessions.filter(s => s.isLive).length
  const running = next.agents.filter(a => a.status === 'running').length
  const tracks = next.tracks.filter(t => !t.backlog).map(t => {
    const { done, total } = progress(t)
    return `${t.name} ${done}/${total}`
  })
  const awaiting = next.tracks.flatMap(t => t.steps).filter(s => s.status === 'awaiting').length
  $.ui.status(
    [
      'roadmap',
      tracks.length ? tracks.slice(0, 3).join(' · ') : 'no tracks yet',
      awaiting ? `◆ ${awaiting} to confirm` : '',
      running ? `${running} agents` : '',
      live > 1 ? `${live} sessions` : '',
    ]
      .filter(Boolean)
      .join(' · '),
  )
}

/** Reads what other sessions wrote since the last look. */
async function sync($: EngineInterface) {
  const eventsDir = `${journal.dir}/events`
  if (await $.fs.exists(eventsDir)) {
    for (const entry of await $.fs.list(eventsDir)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json') || journal.seen.has(entry.name)) continue
      journal.seen.add(entry.name)
      const ev = parse<RoadmapEvent>(await $.fs.read(`${eventsDir}/${entry.name}`))
      if (ev && typeof ev.at === 'number' && typeof ev.kind === 'string') journal.events.push(ev)
    }
  }
  const liveDir = `${journal.dir}/live`
  if (await $.fs.exists(liveDir)) {
    for (const entry of await $.fs.list(liveDir)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      if (journal.lives.get(entry.name)?.mtimeMs === entry.mtimeMs) continue
      const live = parse<RoadmapLive>(await $.fs.read(`${liveDir}/${entry.name}`))
      if (live && typeof live.at === 'number') journal.lives.set(entry.name, { mtimeMs: entry.mtimeMs, live })
    }
  }
}

/** Adds one event to the shared journal: a file of its own, so no session overwrites another. */
async function emit($: EngineInterface, ev: RoadmapEvent) {
  const name = `${ev.at}-${journal.me.slice(0, 8)}-${rand()}.json`
  journal.seen.add(name)
  journal.events.push(ev)
  await $.fs.write(`${journal.dir}/events/${name}`, JSON.stringify(ev))
  await republish($)
}

/** This session's live file: what it and its agents do right now. */
async function heartbeat($: EngineInterface, force = false) {
  const now = Date.now()
  const busy = now - journal.activeAt < LIVE_MS || journal.agents.size > 0
  if (!busy && !force) return
  const live: RoadmapLive = {
    session: journal.me,
    title: journal.title,
    track: journal.track,
    activity: journal.activity,
    at: force && !busy ? now - LIVE_MS : now,
    agents: [...journal.agents].map(([agentId, a]) => ({ agentId, ...a })),
  }
  await $.fs.write(`${journal.dir}/live/${journal.me}.json`, JSON.stringify(live))
  journal.lives.set(`${journal.me}.json`, { mtimeMs: now, live })
}

async function endAgent($: EngineInterface, agentId: string, status: RoadmapStatus) {
  const known = (await read($, board)).agents.find(a => a.id === agentId)
  journal.agents.delete(agentId)
  if (!known || known.status !== 'running') return
  await emit($, { kind: 'agent-end', at: Date.now(), session: journal.me, agentId, status })
  $.ui.toast(`${status === 'done' ? '✓' : '✗'} ${known.description}`)
}

/** The person's own word on a step, from a pane button: the one origin that closes a checkpoint. */
async function openPane($: EngineInterface) {
  await update($, paneOpen, () => true)
  await $.ui.open({ id: PANE, title: 'Roadmap' })
}

async function togglePane($: EngineInterface) {
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (isUp) await $.ui.close({ id: PANE })
  else await openPane($)
}

/** The host's UTC offset in minutes, from `date +%z` (the module itself has no time zone). */
async function hostOffset($: EngineInterface): Promise<number> {
  const out = await $.process.run(['date', '+%z']).catch(() => undefined)
  const m = out?.stdout.trim().match(/^([+-])(\d{2})(\d{2})$/)
  // No `date` (Windows): the environment's own idea of the offset, UTC at worst.
  if (!m) return -new Date().getTimezoneOffset()
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
}

/** The person's own edits from the pane: each its own event, laid over every plan. */
async function personAdd($: EngineInterface, track: string, title: string) {
  const t = (await read($, board)).tracks.find(x => x.name === track)
  if (!t) return
  const id = nextPersonId(t, journal.events)
  await emit($, { kind: 'add', at: Date.now(), session: journal.me, track, id, title, origin: 'person' })
  $.ui.toast(`✎ ${track}/${id} added`)
}

async function personEdit($: EngineInterface, track: string, id: string, change: { title?: string; removed?: boolean }) {
  await emit($, { kind: 'edit', at: Date.now(), session: journal.me, track, id, ...change, origin: 'person' })
}

async function personTriage($: EngineInterface, track: string, id: string, change: { priority?: RoadmapPriority | null; backlog?: boolean }) {
  await emit($, { kind: 'triage', at: Date.now(), session: journal.me, track, id, ...change, origin: 'person' })
  if (change.backlog !== undefined) $.ui.toast(change.backlog ? `→ ${track}/${id} moved to backlog` : `↺ ${track}/${id} restored`)
}

async function personTrackTriage($: EngineInterface, track: string, change: { priority?: RoadmapPriority | null; backlog?: boolean }) {
  await emit($, { kind: 'triage', at: Date.now(), session: journal.me, track, ...change, origin: 'person' })
  if (change.backlog !== undefined) $.ui.toast(change.backlog ? `${track} moved to backlog` : `↺ ${track} restored`)
}

async function personStatus($: EngineInterface, track: string, id: string, status: RoadmapStatus) {
  await emit($, { kind: 'step', at: Date.now(), session: journal.me, track, id, status, origin: 'person', actor: 'person' })
}

async function decide($: EngineInterface, track: string, id: string, status: RoadmapStatus) {
  await emit($, { kind: 'step', at: Date.now(), session: journal.me, track, id, status, origin: 'person', actor: 'person' })
  $.ui.toast(`${status === 'done' ? '✓' : '✗'} ${track}/${id} ${status === 'done' ? 'confirmed' : 'rejected'}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    journal.dir = (await $.env.get('CLAUDE_ROADMAP_DIR')) ?? `${home}/.claude/roadmap`
    journal.me = await $.session.id()
    await update($, tzOffset, () => 0)
    void hostOffset($).then(min => update($, tzOffset, () => min)).catch(() => undefined)
    const band = await $.store.get('band').catch(() => undefined)
    await update($, showBand, () => band !== false)

    await $.command.register({
      name: 'roadmap',
      description:
        'Shared roadmap: `show` / `hide` the pane (no argument toggles it), `copy` copies it as Markdown, `band` toggles the line above the prompt',
      argumentHint: '[show|hide|copy|band]',
    })
    await $.tool.register({
      name: 'plan',
      isDeferred: false,
      description:
        'Lay out one track (a workstream, e.g. "api", "web", "docs") of the roadmap shared by ALL ' +
        'sessions: phases, each with steps. Re-laying a track keeps step statuses for the same ids. Step ids are ' +
        'short ("1.1"); the full reference is "<track>/<id>". Put "#<track>/<id>" in an Agent call\'s ' +
        'description (e.g. "#api/2.1 Map the endpoints") and the step ticks off with a green check when ' +
        'the agent finishes. Mark steps the person must sign off as checkpoint, and dependencies as blocked_by. ' +
        'Steps the person added are marked "added by the person": keep them when you re-lay a track (you may ' +
        'refine their titles or move them into a phase; they are never lost even if you leave them out). ' +
        'Read the roadmap with the status tool first; never re-lay a track you were not asked to.',
      inputSchema: {
        type: 'object',
        properties: {
          track: { type: 'string', description: 'Short track name, e.g. "api", "web", "docs".' },
          title: { type: 'string', description: 'Human title of the track.' },
          phases: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                steps: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      title: { type: 'string' },
                      checkpoint: {
                        type: 'boolean',
                        description: 'Only the person can close it (e.g. "verified in prod", "merge approved").',
                      },
                      blocked_by: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Step ids that must be done first ("1.2", or "<track>/<id>").',
                      },
                    },
                    required: ['id', 'title'],
                  },
                },
              },
              required: ['name', 'steps'],
            },
          },
        },
        required: ['track', 'phases'],
      },
    })
    await $.tool.register({
      name: 'mark',
      isDeferred: false,
      description:
        'Report a roadmap step\'s status: todo, running, done, failed or blocked. `step` is "<track>/<id>" ' +
        '(or "<id>" for this session\'s track). Mark running when you start, done when finished and verified, ' +
        'with `evidence` (tests passed, commit, PR). You report; the person closes: done on a checkpoint step, ' +
        'or after failed, becomes "awaiting" the person\'s confirmation in the Roadmap pane. Agent-linked steps ' +
        '("#<track>/<id>" in the Agent description) report themselves. You may also propose `priority` ' +
        '(P0 most urgent … P3, or "none") or `backlog` (true sets a step aside, false brings it back); the ' +
        'person\'s own choice of either always stands over yours. `step` "<track>/*" sets them for a whole ' +
        'track. Never work on a backlog step or track unless asked.',
      inputSchema: {
        type: 'object',
        properties: {
          step: { type: 'string' },
          status: { type: 'string', enum: STATUSES.filter(x => x !== 'awaiting') },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3', 'none'] },
          backlog: { type: 'boolean' },
          evidence: { type: 'string', description: 'What shows it: tests passed, commit, PR, measurement.' },
          note: { type: 'string', description: 'A few words: blocker, next step.' },
        },
        required: ['step'],
      },
    })
    await $.tool.register({
      name: 'status',
      isDeferred: false,
      description:
        'Read the roadmap shared by all sessions: every track with its open steps, plus the sessions working now.',
      inputSchema: { type: 'object', properties: {} },
    })

    await sync($).catch(() => undefined)
    await republish($)

    $.clock.every(3000, () => {
      void (async () => {
        await sync($)
        await heartbeat($)
        const mine = [...journal.agents.keys()]
        if (mine.length > 0) {
          const live = await $.agent.list()
          for (const id of mine) {
            const seen = live.find(l => l.id === id)
            if (seen?.status === 'completed') await endAgent($, id, 'done')
            else if (seen?.status === 'failed' || seen?.status === 'killed') await endAgent($, id, 'failed')
          }
        }
        await republish($)
      })().catch(() => undefined)
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    journal.activeAt = 0
    journal.activity = undefined
    await heartbeat($, true).catch(() => undefined)
    return next(e)
  })

  // What a new session reads first: the tracks and their open steps.
  on('prompt.context', async ($, e, next) => {
    const ran = await next(e)
    const now = await read($, board)
    if (now.tracks.length === 0) return ran
    const text =
      'A roadmap shared by all Claude sessions on this machine is shown to the person in the Roadmap pane.\n' +
      summary(now) +
      '\nIf this task is one of these steps: mark it running when you start and done with evidence when ' +
      'finished (roadmap mark), and put "#<track>/<id>" in each Agent description for that step. Checkpoints ' +
      'are closed by the person, not by you. Open steps are listed most important first (P0 … P3); ' +
      'backlog steps are set aside — do not work on them unless asked. New work → add a step with roadmap plan (read roadmap status first).'
    return { ...ran, blocks: [...ran.blocks, { name: 'roadmap', text }] }
  })

  on('prompt.submit', async ($, e, next) => {
    journal.activeAt = Date.now()
    if (!journal.isOpened) {
      journal.isOpened = true
      // A sidebar where the app docks one (desktop); the terminal opens it on /roadmap.
      const surfaces: readonly string[] = await $.session.surfaces().catch(() => [])
      if (surfaces.includes('desktop')) void openPane($).catch(() => undefined)
    }
    if (!journal.title && !e.text.trim().startsWith('/')) {
      journal.title = titleOf(e.text)
      if (journal.title) {
        await emit($, { kind: 'session', at: Date.now(), session: journal.me, title: journal.title, actor: 'claude' }).catch(
          () => undefined,
        )
      }
    }
    return next(e)
  })

  on('command.run', { command: 'roadmap' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'band') {
      const next = !(await read($, showBand))
      await update($, showBand, () => next)
      await $.store.set('band', next)
      return { text: `Roadmap band above the prompt ${next ? 'shown' : 'hidden'}.` }
    }
    if (arg === 'copy') {
      const b = await read($, board)
      const done = await $.ui.copy({ text: boardMarkdown(b, Date.now(), await read($, tzOffset)) })
      return { text: done.isCopied ? 'Roadmap copied as Markdown.' : `Could not copy: ${done.reason}` }
    }
    await sync($).catch(() => undefined)
    await republish($)
    if (arg === 'show') {
      await openPane($)
      return { text: 'Roadmap shown.' }
    }
    if (arg === 'hide') {
      await $.ui.close({ id: PANE })
      return { text: 'Roadmap hidden. `/roadmap show` brings it back.' }
    }
    await togglePane($)
    return { text: 'Roadmap toggled (`/roadmap show` / `/roadmap hide`).' }
  })

  on('tool.call', { tool: TOOL_PLAN }, async ($, e) => {
    const track = slug(String(e.track ?? ''))
    if (!track) return { result: 'A track name is required (e.g. "api").' }
    const raw = Array.isArray(e.phases) ? (e.phases as { name?: unknown; steps?: unknown }[]) : []
    const ids = new Set<string>()
    const phases = raw.map(p => ({
      name: String(p.name ?? ''),
      steps: (Array.isArray(p.steps) ? (p.steps as { id?: unknown; title?: unknown }[]) : [])
        .map(s => {
          const raw = s as { checkpoint?: unknown; blocked_by?: unknown; blockedBy?: unknown }
          const deps = raw.blocked_by ?? raw.blockedBy
          return {
            id: String(s.id ?? '').trim(),
            title: String(s.title ?? s.id ?? ''),
            checkpoint: raw.checkpoint === true ? true : undefined,
            blockedBy: Array.isArray(deps) && deps.length ? deps.map(String) : undefined,
          }
        })
        .filter(s => s.id && !ids.has(s.id) && ids.add(s.id)),
    }))
    journal.track = track
    await emit($, {
      kind: 'plan',
      at: Date.now(),
      session: journal.me,
      track,
      title: e.title === undefined ? undefined : String(e.title),
      phases,
      actor: 'claude',
    })
    void openPane($).catch(() => undefined)
    return { result: `Track "${track}" laid out: ${phases.length} phases, ${ids.size} steps.` }
  })

  on('tool.call', { tool: TOOL_MARK }, async ($, e) => {
    const status =
      STATUSES.includes(e.status as RoadmapStatus) && e.status !== 'awaiting' ? (e.status as RoadmapStatus) : undefined
    const priority =
      e.priority === 'none' ? null : PRIORITIES.includes(e.priority as RoadmapPriority) ? (e.priority as RoadmapPriority) : undefined
    const backlog = typeof e.backlog === 'boolean' ? e.backlog : undefined
    if (e.status !== undefined && !status) return { result: `Unknown status; use one of ${STATUSES.join(', ')}.` }
    if (!status && priority === undefined && backlog === undefined) {
      return { result: 'Give a status, a priority (P0…P3 or none) or backlog (true/false).' }
    }
    await sync($).catch(() => undefined)
    const now = fold(journal.events, [], Date.now())
    const whole = String(e.step ?? '').match(/^#?([\w.-]+)\/\*$/)
    if (whole) {
      const name = slug(whole[1] ?? '')
      if (!now.tracks.some(t => t.name === name)) return { result: `No track "${name}".` }
      if (status) return { result: 'A whole track takes a priority or backlog, not a status.' }
      if (priority === undefined && backlog === undefined) return { result: 'Give a priority or backlog for the track.' }
      await emit($, { kind: 'triage', at: Date.now(), session: journal.me, track: name, priority, backlog, origin: 'agent' })
      const t = (await read($, board)).tracks.find(x => x.name === name)
      const kept = t?.triagedBy === 'you' ? ' (the person\'s own choice stands)' : ''
      return { result: `${name}: priority ${t?.priority ?? 'none'}, ${t?.backlog ? 'in backlog' : 'active'}${kept}.` }
    }
    const ref = parseRef(String(e.step ?? ''), now.tracks, journal.track)
    const track = ref && now.tracks.find(t => t.name === ref.track)
    if (!ref || !track?.steps.some(s => s.id === ref.id)) {
      return { result: `No step "${String(e.step)}". Known:\n${summary(now, { open: 50 })}` }
    }
    journal.track = ref.track
    if (priority !== undefined || backlog !== undefined) {
      await emit($, { kind: 'triage', at: Date.now(), session: journal.me, track: ref.track, id: ref.id, priority, backlog, origin: 'agent' })
    }
    if (!status) {
      const t = (await read($, board)).tracks.find(x => x.name === ref.track)?.steps.find(x => x.id === ref.id)
      const kept = t && t.triagedBy === 'you' ? ' (the person\'s own choice stands)' : ''
      return { result: `${ref.track}/${ref.id}: priority ${t?.priority ?? 'none'}, ${t?.backlog ? 'in backlog' : 'active'}${kept}.` }
    }
    await emit($, {
      kind: 'step',
      at: Date.now(),
      session: journal.me,
      track: ref.track,
      id: ref.id,
      status,
      note: e.note === undefined ? undefined : String(e.note),
      evidence: e.evidence === undefined ? undefined : String(e.evidence),
      origin: 'agent',
      actor: 'claude',
    })
    const after = (await read($, board)).tracks.find(t => t.name === ref.track)?.steps.find(s => s.id === ref.id)
    if (after?.status === 'done') $.ui.toast(`✓ ${ref.track}/${ref.id}`)
    if (after?.status === 'awaiting') $.ui.toast(`◆ ${ref.track}/${ref.id} awaits your confirmation`)
    return {
      result:
        after?.status === 'awaiting'
          ? `${ref.track}/${ref.id} → awaiting the person's confirmation (checkpoint or reopened after failure).`
          : `${ref.track}/${ref.id} → ${after?.status ?? status}.`,
    }
  })

  on('tool.call', { tool: TOOL_STATUS }, async $ => {
    await sync($).catch(() => undefined)
    await republish($)
    const now = await read($, board)
    const live = now.sessions.filter(s => s.isLive && s.id !== journal.me)
    const others = live.length
      ? `\nOther sessions working now:\n${live.map(s => `- ${s.title}${s.track ? ` [${s.track}]` : ''}${s.activity ? ` → ${s.activity}` : ''}`).join('\n')}`
      : ''
    return { result: summary(now, { open: 50 }) + others }
  })

  // Live status: what this session and each of its agents is doing now.
  on('tool.call', async ($, e, next) => {
    journal.activeAt = Date.now()
    const activity = describeCall(e as unknown as Record<string, unknown>)
    if (e.agentId) {
      const a = journal.agents.get(e.agentId)
      if (a) journal.agents.set(e.agentId, { activity, tools: a.tools + 1 })
    } else if (!String(e.tool).startsWith('mcp__roadmap__')) {
      journal.activity = activity
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    if (!('agentId' in ran) || !ran.agentId) return ran
    const ref = refInText(e.description ?? '', (await read($, board)).tracks, journal.track)
    if (ref) journal.track = ref.track
    journal.agents.set(ran.agentId, { tools: 0 })
    await emit($, {
      kind: 'agent',
      at: Date.now(),
      session: journal.me,
      agentId: ran.agentId,
      description: e.description || e.subagentType,
      type: e.subagentType,
      track: ref?.track,
      step: ref?.id,
    })
    return ran
  })

  on('classic.SubagentStop', async ($, e, next) => {
    const ran = await next(e)
    await endAgent($, e.agent_id, 'done')
    return ran
  })

  on('ui.close', async ($, e, next) => {
    const ran = await next(e)
    if (e.id === PANE) await update($, paneOpen, () => false)
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const tz = await read($, tzOffset)
    return drawPane(els, {
      board: await read($, board),
      view: (await read($, view)) as RoadmapView,
      expanded: await read($, expanded),
      now: Date.now(),
      tz,
      me: journal.me,
      cols: Math.max(30, e.props.bodyColumns ?? e.viewport?.columns ?? 60),
      canDraw: e.surface !== 'terminal',
      onView: next => void update($, view, () => next),
      onToggle: track =>
        void update($, expanded, list => (list.includes(track) ? list.filter(n => n !== track) : [...list, track])),
      onCopyTrack: (track, surface) =>
        void (async () => {
          const t = (await read($, board)).tracks.find(x => x.name === track)
          if (!t) return
          const done = await $.ui.copy({ text: trackMarkdown(t, Date.now(), tz), surface: surface as never })
          $.ui.toast(done.isCopied ? `⧉ ${t.title} copied` : `Could not copy: ${done.reason}`)
        })(),
      onCopyAll: surface =>
        void (async () => {
          const done = await $.ui.copy({ text: boardMarkdown(await read($, board), Date.now(), tz), surface: surface as never })
          $.ui.toast(done.isCopied ? '⧉ Roadmap copied' : `Could not copy: ${done.reason}`)
        })(),
      onDecide: (track, id, status) => void decide($, track, id, status),
      editing: await read($, editing),
      onCycle: (track, id, status) => void personStatus($, track, id, status),
      onAdd: (track, title) => void personAdd($, track, title),
      onStartEdit: ref => void update($, editing, () => ref),
      onRename: (track, id, title) => void personEdit($, track, id, { title }),
      onRemove: (track, id) => void personEdit($, track, id, { removed: true }),
      onPriority: (track, id, priority) => void personTriage($, track, id, { priority }),
      onBacklog: (track, id, backlog) => void personTriage($, track, id, { backlog }),
      onTrackPriority: (track, priority) => void personTrackTriage($, track, { priority }),
      onTrackBacklog: (track, backlog) => void personTrackTriage($, track, { backlog }),
    })
  })

  // The pane's toggle, one line above the prompt (`/roadmap band` hides it).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, showBand))) return next(e)
    const b = await read($, board)
    if (b.tracks.length === 0) return next(e)
    return drawBand($.ui.resolve(e), {
      board: b,
      isOpen: await read($, paneOpen),
      cols: e.props.bodyColumns,
      onToggle: () => void togglePane($),
    })
  })
}
