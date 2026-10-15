#!/usr/bin/env node
// roadmap — the shared roadmap from a terminal, for Codex, scripts and any other agent.
//
// Same journal as the Claude Code mod (~/.claude/roadmap, or $CLAUDE_ROADMAP_DIR), same rules: every
// change is a new event file, nothing is rewritten, the board is folded from all events by the mod's
// own model (hooks/model.ts; Node >= 23.6 runs it as is). Needs no server and no dependencies.
//
//   roadmap status                      open steps by priority, and who is working now
//   roadmap step <track>/<id>           a step's brief: why, scope, done when, waits on, unblocks
//   roadmap json                        the whole folded board as JSON, for analysis
//   roadmap md [track]                  the roadmap (or one track) as Markdown
//   roadmap plan <track> <file|->       lay out a track from JSON {title?, phases:[{name, steps:[…]}]}
//   roadmap mark <ref> [status] [--evidence …] [--note …] [--reason …] [--priority P0-P3|none] [--backlog true|false]
//                                       status: todo running done failed blocked skipped (skipped needs --reason)
//   roadmap done <ref> --shipped "…" [--evidence …] [--failed] [--follow-up "title[:P1]"]…
//
// Identity: --session / $ROADMAP_SESSION (default: one per actor, project and day), --actor /
// $ROADMAP_ACTOR (default "codex"), --title / $ROADMAP_TITLE (default "<Actor> · <project>").

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import * as model from '../hooks/model.ts'

const argv = process.argv.slice(2)
const flags = {}
const rest = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    const value = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
    flags[key] = key in flags ? [].concat(flags[key], value) : value
  } else rest.push(a)
}
const [command, ...args] = rest

const DIR = process.env.CLAUDE_ROADMAP_DIR || join(homedir(), '.claude', 'roadmap')
const actor = String(flags.actor || process.env.ROADMAP_ACTOR || 'codex')
const project = basename(process.cwd())
const day = new Date().toISOString().slice(0, 10)
const session = String(
  flags.session ||
    process.env.ROADMAP_SESSION ||
    `${actor}-${createHash('sha256').update(`${process.cwd()}|${day}`).digest('hex').slice(0, 12)}`,
)
const title = String(flags.title || process.env.ROADMAP_TITLE || `${actor[0].toUpperCase()}${actor.slice(1)} · ${project}`)

function fail(message) {
  process.stderr.write(`roadmap: ${message}\n`)
  process.exit(1)
}

function parse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Every event, bundles first, each counted once by its name; heartbeats of live sessions. */
function load() {
  // A bundle caught mid-write (fewer rows than its header says): wait a moment and read again.
  for (let attempt = 0; ; attempt++) {
    const got = loadOnce()
    if (got.complete || attempt >= 4) return got
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
  }
}

function loadOnce() {
  let complete = true
  const seen = new Set()
  const events = []
  const take = (name, ev) => {
    if (!ev || typeof ev.at !== 'number' || typeof ev.kind !== 'string' || seen.has(name)) return
    seen.add(name)
    events.push(ev)
  }
  const archive = join(DIR, 'archive')
  if (existsSync(archive)) {
    for (const f of readdirSync(archive).filter(x => x.endsWith('.jsonl'))) {
      let expected
      let rows = 0
      for (const line of readFileSync(join(archive, f), 'utf8').split('\n')) {
        const row = line.trim() ? parse(line) : undefined
        if (!row) continue
        if (typeof row.count === 'number' && row.n === undefined) {
          expected = row.count
          continue
        }
        rows++
        if (row.n) take(row.n, row.e)
      }
      if (expected !== undefined && rows < expected) complete = false
    }
  }
  const loose = join(DIR, 'events')
  if (existsSync(loose)) {
    for (const f of readdirSync(loose).filter(x => x.endsWith('.json'))) take(f, parse(readFileSync(join(loose, f), 'utf8')))
  }
  const lives = []
  const liveDir = join(DIR, 'live')
  if (existsSync(liveDir)) {
    for (const f of readdirSync(liveDir).filter(x => x.endsWith('.json'))) {
      const live = parse(readFileSync(join(liveDir, f), 'utf8'))
      if (live && typeof live.at === 'number') lives.push(live)
    }
  }
  return { events, lives, complete }
}

function emit(ev) {
  mkdirSync(join(DIR, 'events'), { recursive: true })
  const name = `${ev.at}-${session.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}.json`
  writeFileSync(join(DIR, 'events', name), JSON.stringify(ev))
}

/** This session's heartbeat: the Claude pane shows it under "Working now" for 20 s after each call. */
function heartbeat(activity, focus) {
  mkdirSync(join(DIR, 'live'), { recursive: true })
  const path = join(DIR, 'live', `${session}.json`)
  const old = existsSync(path) ? parse(readFileSync(path, 'utf8')) : undefined
  const live = { session, title, at: Date.now(), activity, focus: focus ?? old?.focus, agents: [] }
  writeFileSync(path, JSON.stringify(live))
}

function sessionEvent(events) {
  if (!events.some(e => e.kind === 'session' && e.session === session)) {
    emit({ kind: 'session', at: Date.now(), session, title, actor })
  }
}

function board() {
  const { events, lives } = load()
  return { events, lives, b: model.fold(events, lives, Date.now()) }
}

function resolve(b, text) {
  const ref = model.parseRef(String(text ?? ''), b.tracks)
  const t = ref && b.tracks.find(x => x.name === ref.track)
  if (!ref || !t?.steps.some(s => s.id === ref.id)) fail(`no step "${text}". Known:\n${model.summary(b, { open: 50 })}`)
  return ref
}

const offset = -new Date().getTimezoneOffset()

switch (command) {
  case 'status': {
    const { b } = board()
    const others = b.sessions.filter(s => s.isLive && s.id !== session)
    process.stdout.write(model.summary(b, { open: 50 }) + '\n')
    if (others.length) {
      process.stdout.write('\nWorking now:\n')
      for (const s of others) {
        process.stdout.write(`- ${s.title}${s.focus ? ` [holds ${s.focus}]` : ''}${s.activity ? ` → ${s.activity}` : ''}\n`)
      }
    }
    heartbeat('roadmap status')
    break
  }
  case 'step': {
    const { b } = board()
    const ref = resolve(b, args[0])
    process.stdout.write(model.brief(b, ref.track, ref.id, session) + '\n')
    heartbeat(`roadmap step ${ref.track}/${ref.id}`)
    break
  }
  case 'json': {
    const { b } = board()
    process.stdout.write(JSON.stringify(b, null, 2) + '\n')
    break
  }
  case 'md': {
    const { b } = board()
    const t = args[0] && b.tracks.find(x => x.name === args[0])
    if (args[0] && !t) fail(`no track "${args[0]}"`)
    process.stdout.write((t ? model.trackMarkdown(t, Date.now(), offset) : model.boardMarkdown(b, Date.now(), offset)) + '\n')
    break
  }
  case 'plan': {
    const track = model.slug(String(args[0] ?? ''))
    if (!track || !args[1]) fail('usage: roadmap plan <track> <file.json|->')
    const input = parse(readFileSync(args[1] === '-' ? 0 : args[1], 'utf8'))
    if (!input || !Array.isArray(input.phases)) fail('the plan JSON needs "phases": [{ "name", "steps": [{ "id", "title", … }] }]')
    const ids = new Set()
    const text = v => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
    const phases = input.phases.map(p => ({
      name: String(p.name ?? ''),
      steps: (Array.isArray(p.steps) ? p.steps : [])
        .map(s => ({
          id: String(s.id ?? '').trim(),
          title: String(s.title ?? s.id ?? ''),
          checkpoint: s.checkpoint === true ? true : undefined,
          blockedBy: Array.isArray(s.blocked_by ?? s.blockedBy) ? (s.blocked_by ?? s.blockedBy).map(String) : undefined,
          why: text(s.why),
          scope: text(s.scope),
          doneWhen: text(s.done_when ?? s.doneWhen),
        }))
        .filter(s => s.id && !ids.has(s.id) && ids.add(s.id)),
    }))
    const { events, lives } = load()
    const planned = { kind: 'plan', at: Date.now(), session, track, title: text(input.title), phases, actor }
    const would = model.fold([...events, planned], lives, Date.now())
    const loop = model.findCycle(would.tracks)
    if (loop) fail(`not laid out: blocked_by closes a loop, so none of these could ever start: ${loop.join(' → ')}`)
    sessionEvent(events)
    emit(planned)
    heartbeat(`roadmap plan ${track}`)
    process.stdout.write(`Track "${track}" laid out: ${phases.length} phases, ${ids.size} steps.\n`)
    break
  }
  case 'mark': {
    const { events, b } = board()
    const whole = /^#?([\w.-]+)\/\*$/.exec(String(args[0] ?? ''))
    const priority = flags.priority === 'none' ? null : model.PRIORITIES.includes(flags.priority) ? flags.priority : undefined
    const backlog = flags.backlog === undefined ? undefined : flags.backlog === 'true'
    sessionEvent(events)
    if (whole) {
      const track = model.slug(whole[1])
      if (!b.tracks.some(t => t.name === track)) fail(`no track "${track}"`)
      if (priority === undefined && backlog === undefined) fail('a whole track takes --priority or --backlog')
      emit({ kind: 'triage', at: Date.now(), session, track, priority, backlog, origin: 'agent' })
      process.stdout.write(`${track}: triage recorded (the person's own choice stands over it).\n`)
      break
    }
    const ref = resolve(b, args[0])
    const status = args[1]
    if (status !== undefined && (!model.STATUSES.includes(status) || status === 'awaiting')) {
      fail('status is one of todo, running, done, failed, blocked, skipped')
    }
    if (status === 'skipped' && !(typeof flags.reason === 'string' && flags.reason.trim())) {
      fail('a skip needs --reason "why this step will not be done"')
    }
    if (status === undefined && priority === undefined && backlog === undefined) fail('give a status, --priority or --backlog')
    if (priority !== undefined || backlog !== undefined) {
      emit({ kind: 'triage', at: Date.now(), session, track: ref.track, id: ref.id, priority, backlog, origin: 'agent' })
    }
    if (status) {
      emit({
        kind: 'step',
        at: Date.now() + 1,
        session,
        track: ref.track,
        id: ref.id,
        status,
        evidence: flags.evidence,
        note: flags.note,
        reason: typeof flags.reason === 'string' ? flags.reason.trim() : undefined,
        origin: 'agent',
        actor,
      })
    }
    const after = board().b.tracks.find(t => t.name === ref.track)?.steps.find(s => s.id === ref.id)
    heartbeat(`roadmap mark ${ref.track}/${ref.id}`, status === 'running' ? `${ref.track}/${ref.id}` : undefined)
    process.stdout.write(
      `${ref.track}/${ref.id} → ${after?.status === 'awaiting' && after.proposed === 'skipped' ? 'skip proposed' : after?.status}${after?.status === 'awaiting' ? ' (waits for the person to confirm)' : ''}` +
        `${after?.priority ? ` · ${after.priority}` : ''}${after?.backlog ? ' · in backlog' : ''}\n`,
    )
    break
  }
  case 'done': {
    const { events, b } = board()
    const ref = resolve(b, args[0])
    const shipped = String(flags.shipped ?? '').trim()
    if (!shipped) fail('--shipped "what was delivered" is required')
    sessionEvent(events)
    emit({
      kind: 'step',
      at: Date.now(),
      session,
      track: ref.track,
      id: ref.id,
      status: flags.failed ? 'failed' : 'done',
      note: shipped,
      evidence: flags.evidence,
      origin: 'agent',
      actor,
    })
    const added = []
    for (const raw of [].concat(flags['follow-up'] ?? [])) {
      const m = /^(.*?)(?::(P[0-3]))?$/.exec(String(raw))
      const name = (m?.[1] ?? '').trim()
      if (!name) continue
      const { events: now } = load()
      const track = model.fold(now, [], Date.now()).tracks.find(t => t.name === ref.track)
      const id = model.nextId(track, now, 'f')
      const at = Date.now()
      emit({ kind: 'add', at, session, track: ref.track, id, title: name, phase: model.FOLLOW_UPS, origin: 'agent' })
      emit({ kind: 'triage', at: at + 1, session, track: ref.track, id, backlog: true, priority: m?.[2], origin: 'agent' })
      added.push(`${ref.track}/${id} ${name}`)
    }
    const after = board().b.tracks.find(t => t.name === ref.track)?.steps.find(s => s.id === ref.id)
    heartbeat(`roadmap done ${ref.track}/${ref.id}`, `${ref.track}/${ref.id}`)
    process.stdout.write(`${ref.track}/${ref.id} → ${after?.status}${after?.status === 'awaiting' ? ' (waits for the person to confirm)' : ''}\n`)
    if (added.length) process.stdout.write(`Follow-ups set aside in the backlog:\n${added.map(x => `- ${x}`).join('\n')}\n`)
    break
  }
  default:
    process.stdout.write(
      readFileSync(new URL(import.meta.url), 'utf8')
        .split('\n')
        .filter(l => l.startsWith('//'))
        .map(l => l.replace(/^\/\/ ?/, ''))
        .join('\n') + '\n',
    )
    if (command && command !== 'help') process.exit(1)
}
