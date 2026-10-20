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
  STATUSES,
  describeCall,
  fold,
  forProject,
  progress,
  trackDone,
  refInText,
  summary,
  boardMarkdown,
  nextPersonId,
  trackMarkdown,
} from './model'
import { checkMove, doneAction, markAction, planAction, reviewAction, statusAction, stepAction } from './actions'
import type { ActionContext, ActionResult } from './actions'
import { drawBand, drawChainsPane, drawPane } from './view'
import type { PaneData } from './view'
import type { RoadmapView } from './view'

const PANE = 'roadmap'
const CHAINS = 'roadmap-chains'
const TOOL_PLAN = 'mcp__roadmap__plan'
const TOOL_MARK = 'mcp__roadmap__mark'
const TOOL_STATUS = 'mcp__roadmap__status'
const TOOL_STEP = 'mcp__roadmap__step'
const TOOL_DONE = 'mcp__roadmap__done'
const TOOL_REVIEW = 'mcp__roadmap__review'
const EMPTY: RoadmapBoard = { tracks: [], sessions: [], agents: [], projects: [], at: 0 }

const board = atom({ plugin: 'roadmap', key: 'board' } as const, EMPTY)
const view = atom({ plugin: 'roadmap', key: 'view' } as const, 'tracks')
const expanded = atom({ plugin: 'roadmap', key: 'expanded' } as const, [])
const paneOpen = atom({ plugin: 'roadmap', key: 'paneOpen' } as const, false)
const showBand = atom({ plugin: 'roadmap', key: 'band' } as const, true)
const tzOffset = atom({ plugin: 'roadmap', key: 'tz' } as const, 0)
const editing = atom({ plugin: 'roadmap', key: 'editing' } as const, '')
const focus = atom({ plugin: 'roadmap', key: 'focus' } as const, '')
const phaseOpen = atom({ plugin: 'roadmap', key: 'phaseOpen' } as const, {} as Record<string, boolean>)
const outdated = atom({ plugin: 'roadmap', key: 'outdated' } as const, false)
/** Which project the pane shows: '' this chat's own, '*' every project, or a project's key. */
const projectView = atom({ plugin: 'roadmap', key: 'project' } as const, '')
const chainTrack = atom({ plugin: 'roadmap', key: 'chainTrack' } as const, '')
const chainDone = atom({ plugin: 'roadmap', key: 'chainDone' } as const, false)
const search = atom({ plugin: 'roadmap', key: 'search' } as const, '')

/**
 * The project a folder belongs to: its main repository's folder, found through git's common dir so every
 * worktree of one repository is one project. Outside git, the folder itself.
 */
async function detectProject($: EngineInterface, cwd: string): Promise<string> {
  const git = await $.process
    .run(['git', '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    .catch(() => undefined)
  const dir = git?.exitCode === 0 ? git.stdout.trim() : ''
  const root = dir ? dir.replace(/[\\/]\.git[\\/]?$/, '') || dir : cwd
  // Without trailing separators, but never emptied: `/` stays `/`, `C:\\` stays `C:\\`.
  const key = root.replace(/[\\/]+$/, '')
  return key && !/^[A-Za-z]:$/.test(key) ? key : root
}

/**
 * The code this chat loaded. A chat keeps the plugin it started with, so after an update on disk it runs
 * old code until it restarts; comparing what is on disk now with what was there at start says so. Each
 * tick lists the hooks folder (cheap); only a changed name, size or time costs a hash of the contents, so
 * a file merely touched does not count as an update.
 */
const code = { sig: '', hash: '' }

async function codeOnDisk($: EngineInterface): Promise<{ sig: string; files: string[] }> {
  const dir = `${$.plugin.root}/hooks`
  const files = (await $.fs.list(dir))
    .filter(x => x.kind === 'file' && /\.(ts|tsx)$/.test(x.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { sig: files.map(f => `${f.name}:${f.size}:${f.mtimeMs}`).join('|'), files: files.map(f => `${dir}/${f.name}`) }
}

async function codeHash($: EngineInterface, files: string[]): Promise<string> {
  // FNV-1a over each file's name and text: a fingerprint, not a security check.
  let h = 0x811c9dc5
  for (const path of files) {
    const text = `${path}\0${await $.fs.read(path)}`
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
  }
  return (h >>> 0).toString(16)
}

// State keys newer than a running chat's state contract (fixed when the chat started; a module reloaded
// in it can name keys it does not know) are read with a fallback instead of failing the whole render.
async function readProjectView($: EngineInterface): Promise<string> {
  try {
    return (await read($, projectView)) ?? ''
  } catch {
    return ''
  }
}

async function readFocus($: EngineInterface): Promise<string> {
  try {
    return (await read($, focus)) ?? ''
  } catch {
    return journal.focus ?? ''
  }
}

async function readPhaseOpen($: EngineInterface): Promise<Record<string, boolean>> {
  try {
    return (await read($, phaseOpen)) ?? {}
  } catch {
    return {}
  }
}

async function readEditing($: EngineInterface): Promise<string> {
  try {
    return (await read($, editing)) ?? ''
  } catch {
    return ''
  }
}

async function readChainTrack($: EngineInterface): Promise<string> {
  try {
    return (await read($, chainTrack)) ?? ''
  } catch {
    return ''
  }
}

async function readChainDone($: EngineInterface): Promise<boolean> {
  try {
    return (await read($, chainDone)) === true
  } catch {
    return false
  }
}

async function readSearch($: EngineInterface): Promise<string> {
  try {
    return (await read($, search)) ?? ''
  } catch {
    return ''
  }
}

async function readOutdated($: EngineInterface): Promise<boolean> {
  try {
    return (await read($, outdated)) === true
  } catch {
    return false
  }
}

async function noteCode($: EngineInterface) {
  const now = await codeOnDisk($)
  code.sig = now.sig
  code.hash = await codeHash($, now.files)
}

async function checkCode($: EngineInterface) {
  if (!code.hash) return
  const now = await codeOnDisk($)
  if (now.sig === code.sig) return
  code.sig = now.sig
  const changed = (await codeHash($, now.files)) !== code.hash
  if (changed !== (await readOutdated($))) await update($, outdated, () => changed).catch(() => undefined)
}

// The module's own memory of the shared journal; a reload re-reads it from disk.
const journal = {
  dir: '',
  me: '',
  title: '',
  track: undefined as string | undefined,
  /** The item this chat holds, `<track>/<id>`, shared through the heartbeat. */
  focus: undefined as string | undefined,
  activity: undefined as string | undefined,
  activeAt: 0,
  /** Whether the engine draws styled content inside a Button: 2.1.295 on. Older ones take a plain label. */
  richButtons: false,
  /** Whether Codex is installed beside Claude: a step that needs a cross-model review can use it. */
  codexInstalled: false,
  /** The project this chat works in (its main repository's folder). */
  project: undefined as string | undefined,
  isOpened: false,
  /** Every event read, by its name (a loose file's name, or the name it had before it was archived). */
  seen: new Set<string>(),
  events: [] as RoadmapEvent[],
  /** Loose files present in `events/` at the last look, name → event: what compaction may archive. */
  loose: new Map<string, RoadmapEvent>(),
  bundles: new Set<string>(),
  lastFold: 0,
  /** What our own heartbeat last said, to tell a real change from a rewrite. */
  lastLive: '',
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

/** `a` is at least `b`, comparing dotted release numbers (`2.1.295`); a dev suffix is ignored. */
export function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split(/[^0-9.]/)[0]?.split('.').map(Number) ?? []
  const pb = b.split('.').map(Number)
  for (let i = 0; i < pb.length; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return true
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
  journal.lastFold = Date.now()
  const next = fold(journal.events, [...journal.lives.values()].map(l => l.live), Date.now())
  await update($, board, () => next)
  const live = next.sessions.filter(s => s.isLive).length
  const running = next.agents.filter(a => a.status === 'running').length
  const tracks = next.tracks.filter(t => !t.backlog && !t.archived).map(t => {
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

/** Archive bundles: written once by a compaction, never changed after, read once per session. */
const ARCHIVE = 'archive'
/** Loose events older than this, when there are more than COMPACT_MIN of them, go into a bundle. */
const COMPACT_AGE_MS = 24 * 3_600_000
const COMPACT_MIN = 200
/** A heartbeat file this old belongs to a session that is long gone. */
const LIVE_PRUNE_MS = 7 * 86_400_000

function atOf(name: string): number {
  return Number(name.slice(0, name.indexOf('-'))) || 0
}

function take(name: string, ev: RoadmapEvent | undefined): boolean {
  if (!ev || typeof ev.at !== 'number' || typeof ev.kind !== 'string' || journal.seen.has(name)) return false
  journal.seen.add(name)
  journal.events.push(ev)
  return true
}

/** Reads what other sessions wrote since the last look; says whether anything changed. */
async function sync($: EngineInterface): Promise<boolean> {
  let changed = false
  const archiveDir = `${journal.dir}/${ARCHIVE}`
  if (await $.fs.exists(archiveDir)) {
    for (const entry of await $.fs.list(archiveDir)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl') || journal.bundles.has(entry.name)) continue
      // A bundle read while it is still being written is taken in part and read again next time,
      // until its header's count is met: a partial read never marks it done.
      let expected: number | undefined
      let rows = 0
      for (const line of (await $.fs.read(`${archiveDir}/${entry.name}`)).split('\n')) {
        const row = line.trim() ? parse<{ n?: string; e?: RoadmapEvent; count?: number }>(line) : undefined
        if (!row) continue
        if (typeof row.count === 'number' && row.n === undefined) {
          expected = row.count
          continue
        }
        rows++
        if (row.n && take(row.n, row.e)) changed = true
      }
      if (expected === undefined || rows >= expected) journal.bundles.add(entry.name)
    }
  }
  const eventsDir = `${journal.dir}/events`
  if (await $.fs.exists(eventsDir)) {
    const present = new Set<string>()
    for (const entry of await $.fs.list(eventsDir)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      present.add(entry.name)
      if (journal.loose.has(entry.name)) continue
      // Already read from a bundle (a compaction is deleting it right now): not loose any more.
      if (journal.seen.has(entry.name)) continue
      const ev = parse<RoadmapEvent>(await $.fs.read(`${eventsDir}/${entry.name}`))
      if (take(entry.name, ev) && ev) {
        journal.loose.set(entry.name, ev)
        changed = true
      }
    }
    for (const name of [...journal.loose.keys()]) if (!present.has(name)) journal.loose.delete(name)
  }
  const liveDir = `${journal.dir}/live`
  if (await $.fs.exists(liveDir)) {
    for (const entry of await $.fs.list(liveDir)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      // Our own heartbeat is already in memory: rereading it would count as a change every tick.
      if (entry.name === `${journal.me}.json`) continue
      if (journal.lives.get(entry.name)?.mtimeMs === entry.mtimeMs) continue
      const live = parse<RoadmapLive>(await $.fs.read(`${liveDir}/${entry.name}`))
      if (live && typeof live.at === 'number') {
        journal.lives.set(entry.name, { mtimeMs: entry.mtimeMs, live })
        changed = true
      }
    }
  }
  return changed
}

/** Deletes files by path, a batch at a time: `rm` where there is one, `del` on Windows. */
/**
 * A small diagnostics log per chat, `<journal>/diag/<session>.log`: loads, render failures and timeouts,
 * slow renders, and a per-minute count of renders. The engine reports a refused or failed pane only to
 * its debug log, which is off in the desktop app; this keeps the last few hundred lines where we can read
 * them. Local only, like the journal.
 */
const diag = { lines: [] as string[], dirty: false, renders: 0, slowest: 0, since: Date.now() }

function note(line: string) {
  diag.lines.push(`${new Date().toISOString()} ${line}`)
  if (diag.lines.length > 300) diag.lines.splice(0, diag.lines.length - 300)
  diag.dirty = true
}

async function flushDiag($: EngineInterface) {
  if (!diag.dirty || !journal.dir || !journal.me) return
  diag.dirty = false
  await $.fs.write(`${journal.dir}/diag/${journal.me}.log`, diag.lines.join('\n') + '\n').catch(() => undefined)
}

/** Counts a render and how long it took; a slow or failed one gets a line of its own. */
function rendered(what: string, ms: number, error?: unknown) {
  diag.renders++
  diag.slowest = Math.max(diag.slowest, ms)
  if (error !== undefined) note(`${what} render failed after ${ms} ms: ${error instanceof Error ? error.message : String(error)}`)
  else if (ms > 500) note(`${what} render slow: ${ms} ms`)
  const now = Date.now()
  if (now - diag.since >= 60_000) {
    note(`renders in the last ${Math.round((now - diag.since) / 1000)} s: ${diag.renders}, slowest ${diag.slowest} ms; events ${journal.events.length}`)
    diag.renders = 0
    diag.slowest = 0
    diag.since = now
  }
}

async function remove($: EngineInterface, paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += 200) {
    const batch = paths.slice(i, i + 200)
    const out = await $.process.run(['rm', '-f', '--', ...batch]).catch(() => undefined)
    if (out?.exitCode === 0) continue
    await $.process.run(['cmd', '/c', 'del', '/q', ...batch.map(x => x.replace(/\//g, '\\'))]).catch(() => undefined)
  }
}

/**
 * Moves old loose events into one new archive bundle, then deletes them. The bundle is written, read
 * back and counted before anything is deleted; events keep their names, so a reader that sees one in
 * both places, or two sessions compacting at once, still counts it once.
 */
async function compact($: EngineInterface): Promise<void> {
  const cutoff = Date.now() - COMPACT_AGE_MS
  const old = [...journal.loose].filter(([name]) => atOf(name) < cutoff).sort((a, b) => atOf(a[0]) - atOf(b[0]))
  if (old.length < COMPACT_MIN) return
  const archiveDir = `${journal.dir}/${ARCHIVE}`
  // Another session compacted a moment ago: leave it to that one.
  if (await $.fs.exists(archiveDir)) {
    const recent = (await $.fs.list(archiveDir)).some(x => Date.now() - x.mtimeMs < 10 * 60_000)
    if (recent) return
  }
  const name = `${atOf(old[0]?.[0] ?? '')}-${journal.me.slice(0, 8)}-${rand()}.jsonl`
  const path = `${archiveDir}/${name}`
  const header = JSON.stringify({ bundle: 1, count: old.length })
  await $.fs.write(path, [header, ...old.map(([n, e]) => JSON.stringify({ n, e }))].join('\n') + '\n')
  const back = (await $.fs.read(path)).split('\n').filter(line => line.trim() && parse(line)).length
  if (back !== old.length + 1) return
  journal.bundles.add(name)
  await remove($, old.map(([n]) => `${journal.dir}/events/${n}`))
  for (const [n] of old) journal.loose.delete(n)
  // Heartbeats of sessions gone for a week say nothing any more.
  const liveDir = `${journal.dir}/live`
  if (await $.fs.exists(liveDir)) {
    const stale = (await $.fs.list(liveDir)).filter(x => x.kind === 'file' && Date.now() - x.mtimeMs > LIVE_PRUNE_MS)
    if (stale.length) {
      await remove($, stale.map(x => `${liveDir}/${x.name}`))
      for (const x of stale) journal.lives.delete(x.name)
    }
  }
}

/** Adds one event to the shared journal: a file of its own, so no session overwrites another. */
async function emit($: EngineInterface, ev: RoadmapEvent) {
  const name = `${ev.at}-${journal.me.slice(0, 8)}-${rand()}.json`
  journal.seen.add(name)
  journal.events.push(ev)
  journal.loose.set(name, ev)
  await $.fs.write(`${journal.dir}/events/${name}`, JSON.stringify(ev))
  await republish($)
}

/** This session's live file: what it and its agents do right now. */
async function heartbeat($: EngineInterface, force = false): Promise<boolean> {
  const now = Date.now()
  const busy = now - journal.activeAt < LIVE_MS || journal.agents.size > 0
  if (!busy && !force) return false
  const live: RoadmapLive = {
    session: journal.me,
    title: journal.title,
    track: journal.track,
    activity: journal.activity,
    focus: journal.focus,
    project: journal.project,
    at: force && !busy ? now - LIVE_MS : now,
    agents: [...journal.agents].map(([agentId, a]) => ({ agentId, ...a })),
  }
  await $.fs.write(`${journal.dir}/live/${journal.me}.json`, JSON.stringify(live))
  journal.lives.set(`${journal.me}.json`, { mtimeMs: now, live })
  const said = JSON.stringify([live.title, live.track, live.activity, live.agents])
  const isNew = said !== journal.lastLive
  journal.lastLive = said
  return isNew
}

async function endAgent($: EngineInterface, agentId: string, status: RoadmapStatus) {
  const known = (await read($, board)).agents.find(a => a.id === agentId)
  journal.agents.delete(agentId)
  if (!known || known.status !== 'running') return
  await emit($, { kind: 'agent-end', at: Date.now(), session: journal.me, agentId, status })
  $.ui.toast(`${status === 'done' ? '✓' : '✗'} ${known.description}`)
}

/** The person's own word on a step, from a pane button: the one origin that closes a checkpoint. */
/** Everything a pane of this plugin draws from: the main pane, and the wide Chains pane. */
async function paneData($: EngineInterface, e: any): Promise<PaneData> {
  const tz = await read($, tzOffset)
  // The pane shows one project: this chat's own unless the person picked another, or All.
  const picked = await readProjectView($)
  const shown = picked || journal.project || '*'
  return {
    board: forProject(await read($, board), shown),
    whole: await read($, board),
    chainTrack: await readChainTrack($),
    chatTrack: journal.track,
    onChainTrack: (t: string) => void update($, chainTrack, () => t).catch(() => undefined),
    chainDone: await readChainDone($),
    onChainDone: (show: boolean) => void update($, chainDone, () => show).catch(() => undefined),
    search: await readSearch($),
    onSearch: (q: string) => void update($, search, () => q).catch(() => undefined),
    project: shown,
    here: journal.project,
    onProjectView: (p: string) => void update($, projectView, () => p).catch(() => undefined),
    onPlace: (track: string, p: string | null) => void personPlace($, track, p),
    outdated: await readOutdated($),
    richButtons: journal.richButtons,
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
    phaseOpen: await readPhaseOpen($),
    onTogglePhase: (key, open) => void update($, phaseOpen, map => ({ ...map, [key]: open })).catch(() => undefined),
    onCopyTrack: (track, surface) =>
      void (async () => {
        const t = (await read($, board)).tracks.find(x => x.name === track)
        if (!t) return
        const done = await $.ui.copy({ text: trackMarkdown(t, Date.now(), tz, await read($, board)), surface: surface as never })
        $.ui.toast(done.isCopied ? `⧉ ${t.title} copied` : `Could not copy: ${done.reason}`)
      })(),
    onCopyAll: surface =>
      void (async () => {
        const done = await $.ui.copy({ text: boardMarkdown(forProject(await read($, board), shown), Date.now(), tz), surface: surface as never })
        $.ui.toast(done.isCopied ? '⧉ Roadmap copied' : `Could not copy: ${done.reason}`)
      })(),
    onCopyText: (text, surface) =>
      void (async () => {
        const done = await $.ui.copy({ text, surface: surface as never })
        $.ui.toast(done.isCopied ? `⧉ ${text.length > 60 ? `${text.slice(0, 59)}…` : text}` : `Could not copy: ${done.reason}`)
      })(),
    onDecide: (track, id, status) => void decide($, track, id, status),
    editing: await readEditing($),
    focus: await readFocus($),
    onPin: ref => void setFocus($, ref),
    onSkip: (track, id, reason) => void personSkip($, track, id, reason),
    onMove: (track, id, to, reason) => void personMove($, track, id, to, reason),
    onCycle: (track, id, status) => void personStatus($, track, id, status),
    onAdd: (track, title) => void personAdd($, track, title),
    onStartEdit: ref => void update($, editing, () => ref).catch(() => undefined),
    onRename: (track, id, title) => void personEdit($, track, id, { title }),
    onRemove: (track, id) => void personEdit($, track, id, { removed: true }),
    onPriority: (track, id, priority) => void personTriage($, track, id, { priority }),
    onBacklog: (track, id, backlog) => void personTriage($, track, id, { backlog }),
    onTrackPriority: (track, priority) => void personTrackTriage($, track, { priority }),
    onTrackBacklog: (track, backlog) => void personTrackTriage($, track, { backlog }),
    onTrackRank: (track: string, rank: number) => void personTrackTriage($, track, { rank }),
    onArchive: (track, archived, done) => void personArchive($, track, archived, done),
    onTrackDone: (track: string) => void personArchive($, track, true, true),
    onWide: () => void openChains($),
  }
}

/**
 * The pane's data, or a failure after three seconds: a read that never comes back (a module reloaded mid-
 * way, a stuck journal read) then draws its reason instead of leaving the pane blank. If the engine has
 * no clock to wait on, it simply waits for the data.
 */
export async function inTime<T>(sleep: (ms: number) => Promise<void>, work: Promise<T>): Promise<T> {
  const late = sleep(3000).then(
    () => {
      throw new Error('its data did not come in time (a reload may have left it waiting)')
    },
    () => new Promise<never>(() => undefined),
  )
  return Promise.race([work, late])
}

function cannotDraw(els: any, err: unknown) {
  const { Box, Text } = els
  return (
    <Box flexDirection="column">
      <Text color="warning" wrap="wrap">{`The roadmap could not draw this pane: ${err instanceof Error ? err.message : String(err)}`}</Text>
      <Text dimColor wrap="wrap">Run /reload-plugins, or restart this chat, to load the plugin cleanly; other chats are not affected.</Text>
    </Box>
  )
}

/** Opens the Chains diagram in a pane of its own, as wide as the dock allows; Escape closes it. */
async function openChains($: EngineInterface) {
  await $.ui.open({ id: CHAINS, title: 'Chains', focus: true, closeOnEscape: true, columns: 200, rows: 40 })
}

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

async function personTrackTriage($: EngineInterface, track: string, change: { priority?: RoadmapPriority | null; backlog?: boolean; rank?: number }) {
  await emit($, { kind: 'triage', at: Date.now(), session: journal.me, track, ...change, origin: 'person' })
  if (change.backlog !== undefined) $.ui.toast(change.backlog ? `${track} moved to backlog` : `↺ ${track} restored`)
}

/** The person archives a track or brings it back: their decision alone, so only the pane writes it. */
/** The person places a track in a project (a key), or in none (null): their word, as with archiving. */
async function personPlace($: EngineInterface, track: string, project: string | null) {
  await emit($, { kind: 'triage', at: Date.now(), session: journal.me, track, project, origin: 'person' })
  const name = project ? (await read($, board)).projects.find(p => p.key === project)?.name ?? project : 'no project'
  $.ui.toast(`⌂ ${track} → ${name}`)
}

/**
 * The person puts a track away or brings it back. `done` closes it as done whatever its steps say (true),
 * or takes that word back (false: abandoning, reopening); absent, the steps decide.
 */
async function personArchive($: EngineInterface, track: string, archived: boolean, done?: boolean) {
  await emit($, { kind: 'triage', at: Date.now(), session: journal.me, track, archived, ...(done === undefined ? {} : { done }), origin: 'person' })
  const t = (await read($, board)).tracks.find(x => x.name === track)
  const finished = done === true || (done === undefined && !!t && trackDone(t))
  $.ui.toast(
    archived
      ? finished
        ? `✓ ${track} done — in the Done tab`
        : `${track} abandoned — in the Done tab, under Abandoned`
      : `↺ ${track} back on the list`,
  )
}

async function personStatus($: EngineInterface, track: string, id: string, status: RoadmapStatus) {
  await emit($, { kind: 'step', at: Date.now(), session: journal.me, track, id, status, origin: 'person', actor: 'person' })
}

/** This chat takes hold of an item: shown at the top of its pane, its track opened, others see who holds it. */
async function setFocus($: EngineInterface, ref: string) {
  if (journal.focus === ref) return
  journal.focus = ref || undefined
  journal.track = ref ? ref.split('/')[0] : journal.track
  journal.activeAt = Date.now()
  await update($, focus, () => ref).catch(() => undefined)
  const track = ref.split('/')[0]
  if (track) await update($, expanded, list => (list.includes(track) ? list : [...list, track]))
  await heartbeat($)
}

async function decide($: EngineInterface, track: string, id: string, status: RoadmapStatus) {
  await emit($, { kind: 'step', at: Date.now(), session: journal.me, track, id, status, origin: 'person', actor: 'person' })
  $.ui.toast(`${status === 'done' ? '✓' : '✗'} ${track}/${id} ${status === 'done' ? 'confirmed' : status === 'todo' ? 'back to work' : 'rejected'}`)
}

/** The person skips a step (or confirms a worker's proposed skip): a decision with its reason. */
async function personSkip($: EngineInterface, track: string, id: string, reason: string) {
  if (!reason.trim()) return
  await emit($, { kind: 'step', at: Date.now(), session: journal.me, track, id, status: 'skipped', reason: reason.trim(), origin: 'person', actor: 'person' })
  $.ui.toast(`↷ ${track}/${id} skipped`)
}

/** The person confirms a worker's proposed move: the step's obligation now lives in `to`. */
async function personMove($: EngineInterface, track: string, id: string, to: string, reason: string) {
  if (!to.trim()) return
  // The journal may have moved on since the proposal: check the move as it would stand now.
  await sync($).catch(() => undefined)
  const problem = checkMove(journal.events, Date.now(), track, id, to.trim())
  if (problem) {
    $.ui.toast(`Not moved: ${problem}`)
    // Redraw from the journal as it is now, so the pane shows why instead of the stale Confirm move.
    await republish($)
    return
  }
  await emit($, { kind: 'step', at: Date.now(), session: journal.me, track, id, status: 'moved', movedTo: to.trim(), reason: reason.trim() || undefined, origin: 'person', actor: 'person' })
  $.ui.toast(`↪ ${track}/${id} moved to ${to.trim()}`)
}

/**
 * The tools are thin: read the journal, run the shared action (actions.ts; the CLI runs the same),
 * append what it returns, and follow up in this chat (focus, track, toast).
 */
async function act($: EngineInterface, run: (ctx: ActionContext) => ActionResult): Promise<{ result: string }> {
  await sync($).catch(() => undefined)
  const r = run({
    events: journal.events,
    lives: [...journal.lives.values()].map(l => l.live),
    now: Date.now(),
    session: journal.me,
    actor: 'claude',
    via: 'claude-code',
    channel: 'tool',
    track: journal.track,
    focus: journal.focus,
    project: journal.project,
    hints: { codexInstalled: journal.codexInstalled, cli: 'node ~/.claude/mods/roadmap/cli/roadmap.mjs' },
  })
  if (!r.ok) return { result: r.text }
  for (const ev of r.emit) await emit($, ev)
  if (r.emit.length === 0) await republish($)
  if (r.track) journal.track = r.track
  if (r.focus) await setFocus($, r.focus)
  if (r.toast) $.ui.toast(r.toast)
  return { result: r.text }
}

/** Lays out a track, then shows the pane. */
async function actPlan($: EngineInterface, input: Record<string, unknown>): Promise<{ result: string }> {
  const out = await act($, ctx => planAction(ctx, input))
  void openPane($).catch(() => undefined)
  return out
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    journal.dir = (await $.env.get('CLAUDE_ROADMAP_DIR')) ?? `${home}/.claude/roadmap`
    journal.me = await $.session.id()
    const engine = await $.session.version().catch(() => undefined)
    journal.richButtons = !!engine && versionAtLeast(engine.base ?? engine.version, '2.1.295')
    const which = await $.process.run(['which', 'codex']).catch(() => undefined)
    journal.codexInstalled = which?.exitCode === 0 && !!which.stdout.trim()
    journal.project = e.cwd ? await detectProject($, e.cwd).catch(() => e.cwd) : undefined
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
        'the agent finishes. Mark steps the person must sign off as checkpoint, and dependencies as blocked_by ' +
        '(a plan that closes a dependency loop is refused). Give each step a why, a scope and done_when where ' +
        'you can: the agent that picks it up reads them with roadmap step. ' +
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
                      why: { type: 'string', description: 'The problem this step solves, in a sentence.' },
                      scope: { type: 'string', description: 'Its boundaries: what is in, and what must not be touched.' },
                      done_when: { type: 'string', description: 'How to tell it is finished: concrete done criteria.' },
                      review: {
                        type: 'object',
                        description:
                          'How this step\'s work must be reviewed before it counts as done. Required on NEW steps unless the track sets a default.',
                        properties: {
                          required: { type: 'boolean' },
                          independence: { type: 'string', enum: ['any', 'other-session', 'cross-model'] },
                          mode: { type: 'string', enum: ['standard', 'adversarial'] },
                        },
                        required: ['required'],
                      },
                    },
                    required: ['id', 'title'],
                  },
                },
              },
              required: ['name', 'steps'],
            },
          },
          review: {
            type: 'object',
            description:
              'The track\'s default review policy for its steps: { required, independence: any | other-session | ' +
              'cross-model (a different model family from the implementer), mode: standard | adversarial }.',
            properties: {
              required: { type: 'boolean' },
              independence: { type: 'string', enum: ['any', 'other-session', 'cross-model'] },
              mode: { type: 'string', enum: ['standard', 'adversarial'] },
            },
            required: ['required'],
          },
        },
        required: ['track', 'phases'],
      },
    })
    await $.tool.register({
      name: 'review',
      isDeferred: false,
      description:
        'Record a review of a roadmap step\'s work, as the reviewer: verdict pass, findings (passed, with ' +
        'follow-ups) or fail, with evidence. A step whose policy requires a review stays out of done until a ' +
        'review that meets its policy passes — for cross-model, the reviewer must be a different model family ' +
        'from the implementer, so a Claude session cannot satisfy it for Claude\'s own work: have Codex (or ' +
        'another model) review and record it. Record every round, a fail included, not only the last one. Findings to follow up go in `follow_ups`.',
      inputSchema: {
        type: 'object',
        properties: {
          step: { type: 'string' },
          verdict: { type: 'string', enum: ['pass', 'findings', 'fail'] },
          evidence: { type: 'string', description: 'What the review checked and found.' },
          note: { type: 'string' },
          start: { type: 'boolean', description: 'Only say you are reviewing it now (no verdict yet): the step stays as reported.' },
          follow_ups: {
            type: 'array',
            description: 'Findings to follow up: each becomes a follow-up step, set aside in the backlog for the person.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
              },
              required: ['title'],
            },
          },
        },
        required: ['step'],
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
        'track. Never work on a backlog step or track unless asked. Status "skipped" (with a short `reason`) ' +
        'proposes leaving a step out — not blocked, not failed, just not going to be done; the person confirms it. ' +
        'Status "moved" (with `to`, the step that now carries it, and a `reason`) proposes handing a step\'s obligation ' +
        'to another step — the work still has to be done, there; its dependents then wait on that step, and its review ' +
        'policy goes with it. The person confirms it.',
      inputSchema: {
        type: 'object',
        properties: {
          step: { type: 'string' },
          status: { type: 'string', enum: STATUSES.filter(x => x !== 'awaiting') },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3', 'none'] },
          backlog: { type: 'boolean' },
          reason: { type: 'string', description: 'Required with status "skipped" (why it will not be done) or "moved" (why it moved).' },
          reopen: {
            type: 'boolean',
            description:
              'With status "running" on work already reported done and waiting (for review or the person): reopen it, on purpose. A reviewer never needs this — use the review tool.',
          },
          to: { type: 'string', description: 'With status "moved": the step ("<track>/<id>", or "<id>" in the same track) that now carries the obligation.' },
          evidence: { type: 'string', description: 'What shows it: tests passed, commit, PR, measurement.' },
          note: { type: 'string', description: 'A few words: blocker, next step.' },
        },
        required: ['step'],
      },
    })
    await $.tool.register({
      name: 'step',
      isDeferred: false,
      description:
        'Read one roadmap step\'s brief before you work on it: why it exists, its scope (what not to touch), ' +
        'when it counts as done, what it waits on and what it unblocks, its priority and backlog state. ' +
        '`step` is "<track>/<id>".',
      inputSchema: { type: 'object', properties: { step: { type: 'string' } }, required: ['step'] },
    })
    await $.tool.register({
      name: 'done',
      isDeferred: false,
      description:
        'Close your work on a roadmap step with a structured report: what shipped, the evidence, and ' +
        'follow-ups. The step is marked done (a checkpoint waits for the person\'s confirmation); each ' +
        'follow-up becomes a new step in the track\'s "Follow-ups" phase, set aside in the backlog so the ' +
        'person decides when it is worked on. Use status "failed" if it did not work out.',
      inputSchema: {
        type: 'object',
        properties: {
          step: { type: 'string', description: '"<track>/<id>"' },
          shipped: { type: 'string', description: 'What was delivered, in a sentence or two.' },
          evidence: { type: 'string', description: 'What shows it: tests, commit, PR, measurement.' },
          status: { type: 'string', enum: ['done', 'failed'] },
          follow_ups: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
              },
              required: ['title'],
            },
          },
        },
        required: ['step', 'shipped'],
      },
    })
    await $.tool.register({
      name: 'status',
      isDeferred: false,
      description:
        'Read the roadmap shared by all sessions: the tracks of this chat\'s project (and those not placed in ' +
        'any) with their open steps, the other projects in one line, and the sessions working now. `all: true` ' +
        'shows every project\'s tracks.',
      inputSchema: { type: 'object', properties: { all: { type: 'boolean', description: 'Every project, not only this chat\'s.' } } },
    })

    await noteCode($).catch(() => undefined)
    const loadedAt = Date.now()
    await sync($).catch(() => undefined)
    await republish($)
    note(`module loaded; engine ${engine?.version ?? '?'}; code ${code.hash || '?'}; journal read in ${Date.now() - loadedAt} ms, ${journal.events.length} events`)
    void flushDiag($)
    // Diagnostics of chats gone for a week are dropped.
    void (async () => {
      const old = (await $.fs.list(`${journal.dir}/diag`).catch(() => []))
        .filter(x => x.kind === 'file' && Date.now() - x.mtimeMs > 7 * 86_400_000)
        .map(x => `${journal.dir}/diag/${x.name}`)
      if (old.length) await remove($, old)
    })().catch(() => undefined)
    // A (re)loaded module draws its panes again: one left from the module before would keep buttons that
    // no longer answer.
    try {
      $.ui.invalidate('ui.render')
    } catch {
      // nothing open to redraw
    }
    // Only when there is a backlog of old loose files; a no-op otherwise.
    await compact($).catch(() => undefined)

    $.clock.every(3000, () => {
      void (async () => {
        // Both run every tick: `||` would skip the heartbeat whenever something else changed.
        const synced = await sync($)
        const beat = await heartbeat($)
        await checkCode($).catch(() => undefined)
        await flushDiag($)
        const changed = synced || beat
        const mine = [...journal.agents.keys()]
        if (mine.length > 0) {
          const live = await $.agent.list()
          for (const id of mine) {
            const seen = live.find(l => l.id === id)
            if (seen?.status === 'completed') await endAgent($, id, 'done')
            else if (seen?.status === 'failed' || seen?.status === 'killed') await endAgent($, id, 'failed')
          }
        }
        // Fold again only when something changed; every 30 s regardless, for "5m ago" and live expiry.
        if (changed || Date.now() - journal.lastFold > 30_000) await republish($)
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
      summary(now, { project: journal.project }) +
      '\nIf this task is one of these steps: read its brief first (roadmap step), mark it running when you ' +
      'start, and close it with roadmap done (what shipped, evidence, follow-ups). A step whose review policy ' +
      'requires a review only counts as done after one that meets it (cross-model: another model family reviews ' +
      'and records it with roadmap review). New steps you lay out need a review policy. Put "#<track>/<id>" in each Agent description for that step. Checkpoints ' +
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
        await emit($, { kind: 'session', at: Date.now(), session: journal.me, title: journal.title, actor: 'claude', project: journal.project }).catch(
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
      const b = forProject(await read($, board), (await readProjectView($)) || journal.project || '*')
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

  on('tool.call', { tool: TOOL_PLAN }, ($, e) => actPlan($, e as unknown as Record<string, unknown>))
  on('tool.call', { tool: TOOL_MARK }, ($, e) => act($, ctx => markAction(ctx, e as unknown as Record<string, unknown>)))
  on('tool.call', { tool: TOOL_DONE }, ($, e) => act($, ctx => doneAction(ctx, e as unknown as Record<string, unknown>)))
  on('tool.call', { tool: TOOL_STEP }, ($, e) => act($, ctx => stepAction(ctx, e as unknown as Record<string, unknown>)))
  on('tool.call', { tool: TOOL_STATUS }, ($, e) => act($, ctx => statusAction(ctx, e as unknown as Record<string, unknown>)))
  on('tool.call', { tool: TOOL_REVIEW }, ($, e) => act($, ctx => reviewAction(ctx, e as unknown as Record<string, unknown>)))

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
    if (ref) await setFocus($, `${ref.track}/${ref.id}`)
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
    // A pane that cannot draw says why instead of staying blank (e.g. code reloaded in a running chat),
    // and one whose data does not come in time says so too, rather than leaving the host's placeholder.
    const els = $.ui.resolve(e)
    const t0 = Date.now()
    try {
      const drawn = drawPane(els, await inTime(ms => $.clock.sleep(ms), paneData($, e)))
      rendered('pane', Date.now() - t0)
      return drawn
    } catch (err) {
      rendered('pane', Date.now() - t0, err)
      void flushDiag($)
      return cannotDraw(els, err)
    }
  })

  // The Chains diagram alone, in a pane of its own that can open wide (⤢ Wide in the Chains tab).
  on('ui.render', { component: 'Pane', requestId: CHAINS }, async ($, e) => {
    const els = $.ui.resolve(e)
    const t0 = Date.now()
    try {
      const drawn = drawChainsPane(els, { ...(await inTime(ms => $.clock.sleep(ms), paneData($, e))), wide: true })
      rendered('chains', Date.now() - t0)
      return drawn
    } catch (err) {
      rendered('chains', Date.now() - t0, err)
      void flushDiag($)
      return cannotDraw(els, err)
    }
  })

  // The pane's toggle, one line above the prompt (`/roadmap band` hides it).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Like the pane: a band that cannot draw says so, with its toggle, instead of vanishing.
    try {
      if (e.props.hasSurvey || !(await read($, showBand))) return next(e)
      const b = await read($, board)
      if (b.tracks.length === 0) return next(e)
      return drawBand($.ui.resolve(e), {
        // The band speaks for this chat's project.
        board: forProject(b, journal.project),
        isOpen: await read($, paneOpen),
        cols: e.props.bodyColumns,
        onToggle: () => void togglePane($),
        focus: await readFocus($),
        outdated: await readOutdated($),
      })
    } catch {
      const { Box, Text, Button } = $.ui.resolve(e)
      return (
        <Box flexDirection="row" gap={1}>
          <Button key="band-toggle" plain variant="primary" onPress={() => void togglePane($)}>
            Roadmap
          </Button>
          <Text color="warning" wrap="truncate-end">↻ could not draw — restart this chat</Text>
        </Box>
      )
    }
  })
}
