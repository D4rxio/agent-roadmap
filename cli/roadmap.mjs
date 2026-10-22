#!/usr/bin/env node
// roadmap — the shared roadmap from a terminal, for Codex, scripts and any other agent.
//
// Same journal as the Claude Code mod (~/.claude/roadmap, or $CLAUDE_ROADMAP_DIR), same rules: every
// change is a new event file, nothing is rewritten, the board is folded from all events by the mod's
// own model (hooks/model.ts; Node >= 23.6 runs it as is). Needs no server and no dependencies.
//
//   roadmap status [--all]              this project's open steps by priority (--all: every project), who works now
//   roadmap step <track>/<id>           a step's brief: why, scope, done when, waits on, unblocks
//   roadmap json                        the whole folded board as JSON, for analysis
//   roadmap md [track] [--all]          this project's roadmap (or one track) as Markdown
//   roadmap mermaid [track] [--all] [--out file.md]
//                                       what waits on what, as a Mermaid flowchart (GitHub/GitLab render it)
//   roadmap plan <track> <file|->       lay out a track from JSON {title?, phases:[{name, steps:[…]}]}
//   roadmap mark <ref> [status] [--evidence …] [--note …] [--reason …] [--to <ref>] [--priority P0-P3|none] [--backlog true|false]
//                                       status: todo running done failed blocked skipped moved
//                                       (skipped needs --reason; moved needs --to and --reason: the obligation
//                                       goes to that step, still to be done there; the person confirms)
//   roadmap done <ref> --shipped "…" [--evidence …] [--failed] [--follow-up "title[:P1]"]…
//   roadmap review <ref> --verdict pass|findings|fail [--evidence …] [--note …] [--follow-up "title[:P1]"]…
//   roadmap review <ref> --from-codex <session id | result.json | rollout.jsonl> [--follow-ups]
//                                       carry over a Codex review that could not write the roadmap itself
//                                       (claudex-loop's read-only sandbox): the verdict comes from Codex's own
//                                       session log; --follow-ups files a passed review's findings as follow-ups
//   roadmap review <ref> --start        say you are reviewing it (writes nothing; never mark a step running to review it)
//                                       record a review of a step's work, as this actor (e.g. Codex reviewing Claude's)
//
// Identity: --session / $ROADMAP_SESSION (default: one per actor, project and day), --title /
// $ROADMAP_TITLE (default "<Actor> · <project>"). The actor comes from the process tree when it can: the
// nearest Codex or Claude process above this one names it ("process"). Inside Codex's sandbox, where the
// tree cannot be read, $CODEX_SANDBOX names it "codex" ("codex-sandbox"). --actor cannot change either.
// Otherwise --actor / $ROADMAP_ACTOR (default "codex") is a declaration ("declared"): it is recorded, but
// never counts as a cross-model review. Claude records its reviews with its own tool, not here.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
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
/** A yes/no flag: `--x` or `--x true` is yes; `--x false` (or any other word) is no. */
const yes = v => v === true || String(v) === 'true'

const DIR = process.env.CLAUDE_ROADMAP_DIR || join(homedir(), '.claude', 'roadmap')
/** The nearest agent host above this process — ['codex'|'claude', 'process'] — or why it is unknown. */
function host() {
  // An absolute path, so a `ps` earlier on PATH cannot answer for the real one.
  const ps = ['/bin/ps', '/usr/bin/ps'].find(p => existsSync(p))
  if (process.platform === 'win32' || !ps) return { blocked: true }
  let pid = process.ppid
  for (let hop = 0; hop < 32 && pid > 1; hop++) {
    let line
    try {
      line = execFileSync(ps, ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return { blocked: hop === 0 }
    }
    const m = /^(\d+)\s+(.*)$/.exec(line)
    if (!m) return {}
    const name = basename(m[2]).toLowerCase()
    if (name.startsWith('codex')) return { found: 'codex' }
    if (name.startsWith('claude')) return { found: 'claude' }
    pid = Number(m[1])
  }
  return {}
}
const seen = host()
const detected = seen.found
  ? [seen.found, 'process']
  : seen.blocked && process.env.CODEX_SANDBOX && process.platform !== 'win32'
    ? ['codex', 'codex-sandbox']
    : undefined
const actor = detected ? detected[0] : String(flags.actor || process.env.ROADMAP_ACTOR || 'codex')
const via = detected ? detected[1] : 'declared'
if (detected && flags.actor && String(flags.actor) !== actor) {
  process.stderr.write(`roadmap: --actor ${flags.actor} ignored: this runs inside ${actor === 'codex' ? 'Codex' : 'Claude Code'}, so the actor is ${actor}\n`)
}
/** The project this runs in: the main repository's folder (worktrees share it), else the working folder. */
/** A folder as a project key: without trailing separators, but never emptied (`/` stays `/`, `C:\\` stays). */
function keyOf(path) {
  const t = path.replace(/[\\/]+$/, '')
  return t && !/^[A-Za-z]:$/.test(t) ? t : path
}

function detectProject() {
  try {
    const dir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (dir) return keyOf(dir.replace(/[\\/]\.git[\\/]?$/, '') || dir)
  } catch {}
  return keyOf(process.cwd())
}
const projectKey = detectProject()
const project = basename(projectKey) || projectKey
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
  const live = { session, title, at: Date.now(), activity, focus: focus ?? old?.focus, project: projectKey, agents: [] }
  writeFileSync(path, JSON.stringify(live))
}

/** Announces this session once — and again when it now works in another project than it last said. */
function sessionEvent(events, at) {
  const said = events.filter(e => e.kind === 'session' && e.session === session).sort((a, b) => a.at - b.at).pop()
  if (!said || said.project !== projectKey) {
    // At the moment of the work it comes with, not after it: the work then reads as done in this project.
    emit({ kind: 'session', at, session, title, actor, project: projectKey })
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
  const now = Date.now()
  const r = run({ events, lives, now, session, actor, via, channel: 'cli', project: projectKey, focus: old?.focus })
  if (!r.ok) fail(r.text)
  if (r.emit.length) sessionEvent(events, Math.min(now, ...r.emit.map(e => e.at)))
  for (const ev of r.emit) emit(ev)
  heartbeat(activity, r.focus)
  process.stdout.write(r.text + '\n')
}

/**
 * Codex's own log of a session, by its id, by a claudex-loop `result.json` (which names the id), or by the
 * log's path. The log is read from Codex's folder ($CODEX_HOME, else ~/.codex), where Codex's harness wrote it.
 */
function codexRollout(ref) {
  let id = ref
  const home = process.env.CODEX_HOME || join(homedir(), '.codex')
  if (ref.endsWith('.jsonl')) {
    // Only a log in Codex's own folder: that is where its harness writes them.
    const path = resolve(ref)
    if (!path.startsWith(resolve(home) + sep) || !existsSync(path)) fail(`not a Codex session log under ${home}: ${ref}`)
    return readFileSync(path, 'utf8')
  }
  if (ref.endsWith('.json')) {
    if (!existsSync(ref)) fail(`no such file: ${ref}`)
    id = parse(readFileSync(ref, 'utf8'))?.session_id
    if (typeof id !== 'string' || !id) fail(`${ref} names no Codex session (session_id)`)
  }
  if (!/^[0-9a-f-]{8,}$/i.test(id)) fail(`not a Codex session id: ${id}`)
  const found = []
  const walk = (dir, depth) => {
    if (depth > 4 || !existsSync(dir)) return
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory()) walk(join(dir, d.name), depth + 1)
      else if (d.name.startsWith('rollout-') && d.name.endsWith(`-${id}.jsonl`)) found.push(join(dir, d.name))
    }
  }
  walk(join(home, 'sessions'), 0)
  walk(join(home, 'archived_sessions'), 0)
  if (!found.length) fail(`no Codex session log for ${id} under ${home}`)
  return readFileSync(found[0], 'utf8')
}

/** `--follow-up "title[:P1]"`, repeatable: follow-ups set aside in the backlog. */
function followUps(flags) {
  return [].concat(flags['follow-up'] ?? []).map(raw => {
    const m = /^(.*?)(?::(P[0-3]))?$/.exec(String(raw))
    return { title: (m?.[1] ?? '').trim(), priority: m?.[2] }
  })
}

switch (command) {
  case 'status':
    act(ctx => actions.statusAction(ctx, { all: yes(flags.all) }), 'roadmap status')
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
    const shown = model.forProject(b, yes(flags.all) ? '*' : projectKey)
    const t = args[0] && shown.tracks.find(x => x.name === args[0])
    if (args[0] && !t) {
      const other = b.tracks.find(x => x.name === args[0])
      fail(other ? `track "${args[0]}" is in project ${shown.elsewhere?.[args[0]] ?? 'another'}; add --all to print it here` : `no track "${args[0]}"`)
    }
    process.stdout.write((t ? model.trackMarkdown(t, Date.now(), offset, shown) : model.boardMarkdown(shown, Date.now(), offset)) + '\n')
    break
  }
  case 'mermaid': {
    const { b } = board()
    const shown = model.forProject(b, yes(flags.all) ? '*' : projectKey)
    if (args[0] && !shown.tracks.some(x => x.name === args[0])) fail(`no track "${args[0]}" in this project (--all for every project)`)
    // One track: its steps, and the steps elsewhere they wait on or that wait on them.
    const g = model.chainGraph(b, yes(flags.all) ? '*' : projectKey)
    const keep = args[0] ? new Set(g.edges.filter(e => e.from.startsWith(`${args[0]}/`) || e.to.startsWith(`${args[0]}/`)).flatMap(e => [e.from, e.to])) : undefined
    const picked = keep ? { ...g, nodes: g.nodes.filter(n => keep.has(n.ref)), edges: g.edges.filter(e => keep.has(e.from) && keep.has(e.to)) } : g
    const text = model.mermaidOf(picked) + '\n'
    if (flags.out && flags.out !== 'true') {
      writeFileSync(String(flags.out), text)
      process.stdout.write(`wrote ${flags.out}\n`)
    } else process.stdout.write(text)
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
          to: flags.to,
          priority: flags.priority,
          backlog: flags.backlog,
          reopen: yes(flags.reopen),
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
          status: yes(flags.failed) ? 'failed' : 'done',
          follow_ups: followUps(flags),
        }),
      `roadmap done ${args[0] ?? ''}`,
    )
    break
  case 'review':
    if (flags['from-codex'] !== undefined) {
      const rollout = codexRollout(String(flags['from-codex']))
      act(ctx => actions.codexReviewAction(ctx, { step: args[0], rollout, followUps: yes(flags['follow-ups']) }), `roadmap review ${args[0] ?? ''} --from-codex`)
      break
    }
    act(
      ctx =>
        actions.reviewAction(ctx, {
          step: args[0],
          verdict: flags.verdict,
          evidence: flags.evidence,
          note: flags.note,
          start: yes(flags.start),
          follow_ups: followUps(flags),
        }),
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
