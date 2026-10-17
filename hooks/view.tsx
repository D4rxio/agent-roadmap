import type { RoadmapBoard, RoadmapPriority, RoadmapStatus, RoadmapStep, RoadmapTrack } from '../types'
import { ICONS, PRIORITIES, attention, family, byPriority, days, doneSeries, dayOf, duration, progress, progressBar, when } from './model'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Els = Record<string, any>

export type RoadmapView = 'tracks' | 'days' | 'backlog'

export type PaneData = {
  board: RoadmapBoard
  view: RoadmapView
  expanded: string[]
  now: number
  tz: number
  me: string
  cols: number
  canDraw: boolean
  onView: (view: RoadmapView) => void
  onToggle: (track: string) => void
  /** Phases opened or closed by hand in this chat, `<track>::<phase>` → open. */
  phaseOpen: Record<string, boolean>
  onTogglePhase: (key: string, open: boolean) => void
  onCopyTrack: (track: string, surface: string) => void
  onCopyAll: (surface: string) => void
  /** Copies one line of text (a title, a step reference) to the clipboard. */
  onCopyText: (text: string, surface: string) => void
  onDecide: (track: string, id: string, status: RoadmapStatus) => void
  /** `<track>/<id>` being renamed, or ''. */
  editing: string
  onCycle: (track: string, id: string, status: RoadmapStatus) => void
  onAdd: (track: string, title: string) => void
  onStartEdit: (ref: string) => void
  onRename: (track: string, id: string, title: string) => void
  onRemove: (track: string, id: string) => void
  onPriority: (track: string, id: string, priority: RoadmapPriority | null) => void
  onBacklog: (track: string, id: string, backlog: boolean) => void
  onTrackPriority: (track: string, priority: RoadmapPriority | null) => void
  onTrackBacklog: (track: string, backlog: boolean) => void
  /** The person archives a track (hidden, restorable from the Backlog tab) or brings it back. */
  onArchive: (track: string, archived: boolean) => void
  /** The item this chat holds, `<track>/<id>`, or ''. */
  focus: string
  onPin: (ref: string) => void
  /** The person skips a step, with the reason they gave. */
  onSkip: (track: string, id: string, reason: string) => void
  /** The person confirms a proposed move: the step's obligation goes to `to`, for `reason`. */
  onMove: (track: string, id: string, to: string, reason: string) => void
  /** Whether this engine draws styled content inside a Button (2.1.295 on). */
  richButtons: boolean
}

type Part = { text: string; color?: string; dim?: boolean; bold?: boolean; strike?: boolean; main?: boolean }

/**
 * One line that never wraps. A Text holding styled Texts inside is wrapped by graphical surfaces even
 * with a truncating wrap, and a wrapped row breaks the pane's scrolling (it counts one row per line).
 * So each styled piece is its own Text: fixed parts keep their width, the main part is cut with "…".
 */
function Line(els: Els, key: string, parts: Part[]) {
  const { Box, Text } = els
  return (
    <Box key={key} flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
      {parts.map((p, i) =>
        p.main ? (
          <Box key={`${key}-main`} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            <Text wrap="truncate-end" color={p.color} dimColor={p.dim} bold={p.bold} strikethrough={p.strike}>
              {p.text}
            </Text>
          </Box>
        ) : (
          <Box key={`${key}-${i}`} flexShrink={0}>
            <Text color={p.color} dimColor={p.dim} bold={p.bold}>
              {p.text}
            </Text>
          </Box>
        ),
      )}
    </Box>
  )
}

function shortTitle(text: string, max = 22): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** "This chat: ◐ api/2.4 One error format": the item this chat holds, first thing in its pane. */
function thisChat(els: Els, d: PaneData) {
  const { Box, Text } = els
  if (!d.focus) return null
  const [track, id] = [d.focus.split('/')[0] ?? '', d.focus.split('/').slice(1).join('/')]
  const t = d.board.tracks.find(x => x.name === track)
  const s = t?.steps.find(x => x.id === id)
  return (
    <Box key="this-chat" flexDirection="row" gap={1} marginBottom={1}>
      <Text color="warning" bold>
        This chat
      </Text>
      {Line(els, 'this-chat-line', [
        ...(s ? [{ text: `${ICONS[s.status]} `, color: COLOR[s.status] }] : []),
        { text: s ? `${d.focus}  ${s.title}` : t ? t.title : d.focus, main: true },
      ])}
      {Btn(els, d, { key: "unpin", plain: true, onPress: () => d.onPin('') }, "Unpin", <Text><Text dimColor>Unpin</Text></Text>)}
    </Box>
  )
}

/** A click on the priority chip raises it: none → P3 → P2 → P1 → P0 → none. */
export function nextPriority(p: RoadmapPriority | undefined): RoadmapPriority | null {
  if (!p) return 'P3'
  const i = PRIORITIES.indexOf(p)
  return i === 0 ? null : (PRIORITIES[i - 1] ?? null)
}

const PRIO_COLOR: Record<RoadmapPriority, string> = { P0: 'error', P1: 'warning', P2: 'suggestion', P3: 'subtle' }

function prioChip(els: Els, d: PaneData, t: RoadmapTrack, s: RoadmapStep) {
  const { Text } = els
  return (
    Btn(els, d, { key: `prio-${t.name}/${s.id}`, plain: true, onPress: () => d.onPriority(t.name, s.id, nextPriority(s.priority)) }, s.priority ?? "P·", <Text>{s.priority ? <Text bold color={PRIO_COLOR[s.priority]}>{s.priority}</Text> : <Text dimColor>P·</Text>}</Text>)
  )
}

/**
 * A Button with styled content where the engine draws it (2.1.295 on), and the same Button with its
 * plain label on older engines, which take one string child only: the pane works on both.
 */
function Btn(els: Els, d: { richButtons: boolean }, props: Record<string, any>, label: string, rich: any) {
  const { Button } = els
  return d.richButtons ? (
    <Button {...props} label={label}>
      {rich}
    </Button>
  ) : (
    <Button {...props}>{label}</Button>
  )
}

/** What a click on a step's icon makes of it: the person's own word, so it also closes a checkpoint. */
export function nextStatus(status: RoadmapStatus): RoadmapStatus {
  if (status === 'todo' || status === 'blocked' || status === 'failed') return 'running'
  if (status === 'running' || status === 'awaiting') return 'done'
  // done, skipped and moved all go back to todo: a skip or a move is undone by the same click.
  return 'todo'
}

const COLOR: Record<RoadmapStatus, string> = {
  todo: 'subtle',
  running: 'warning',
  done: 'success',
  failed: 'error',
  blocked: 'subtle',
  awaiting: 'permission',
  skipped: 'subtle',
  moved: 'subtle',
}

// Mid-tone fills that read on both a light and a dark page.
const FILL: Record<RoadmapStatus, string> = {
  done: '#3fb950',
  awaiting: '#58a6ff',
  running: '#d29922',
  blocked: 'url(#blocked)',
  failed: '#e5534b',
  todo: 'rgba(128,128,128,0.22)',
  skipped: 'rgba(128,128,128,0.22)',
  moved: 'rgba(128,128,128,0.22)',
}

const ORDER: RoadmapStatus[] = ['done', 'awaiting', 'running', 'blocked', 'failed', 'todo']

/** One stacked bar: done, awaiting, running, blocked, failed, then what is left. */
export function progressSvg(steps: RoadmapStep[]): string {
  const total = Math.max(1, steps.length)
  let x = 0
  const rects = ORDER.map(status => {
    const n = steps.filter(s => s.status === status).length
    if (n === 0) return ''
    const w = (n / total) * 1000
    const r = `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="6" fill="${FILL[status]}"/>`
    x += w
    return r
  }).join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="6" viewBox="0 0 1000 6" preserveAspectRatio="none">` +
    `<clipPath id="r"><rect width="1000" height="6" rx="3" ry="3"/></clipPath>` +
    // Blocked is waiting, not broken: muted diagonal stripes, red stays for failed.
    `<pattern id="blocked" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<rect width="6" height="6" fill="rgba(128,128,128,0.30)"/><rect width="3" height="6" fill="rgba(128,128,128,0.55)"/></pattern>` +
    `<g clip-path="url(#r)">` +
    `<rect width="1000" height="6" fill="${FILL.todo}"/>${rects}</g></svg>`
  )
}

/** Steps finished per day, oldest first; today's bar is the brightest. */
export function sparkSvg(series: number[]): string {
  const max = Math.max(1, ...series)
  const w = 1000 / series.length
  const bars = series
    .map((n, i) => {
      const h = n === 0 ? 2 : 4 + (n / max) * 32
      const last = i === series.length - 1
      const fill = n === 0 ? 'rgba(128,128,128,0.25)' : last ? '#3fb950' : 'rgba(63,185,80,0.6)'
      return `<rect x="${(i * w + w * 0.15).toFixed(1)}" y="${(36 - h).toFixed(1)}" width="${(w * 0.7).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${fill}"><title>${n} done</title></rect>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="36" viewBox="0 0 1000 36" preserveAspectRatio="none">${bars}</svg>`
}

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
function sparkText(series: number[]): string {
  const max = Math.max(1, ...series)
  return series.map(n => (n === 0 ? '·' : BLOCKS[Math.min(7, Math.round((n / max) * 7))])).join('')
}

function stepRight(s: RoadmapStep, d: PaneData): string {
  if (s.status === 'blocked') return `waits on ${s.blockedBy.join(', ')}`
  if (s.status === 'done') return s.endedAt ? when(s.endedAt, d.now, d.tz) : ''
  if (s.status === 'running' && s.stale) return `stale · nobody on it since ${s.lastAt ? when(s.lastAt, d.now, d.tz) : 'long ago'}`
  if (s.status === 'running') return s.startedAt ? `for ${duration(d.now - s.startedAt)}` : 'running'
  if (s.status === 'awaiting' && s.reviewPending) return s.reviewState === 'failed' ? 'review failed' : 'review owed'
  if (s.status === 'awaiting' && s.reviewState === 'reviewed') return 'reviewed · to confirm'
  if (s.status === 'awaiting') return s.proposed === 'skipped' ? 'skip to confirm' : s.proposed === 'moved' ? `move to ${s.movedTo ?? '?'} to confirm` : 'to confirm'
  if (s.status === 'skipped') return `skipped: ${s.skipReason ?? 'no reason'}`
  if (s.status === 'moved') return s.movedFinal ? `moved to ${s.movedFinal}` : `moved to ${s.movedTo ?? '?'} (chain broken)`
  if (s.status === 'failed') return s.endedAt ? `failed ${when(s.endedAt, d.now, d.tz)}` : 'failed'
  if (s.carries?.length) return `also answers for ${s.carries.join(', ')}`
  return ''
}

/** "today +2 · yesterday +3 · last 14:02": a track's recent momentum in one line. */
function momentum(t: RoadmapTrack, d: PaneData): string {
  const today = dayOf(d.now, d.tz)
  let td = 0
  let yd = 0
  for (const s of t.steps) {
    if (s.status !== 'done' || s.endedAt === undefined) continue
    const day = dayOf(s.endedAt, d.tz)
    if (day === today) td++
    else if (day === today - 1) yd++
  }
  const parts = [td ? `today +${td}` : '', yd ? `yesterday +${yd}` : '']
  const last = Math.max(0, ...t.steps.map(s => s.lastAt ?? 0))
  if (last) parts.push(`moved ${when(last, d.now, d.tz)}`)
  return parts.filter(Boolean).join(' · ')
}

function Row(els: Els, key: string, left: any, right?: string, rightColor?: string) {
  const { Box, Text } = els
  return (
    <Box key={key} flexDirection="row" gap={1}>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        {left}
      </Box>
      {right ? (
        <Box flexShrink={2} minWidth={0} overflow="hidden">
          <Text dimColor={!rightColor} color={rightColor} wrap="truncate-end">
            {right}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}

function Bar(els: Els, d: PaneData, key: string, steps: RoadmapStep[]) {
  const { Text, Svg } = els
  if (d.canDraw && Svg) return <Svg key={key} source={progressSvg(steps)} alt="progress" height={6} />
  const done = steps.filter(s => s.status === 'done').length
  return (
    <Text key={key} color="success">
      {progressBar(done, steps.length, Math.max(8, Math.min(40, d.cols - 4)))}
    </Text>
  )
}

function header(els: Els, d: PaneData) {
  const { Box, Text, Button } = els
  const tab = (view: RoadmapView, label: string) => (
    <Button key={`view-${view}`} plain variant={d.view === view ? 'primary' : undefined} onPress={() => d.onView(view)}>
      {d.view === view ? `[${label}]` : ` ${label} `}
    </Button>
  )
  return (
    <Box key="header" flexDirection="row" gap={1} marginBottom={1}>
      <Text bold>Roadmap</Text>
      {tab('tracks', 'Tracks')}
      {tab('days', 'Days')}
      {tab(
        'backlog',
        `Backlog ${d.board.tracks.filter(t => t.backlog || t.archived).length + d.board.tracks.filter(t => !t.archived).flatMap(t => t.steps).filter(x => x.backlog).length}`,
      )}
      <Box flexGrow={1} />
      <Button key="copy-all" plain onPress={(press: any) => d.onCopyAll(press?.surface ?? 'desktop')}>
        ⧉ Copy all as Markdown
      </Button>
    </Box>
  )
}

function needsYou(els: Els, d: PaneData) {
  const { Box, Text, Button } = els
  const needs = attention(d.board)
  if (needs.awaiting.length + needs.failed.length + needs.stale.length === 0) return null
  const titleOf = (track: string) => d.board.tracks.find(t => t.name === track)?.title ?? track
  return (
    <Box key="attention" flexDirection="column" marginBottom={1}>
      <Box flexDirection="row" gap={2}>
        <Text bold>Needs you</Text>
        {needs.awaiting.length ? <Text color="permission">{`◆ ${needs.awaiting.length} to confirm`}</Text> : null}
        {needs.failed.length ? <Text color="error">{`✗ ${needs.failed.length} failed`}</Text> : null}
        {needs.stale.length ? <Text color="warning">{`◌ ${needs.stale.length} stale`}</Text> : null}
      </Box>
      {needs.stale.map(st => (
        <Box key={`stale-${st.track}-${st.id}`} flexDirection="column" marginTop={1}>
          {Line(els, `stale-line-${st.track}-${st.id}`, [
            { text: '◌ ', color: 'warning' },
            { text: `${titleOf(st.track)} · ${st.id} ${st.title}`, main: true },
          ])}
          <Text dimColor wrap="truncate-end">{`   running for ${st.startedAt ? duration(d.now - st.startedAt) : 'a while'}, nobody on it since ${st.lastAt ? when(st.lastAt, d.now, d.tz) : 'long ago'}${st.lastBy ? ` · last ${st.lastBy}` : ''}`}</Text>
          <Box flexDirection="row" gap={1}>
            <Text>{'  '}</Text>
            <Button key={`stale-todo-${st.track}-${st.id}`} onPress={() => d.onCycle(st.track, st.id, 'todo')}>
              Back to todo
            </Button>
            <Button key={`stale-done-${st.track}-${st.id}`} onPress={() => d.onCycle(st.track, st.id, 'done')}>
              Done ✓
            </Button>
          </Box>
        </Box>
      ))}
      {needs.awaiting.map(st => (
        <Box key={`await-${st.track}-${st.id}`} flexDirection="column" marginTop={1}>
          {Line(els, `await-line-${st.track}-${st.id}`, [
            { text: '◆ ', color: 'permission' },
            { text: `${titleOf(st.track)} · ${st.id} ${st.title}`, main: true },
          ])}
          {st.reviewPending ? (
            <Text dimColor wrap="truncate-end">{`   waits for ${st.review?.independence === 'cross-model' ? `a cross-model review (not ${family(st.implementer?.actor)})` : 'an independent review'}${st.reviewState === 'failed' ? ' — the last one failed' : ''}`}</Text>
          ) : st.reviewState === 'reviewed' && st.passedReview ? (
            <Text dimColor wrap="truncate-end">{`   ⚖ ${st.passedReview.verdict} by ${st.passedReview.actor}${st.passedReview.via ? ` (${st.passedReview.via})` : ''}${st.passedReview.evidence ? ` — ${st.passedReview.evidence}` : ''}`}</Text>
          ) : st.proposed === 'moved' ? (
            <Text dimColor wrap="truncate-end">{`   proposes moving it to ${st.movedTo ?? '?'}: ${st.moveReason ?? 'no reason given'}${st.lastBy ? ` · by ${st.lastBy}` : ''}`}</Text>
          ) : st.proposed === 'skipped' ? (
            <Text dimColor wrap="truncate-end">{`   proposes skipping: ${st.skipReason ?? 'no reason given'}${st.lastBy ? ` · by ${st.lastBy}` : ''}`}</Text>
          ) : st.evidence || st.lastBy ? (
            <Text dimColor wrap="truncate-end">{`   ${st.evidence ?? `by ${st.lastBy}`}`}</Text>
          ) : null}
          <Box flexDirection="row" gap={1} marginTop={0}>
            <Text>{'  '}</Text>
            <Button
              key={`ok-${st.track}-${st.id}`}
              variant="primary"
              onPress={() =>
                st.proposed === 'skipped'
                  ? d.onSkip(st.track, st.id, st.skipReason ?? '')
                  : st.proposed === 'moved'
                    ? d.onMove(st.track, st.id, st.movedTo ?? '', st.moveReason ?? '')
                    : d.onDecide(st.track, st.id, 'done')
              }
            >
              {st.proposed === 'skipped' ? 'Confirm skip' : st.proposed === 'moved' ? 'Confirm move' : st.reviewPending ? 'Confirm without review' : 'Confirm ✓'}
            </Button>
            <Button
              key={`no-${st.track}-${st.id}`}
              onPress={() => d.onDecide(st.track, st.id, st.proposed === 'skipped' || st.proposed === 'moved' ? 'todo' : 'failed')}
            >
              Reject
            </Button>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

function trackCard(els: Els, d: PaneData, t: RoadmapTrack) {
  const { Box, Text, Button } = els
  const { done, total } = progress(t)
  const pct = total ? Math.round((done / total) * 100) : 0
  const isOpen = d.expanded.includes(t.name)
  const active = t.steps.filter(s => !s.backlog)
  const shelved = t.steps.filter(s => s.backlog).sort(byPriority)
  const blocked = active.filter(s => s.status === 'blocked').length
  const running = t.steps.filter(s => s.status === 'running').length
  const awaiting = t.steps.filter(s => s.status === 'awaiting').length
  const live = d.board.sessions.filter(s => s.isLive && s.track === t.name).length
  const chips = [
    running ? `◐ ${running}` : '',
    awaiting ? `◆ ${awaiting}` : '',
    blocked ? `⊘ ${blocked}` : '',
    live ? `● ${live} live` : '',
    shelved.length ? `${shelved.length} in backlog` : '',
  ].filter(Boolean)
  return (
    <Box key={`track-${t.name}`} flexDirection="column" marginBottom={1}>
      <Box flexDirection="row" gap={1}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {Btn(els, d, { key: `fold-${t.name}`, plain: true, onPress: () => d.onToggle(t.name) }, `${isOpen ? '▾' : '▸'} ${t.title}`, <Text>{`${isOpen ? '▾' : '▸'} `}
            <Text bold color={done === total && total > 0 ? 'success' : undefined}>
              {t.title}
            </Text></Text>)}
        </Box>
        <Box flexDirection="row" display={d.canDraw ? 'none' : 'flex'} hover={d.canDraw ? { display: 'flex' } : undefined}>
          {Btn(els, d, { key: `tcopy-${t.name}`, plain: true, onPress: (press: any) => d.onCopyText(t.title, press?.surface ?? 'desktop') }, 'Copy', <Text><Text dimColor>Copy</Text></Text>)}
          {Btn(els, d, { key: `tshelve-${t.name}`, plain: true, onPress: () => d.onTrackBacklog(t.name, !t.backlog) }, "Backlog", <Text><Text dimColor>{t.backlog ? '' : 'Backlog'}</Text></Text>)}
          {!t.archived && !(done === total && total > 0)
            ? Btn(els, d, { key: `tarchive-${t.name}`, plain: true, onPress: () => d.onArchive(t.name, true) }, 'Archive', <Text><Text dimColor>Archive</Text></Text>)
            : null}
        </Box>
        {/* A finished track offers its archive outright: that is the usual next step for it. */}
        {!t.archived && done === total && total > 0
          ? Btn(els, d, { key: `tarchive-${t.name}`, plain: true, onPress: () => d.onArchive(t.name, true) }, 'Archive', <Text><Text color="success">Archive</Text></Text>)
          : null}
        {t.archived
          ? Btn(els, d, { key: `tunarchive-${t.name}`, plain: true, onPress: () => d.onArchive(t.name, false) }, 'Unarchive', <Text><Text color="suggestion">↺ Unarchive</Text></Text>)
          : null}
        {t.backlog ? (
          Btn(els, d, { key: `trestore-${t.name}`, plain: true, onPress: () => d.onTrackBacklog(t.name, false) }, "Restore", <Text><Text color="suggestion">↺ Restore</Text></Text>)
        ) : null}
        {Btn(els, d, { key: `tprio-${t.name}`, plain: true, onPress: () => d.onTrackPriority(t.name, nextPriority(t.priority)) }, t.priority ?? "P·", <Text>{t.priority ? <Text bold color={PRIO_COLOR[t.priority]}>{t.priority}</Text> : <Text dimColor>P·</Text>}</Text>)}
        <Text bold>{`${pct}%`}</Text>
        <Text dimColor>{`${done}/${total}`}</Text>
      </Box>
      {Bar(els, d, `bar-${t.name}`, active)}
      {Row(els, `meta-${t.name}`, <Text dimColor wrap="truncate-end">{momentum(t, d) || t.name}</Text>, chips.join('  '))}
      {isOpen &&
        t.phases.map(p => {
          const own = active.filter(s => p.stepIds.includes(s.id))
          const pDone = own.filter(s => s.status === 'done').length
          if (own.length === 0) return null
          // A phase with work left, or holding this chat's step, starts open; a finished one starts
          // closed. A hand toggle in this chat wins over the default.
          const finished = own.every(s => s.status === 'done' || s.status === 'skipped' || s.status === 'moved')
          const holds = own.some(s => d.focus === `${t.name}/${s.id}`)
          const pkey = `${t.name}::${p.name}`
          const open = d.phaseOpen[pkey] ?? (!finished || holds)
          return (
            <Box key={`phase-${t.name}-${p.name}`} flexDirection="column" marginTop={1}>
              {Row(
                els,
                `ph-${t.name}-${p.name}`,
                Btn(
                  els,
                  d,
                  { key: `phasefold-${pkey}`, plain: true, onPress: () => d.onTogglePhase(pkey, !open) },
                  `${open ? '▾' : '▸'} ${p.name}`,
                  <Text>
                    <Text dimColor>{`${open ? '▾' : '▸'} `}</Text>
                    <Text dimColor bold color={finished ? 'success' : undefined}>
                      {p.name}
                    </Text>
                  </Text>,
                ),
                `${pDone}/${own.length}`,
              )}
              {open ? own.map(s => stepRow(els, d, t, s)) : null}
            </Box>
          )
        })}
      {isOpen && shelved.length ? (
        <Box key={`shelf-${t.name}`} flexDirection="column" marginTop={1}>
          {Row(els, `shelf-h-${t.name}`, <Text dimColor bold>Backlog</Text>, `${shelved.length} set aside`)}
          {shelved.map(s => stepRow(els, d, t, s))}
        </Box>
      ) : null}
      {isOpen && els.Input ? (
        <Box flexDirection="row" marginTop={1}>
          <els.Input
            key={`add-${t.name}`}
            placeholder="+ Add an item, Enter to save"
            value=""
            onSubmit={(value: string) => {
              if (value.trim()) d.onAdd(t.name, value.trim())
            }}
          />
        </Box>
      ) : null}
      {isOpen ? (
        <Box flexDirection="row" marginTop={1}>
          <Button key={`copy-${t.name}`} plain onPress={(press: any) => d.onCopyTrack(t.name, press?.surface ?? 'desktop')}>
            ⧉ Copy as Markdown
          </Button>
        </Box>
      ) : null}
    </Box>
  )
}

function stepRow(els: Els, d: PaneData, t: RoadmapTrack, s: RoadmapStep) {
  const { Box, Text, Button, Input } = els
  const ref = `${t.name}/${s.id}`
  if (d.editing === `skip:${ref}` && Input) {
    return (
      <Box key={`step-${ref}`} flexDirection="row" gap={1}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Input
            key={`skip-${ref}`}
            placeholder={`Why skip ${s.id}? Enter to skip`}
            value=""
            autoFocus
            onSubmit={(value: string) => {
              if (value.trim()) d.onSkip(t.name, s.id, value.trim())
              d.onStartEdit('')
            }}
          />
        </Box>
        <Button key={`cancel-skip-${ref}`} plain onPress={() => d.onStartEdit('')}>
          Cancel
        </Button>
      </Box>
    )
  }
  if (d.editing === ref && Input) {
    return (
      <Box key={`step-${ref}`} flexDirection="row" gap={1}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Input
            key={`edit-${ref}`}
            value={s.title}
            autoFocus
            onSubmit={(value: string) => {
              if (value.trim() && value.trim() !== s.title) d.onRename(t.name, s.id, value.trim())
              d.onStartEdit('')
            }}
          />
        </Box>
        <Button key={`cancel-${ref}`} plain onPress={() => d.onStartEdit('')}>
          Cancel
        </Button>
      </Box>
    )
  }
  const right = stepRight(s, d)
  return (
    <Box key={`step-${ref}`} flexDirection="row" gap={1}>
      {Btn(els, d, { key: `cycle-${ref}`, plain: true, onPress: () => d.onCycle(t.name, s.id, nextStatus(s.status)) }, ICONS[s.status], <Text><Text color={COLOR[s.status]}>{ICONS[s.status]}</Text></Text>)}
      {prioChip(els, d, t, s)}
      {Line(els, `title-${ref}`, [
        { text: `${s.id}  ${s.title}`, main: true, dim: s.status === 'done' || s.status === 'skipped' || s.status === 'moved' || s.backlog, strike: s.status === 'skipped' },
        ...(s.review?.required
          ? [
              s.reviewState === 'satisfied' || (s.reviewState === 'reviewed' && s.status === 'done')
                ? { text: `  ⚖ ✓ ${s.reviews.length ? family(s.reviews[s.reviews.length - 1]!.actor) : ''}`.trimEnd(), color: 'success' }
                : s.reviewState === 'reviewed'
                  ? { text: `  ⚖ ${family(s.passedReview?.actor)} passed · confirm`, color: 'permission' }
                  : s.reviewState === 'failed'
                    ? { text: '  ⚖ ✗ review failed', color: 'error' }
                  : { text: `  ⚖ ${s.review.independence === 'cross-model' ? 'cross-model' : 'review'}`, color: 'subtle' },
            ]
          : []),
        ...(s.addedBy ? [{ text: '  ✎ you', color: 'suggestion' }] : []),
        ...(d.focus === ref ? [{ text: '  ● this chat', color: 'warning' }] : []),
        ...d.board.sessions
          .filter(x => x.isLive && x.focus === ref && x.id !== d.me)
          .map(x => ({ text: `  ● ${shortTitle(x.title)}`, color: 'subtle' })),
      ])}
      {right ? (
        <Box flexShrink={2} minWidth={0} overflow="hidden">
          <Text
            dimColor={s.status !== 'awaiting'}
            color={s.status === 'awaiting' ? 'permission' : undefined}
            wrap="truncate-end"
          >
            {right}
          </Text>
        </Box>
      ) : null}
      {s.backlog ? (
        Btn(els, d, { key: `shelve-${ref}`, plain: true, onPress: () => d.onBacklog(t.name, s.id, false) }, s.backlog ? "Restore" : "Backlog", <Text><Text color="suggestion">↺ Restore</Text></Text>)
      ) : null}
      {/* Row actions stay out of sight until the pointer is on the row (desktop); the terminal shows them. */}
      <Box
        flexDirection="row"
        gap={1}
        display={d.canDraw ? 'none' : 'flex'}
        hover={d.canDraw ? { display: 'flex' } : undefined}
      >
        {s.status !== 'done' && s.status !== 'skipped' && s.status !== 'moved' ? (
          // The person's own word: it also closes a checkpoint or a step awaiting confirmation.
          Btn(els, d, { key: `done-${ref}`, plain: true, onPress: () => d.onCycle(t.name, s.id, 'done') }, 'Done ✓', <Text><Text color="success">Done ✓</Text></Text>)
        ) : null}
        {Btn(
          els,
          d,
          { key: `scopy-${ref}`, plain: true, onPress: (press: any) => d.onCopyText(`#${ref} ${s.title}`, press?.surface ?? 'desktop') },
          'Copy',
          <Text><Text dimColor>Copy</Text></Text>,
        )}
        {d.focus !== ref ? (
          Btn(els, d, { key: `pin-${ref}`, plain: true, onPress: () => d.onPin(ref) }, "Pin", <Text><Text dimColor>Pin</Text></Text>)
        ) : null}
        {s.status !== 'skipped' && s.status !== 'done' && s.status !== 'moved' && els.Input ? (
          Btn(els, d, { key: `skipit-${ref}`, plain: true, onPress: () => d.onStartEdit(`skip:${ref}`) }, "Skip", <Text><Text dimColor>Skip</Text></Text>)
        ) : null}
        {!s.backlog ? (
          Btn(els, d, { key: `shelve-${ref}`, plain: true, onPress: () => d.onBacklog(t.name, s.id, true) }, s.backlog ? "Restore" : "Backlog", <Text><Text dimColor>Backlog</Text></Text>)
        ) : null}
        {s.addedBy ? (
          Btn(els, d, { key: `rename-${ref}`, plain: true, onPress: () => d.onStartEdit(ref) }, "Rename", <Text><Text dimColor>✎</Text></Text>)
        ) : null}
        {s.addedBy ? (
          Btn(els, d, { key: `remove-${ref}`, plain: true, onPress: () => d.onRemove(t.name, s.id) }, "Remove", <Text><Text dimColor>✕</Text></Text>)
        ) : null}
      </Box>
    </Box>
  )
}

function liveSection(els: Els, d: PaneData) {
  const { Box, Text } = els
  const sessions = d.board.sessions.filter(s => s.isLive)
  const agents = d.board.agents.filter(a => a.status === 'running')
  if (sessions.length + agents.length === 0) return null
  return (
    <Box key="live" flexDirection="column" marginTop={1}>
      <Text bold>{`Working now  ${sessions.length} sessions · ${agents.length} agents`}</Text>
      {sessions.map(s =>
        Row(
          els,
          `s-${s.id}`,
          Line(els, `s-line-${s.id}`, [
            { text: '● ', color: 'warning' },
            { text: `${s.title}${s.id === d.me ? ' (this)' : ''}`, main: true },
          ]),
          s.activity ? `→ ${s.activity}` : s.track,
        ),
      )}
      {agents.map(a =>
        Row(
          els,
          `a-${a.id}`,
          Line(els, `a-line-${a.id}`, [
            { text: '  ◐ ', color: 'warning' },
            { text: a.description, main: true },
          ]),
          [a.step ? `${a.track}/${a.step}` : '', a.activity ? `→ ${a.activity}` : `${duration(d.now - a.startedAt)}`]
            .filter(Boolean)
            .join(' · '),
        ),
      )}
    </Box>
  )
}

const KIND: Record<string, { icon: string; color: string }> = {
  done: { icon: '✓', color: 'success' },
  failed: { icon: '✗', color: 'error' },
  awaiting: { icon: '◆', color: 'permission' },
  skipped: { icon: '↷', color: 'subtle' },
  moved: { icon: '↪', color: 'subtle' },
  started: { icon: '◐', color: 'warning' },
  session: { icon: '●', color: 'subtle' },
  agent: { icon: '◇', color: 'subtle' },
}

function daysView(els: Els, d: PaneData) {
  const { Box, Text, Svg } = els
  const series = doneSeries(d.board, d.now, d.tz, 14)
  const list = days(d.board, d.now, d.tz, 14)
  return (
    <Box key="days" flexDirection="column">
      {Row(els, 'spark-h', <Text dimColor>Steps done, last 14 days</Text>, `${series.reduce((a, b) => a + b, 0)} total`)}
      {d.canDraw && Svg ? (
        <Svg key="spark" source={sparkSvg(series)} alt="steps done per day" height={36} />
      ) : (
        <Text key="spark" color="success">
          {sparkText(series)}
        </Text>
      )}
      {list.length === 0 ? <Text dimColor>No activity yet.</Text> : null}
      {list.map(day => {
        const steps = day.entries.filter(x => x.kind !== 'session' && x.kind !== 'agent')
        const sessions = day.entries.filter(x => x.kind === 'session').length
        const agents = day.entries.filter(x => x.kind === 'agent').length
        return (
          <Box key={`day-${day.day}`} flexDirection="column" marginTop={1}>
            {Row(
              els,
              `dh-${day.day}`,
              <Text bold>{day.label}</Text>,
              [day.done ? `✓ ${day.done}` : '', sessions ? `${sessions} sessions` : '', agents ? `${agents} agents` : '']
                .filter(Boolean)
                .join(' · '),
            )}
            {steps.slice(0, 12).map((x, i) =>
              Row(
                els,
                `de-${day.day}-${i}`,
                Line(els, `de-line-${day.day}-${i}`, [
                  { text: `${KIND[x.kind]?.icon ?? '·'} `, color: KIND[x.kind]?.color },
                  { text: x.text, main: true, dim: x.kind === 'started' },
                ]),
                when(x.at, d.now, d.tz),
              ),
            )}
            {steps.length > 12 ? <Text dimColor>{`  … ${steps.length - 12} more`}</Text> : null}
            {steps.length === 0 ? <Text dimColor>{`  ${sessions} sessions, no step moved`}</Text> : null}
          </Box>
        )
      })}
    </Box>
  )
}

function backlogView(els: Els, d: PaneData) {
  const { Box, Text } = els
  const shelved = d.board.tracks.filter(t => !t.archived).flatMap(t => t.steps.filter(s => s.backlog).map(s => ({ t, s })))
  shelved.sort((a, b) => byPriority(a.s, b.s))
  const shelvedTracks = d.board.tracks.filter(t => t.backlog && !t.archived)
  const archivedTracks = d.board.tracks.filter(t => t.archived)
  if (shelved.length === 0 && shelvedTracks.length === 0 && archivedTracks.length === 0) {
    return (
      <Box key="backlog" flexDirection="column">
        <Text dimColor>The backlog is empty. Hover a step and press "Backlog" to set it aside; "↺ Restore" brings it back.</Text>
      </Box>
    )
  }
  return (
    <Box key="backlog" flexDirection="column">
      <Text dimColor>Set aside: not counted in progress, not offered to agents as next work.</Text>
      {shelvedTracks.length ? (
        <Box key="bl-tracks" flexDirection="column" marginTop={1}>
          <Text bold>Tracks</Text>
          {shelvedTracks.map(t => trackCard(els, d, t))}
        </Box>
      ) : null}
      {shelved.length ? <Text bold>Steps</Text> : null}
      {shelved.map(({ t, s }) => (
        <Box key={`bl-${t.name}/${s.id}`} flexDirection="column" marginTop={1}>
          <Text dimColor wrap="truncate-end">{t.title}</Text>
          {stepRow(els, d, t, s)}
        </Box>
      ))}
      {archivedTracks.length ? (
        <Box key="bl-archived" flexDirection="column" marginTop={1}>
          <Text bold>Archived</Text>
          <Text dimColor>Closed by you: hidden from the list, the status line and the agents. ↺ Unarchive brings one back.</Text>
          {archivedTracks.map(t => trackCard(els, d, t))}
        </Box>
      ) : null}
    </Box>
  )
}

export function drawPane(els: Els, d: PaneData) {
  const { Box, Text } = els
  if (d.board.tracks.length === 0 && d.board.sessions.length === 0) {
    return (
      <Box flexDirection="column">
        {header(els, d)}
        <Text dimColor>No tracks yet. Ask Claude to lay one out, e.g. "add a roadmap track for the API work".</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {header(els, d)}
      {thisChat(els, d)}
      {needsYou(els, d)}
      {d.view === 'days'
        ? daysView(els, d)
        : d.view === 'backlog'
          ? backlogView(els, d)
          : d.board.tracks
              .filter(t => !t.backlog && !t.archived)
              .sort((a, b) => Number(b.name === d.focus.split('/')[0]) - Number(a.name === d.focus.split('/')[0]))
              .map(t => trackCard(els, d, t))}
      {d.view === 'tracks' ? liveSection(els, d) : null}
    </Box>
  )
}

/** One line above the prompt: the tracks at a glance and the pane's toggle. */
export function drawBand(
  els: Els,
  d: { board: RoadmapBoard; isOpen: boolean; cols: number; onToggle: () => void; focus?: string },
) {
  const { Box, Text, Button } = els
  const needs = attention(d.board)
  const [ft, ...fid] = (d.focus ?? '').split('/')
  const held = d.focus ? d.board.tracks.find(t => t.name === ft)?.steps.find(s => s.id === fid.join('/')) : undefined
  const tracks = d.board.tracks
    .filter(t => !t.backlog && !t.archived)
    .map(t => {
      const { done, total } = progress(t)
      return `${t.name} ${total ? Math.round((done / total) * 100) : 0}%`
    })
    .join(' · ')
  return (
    <Box flexDirection="row" gap={1}>
      <Button key="band-toggle" plain variant="primary" onPress={() => d.onToggle()}>
        {d.isOpen ? '▾ Roadmap' : '▸ Roadmap'}
      </Button>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        {held ? (
          Line(els, 'band-line', [
            { text: 'this chat ', color: 'warning' },
            { text: `${ICONS[held.status]} `, color: COLOR[held.status] },
            { text: `${d.focus}  ${held.title}`, main: true },
          ])
        ) : (
          <Text dimColor wrap="truncate-end">
            {tracks || 'no tracks yet'}
          </Text>
        )}
      </Box>
      {needs.awaiting.length ? <Text color="permission">{`◆ ${needs.awaiting.length}`}</Text> : null}
    </Box>
  )
}
