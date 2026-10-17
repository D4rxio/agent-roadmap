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
//   roadmap review <ref> --verdict pass|findings|fail [--evidence …] [--note …]
//                                       record a review of a step's work, as this actor (e.g. Codex reviewing Claude's)
//
// Identity: --session / $ROADMAP_SESSION (default: one per actor, project and day), --actor /
// $ROADMAP_ACTOR (default "codex"), --title / $ROADMAP_TITLE (default "<Actor> · <project>").

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import * as model from '../hooks/model.ts'
import * as actions from '../hooks/actions.ts'

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


const offset = -new Date().getTimezoneOffset()

/** Runs a shared action (hooks/actions.ts, the same the Claude tools run) and writes what it returns. */
function act(run, activity) {
  const { events, lives } = load()
  const old = existsSync(join(DIR, 'live', `${session}.json`)) ? parse(readFileSync(join(DIR, 'live', `${session}.json`), 'utf8')) : undefined
  const r = run({ events, lives, now: Date.now(), session, actor, focus: old?.focus })
  if (!r.ok) fail(r.text)
  if (r.emit.length) sessionEvent(events)
  for (const ev of r.emit) emit(ev)
  heartbeat(activity, r.focus)
  process.stdout.write(r.text + '\n')
}

switch (command) {
  case 'status':
    act(ctx => actions.statusAction(ctx), 'roadmap status')
    break
  case 'step':
    act(ctx => actions.stepAction(ctx, { step: args[0] }), `roadmap step ${args[0] ?? ''}`)
    break
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
    if (!args[0] || !args[1]) fail('usage: roadmap plan <track> <file.json|->')
    const input = parse(readFileSync(args[1] === '-' ? 0 : args[1], 'utf8'))
    if (!input || !Array.isArray(input.phases)) fail('the plan JSON needs "phases": [{ "name", "steps": [{ "id", "title", … }] }]')
    act(ctx => actions.planAction(ctx, { ...input, track: args[0] }), `roadmap plan ${args[0]}`)
    break
  }
  case 'mark':
    act(
      ctx =>
        actions.markAction(ctx, {
          step: args[0],
          status: args[1],
          evidence: flags.evidence,
          note: flags.note,
          reason: flags.reason,
          priority: flags.priority,
          backlog: flags.backlog,
        }),
      `roadmap mark ${args[0] ?? ''}`,
    )
    break
  case 'done':
    act(
      ctx =>
        actions.doneAction(ctx, {
          step: args[0],
          shipped: flags.shipped,
          evidence: flags.evidence,
          status: flags.failed ? 'failed' : 'done',
          follow_ups: [].concat(flags['follow-up'] ?? []).map(raw => {
            const m = /^(.*?)(?::(P[0-3]))?$/.exec(String(raw))
            return { title: (m?.[1] ?? '').trim(), priority: m?.[2] }
          }),
        }),
      `roadmap done ${args[0] ?? ''}`,
    )
    break
  case 'review':
    act(
      ctx => actions.reviewAction(ctx, { step: args[0], verdict: flags.verdict, evidence: flags.evidence, note: flags.note }),
      `roadmap review ${args[0] ?? ''}`,
    )
    break
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
