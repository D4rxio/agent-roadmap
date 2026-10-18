import { expect, test } from 'claude-code/testing'

import { checkMove, doneAction, markAction, planAction, reviewAction, statusAction, stepAction } from '../hooks/actions'
import { inTime, versionAtLeast } from '../hooks/register'
import { chainSvg, matches, whoseReview } from '../hooks/view'

import { FOLLOW_UPS, STALE_MS, YOUR_PHASE, attention, boardMarkdown, chainGraph, chainText, forProject, mermaidOf, workingIn, brief, nextId, dayLabel, dayOf, days, family, findCycle, fold, progress, parseRef, refInText, summary, timelineBar, trackMarkdown, when } from '../hooks/model'
import type { RoadmapEvent } from '../types'

const PANE = {
  plugin: 'roadmap',
  component: 'Pane',
  requestId: 'roadmap',
  props: {
    title: 'Roadmap',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const PLAN: RoadmapEvent = {
  kind: 'plan',
  at: 1000,
  session: 's1',
  track: 'api',
  title: 'API v2',
  phases: [{ name: 'Discovery', steps: [{ id: '1.1', title: 'Map endpoints' }, { id: '1.2', title: 'Pagination' }] }],
}

test('the journal folds the same in any order, duplicates change nothing', async () => {
  const events: RoadmapEvent[] = [
    PLAN,
    { kind: 'agent', at: 2000, session: 's2', agentId: 'a1', description: 'x', type: 'Explore', track: 'api', step: '1.1' },
    { kind: 'agent-end', at: 3000, session: 's2', agentId: 'a1', status: 'done' },
    { kind: 'step', at: 2500, session: 's3', track: 'api', id: '1.2', status: 'running' },
  ]
  const a = fold(events, [], 5000)
  const b = fold([...events].reverse().concat(events), [], 5000)
  expect(JSON.stringify(b.tracks)).toBe(JSON.stringify(a.tracks))
  const steps = a.tracks[0]?.steps ?? []
  expect(steps.find(s => s.id === '1.1')?.status).toBe('done')
  expect(steps.find(s => s.id === '1.1')?.endedAt).toBe(3000)
  expect(steps.find(s => s.id === '1.2')?.status).toBe('running')
  expect(a.sessions.length).toBe(3)

  expect(parseRef('#api/1.2', a.tracks)).toEqual({ track: 'api', id: '1.2' })
  expect(parseRef('1.2', a.tracks)).toEqual({ track: 'api', id: '1.2' })
  expect(refInText('#api/1.1 map it', a.tracks)).toEqual({ track: 'api', id: '1.1' })
  expect(refInText('#api/9.9 nope', a.tracks)).toBe(undefined)
  expect(summary(a)).toContain('api/1.2')

  const bar = timelineBar(0, 100, 50, 100, 10)
  expect(bar.before + bar.bar + bar.after).toBe('·····━━━━━')
})

test('sessions share one board through the journal; an agent ticks its step', async ($, on) => {
  const files = new Map<string, string>()
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-one' }))
  on('agent.spawn', () => ({ model: 'test-model', agentId: 'ag1' }))
  on('agent.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('classic.SubagentStop', () => ({}))
  on('session.start', (_$, e) => e)

  // Another session already laid out a track: it is only on disk.
  files.set('/home/t/.claude/roadmap/events/1000-other-x.json', JSON.stringify(PLAN))

  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)

  await $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'go',
    description: '#api/1.1 map the endpoints',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'test-model',
    background: true,
    fork: false,
  })
  await $.tool.call({ tool: 'mcp__roadmap__mark', step: 'api/1.2', status: 'running' })
  await $.classic.SubagentStop({ stop_hook_active: false, agent_id: 'ag1', agent_transcript_path: '', agent_type: 'Explore' })

  // Every write is a file of its own in the shared journal.
  expect([...files.keys()].filter(p => p.includes('/events/')).length).toBe(4)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /API v2/ })).toBeDefined()
    expect(await ui.find({ text: /1\/2/ })).toBeDefined()
    // The agent tagged #api/1.1, so this chat holds it: its track starts open.
    expect(await ui.find({ text: /This chat/ })).toBeDefined()
    expect(await ui.find({ text: /Map endpoints/ })).toBeDefined()
    await ui.press({ key: 'fold-api' })
    expect(await ui.find({ text: /Map endpoints/ })).toBe(undefined)
    await ui.press({ key: 'fold-api' })
    await ui.press({ key: 'view-days' })
    expect(await ui.find({ text: /Today/ })).toBeDefined()
    expect(await ui.find({ text: /api\/1\.1 Map endpoints/ })).toBeDefined()
    await ui.press({ key: 'view-tracks' })
    await ui.unmount()
  }
})

test('a worker reports, the person closes: checkpoints and reopened failures await, blockers block', async () => {
  const plan: RoadmapEvent = {
    kind: 'plan',
    at: 1,
    session: 's',
    track: 'web',
    phases: [
      {
        name: 'Verify',
        steps: [
          { id: '1', title: 'Tests' },
          { id: '2', title: 'Prod check', checkpoint: true, blockedBy: ['1'] },
          { id: '3', title: 'Retry' },
        ],
      },
    ],
  }
  const step = (at: number, id: string, status: 'done' | 'failed' | 'running', origin?: 'person' | 'agent') =>
    ({ kind: 'step', at, session: 's', track: 'web', id, status, origin }) as RoadmapEvent
  const steps = (events: RoadmapEvent[]) => fold(events, [], 100).tracks[0]?.steps ?? []
  const status = (events: RoadmapEvent[], id: string) => steps(events).find(x => x.id === id)?.status

  expect(status([plan], '2')).toBe('blocked')
  expect(status([plan, step(2, '1', 'done')], '2')).toBe('todo')
  expect(status([plan, step(2, '1', 'done'), step(3, '2', 'done')], '2')).toBe('awaiting')
  expect(status([plan, step(2, '1', 'done'), step(3, '2', 'done'), step(4, '2', 'done', 'person')], '2')).toBe('done')
  expect(status([plan, step(2, '3', 'failed'), step(3, '3', 'done')], '3')).toBe('awaiting')
  expect(status([plan, step(2, '3', 'failed'), step(3, '3', 'done', 'person')], '3')).toBe('done')
  expect(status([plan, step(2, '1', 'done')], '1')).toBe('done')
})

test('the person confirms an awaiting checkpoint from the pane', async ($, on) => {
  const files = new Map<string, string>()
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-two' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)

  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)
  await $.tool.call({
    tool: 'mcp__roadmap__plan',
    review: { required: false },
    track: 'release',
    title: 'Release',
    phases: [{ name: 'Release', steps: [{ id: '1', title: 'Activate in prod', checkpoint: true }] }],
  })
  const reported = await $.tool.call({ tool: 'mcp__roadmap__mark', step: 'release/1', status: 'done', evidence: 'smoke ok' })
  expect(String(reported.result)).toContain('awaiting')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /1 to confirm/ })).toBeDefined()
  await ui.press({ key: 'ok-release-1' })
  expect(await ui.find({ text: /0 to confirm/ })).toBe(undefined)
  expect(await ui.find({ text: /100%/ })).toBeDefined()
  await ui.unmount()
})

test('days, relative times and the Markdown copy of a track', async () => {
  const DAY = 86_400_000
  const now = 20 * DAY + 10 * 3_600_000
  const b = fold(
    [
      PLAN,
      { kind: 'step', at: now - DAY, session: 's', track: 'api', id: '1.1', status: 'done', evidence: 'PR #1' },
      { kind: 'step', at: now - 60_000, session: 's', track: 'api', id: '1.2', status: 'running' },
    ],
    [],
    now,
  )
  expect(dayLabel(dayOf(now, 0), dayOf(now, 0))).toBe('Today')
  expect(dayLabel(dayOf(now - DAY, 0), dayOf(now, 0))).toBe('Yesterday')
  expect(when(now - DAY, now, 0)).toBe('yesterday')
  expect(when(now - 3 * DAY, now, 0)).toBe('3d ago')
  expect(when(now, now, 120)).toBe('12:00')
  const list = days(b, now, 0)
  expect(list[0]?.label).toBe('Today')
  expect(list.find(d => d.label === 'Yesterday')?.done).toBe(1)
  const md = trackMarkdown(b.tracks[0]!, now, 0)
  expect(md).toContain('## API v2 — 50% (1/2)')
  expect(md).toContain('- [x] api/1.1 Map endpoints — PR #1; yesterday')
  expect(md).toContain('- [ ] api/1.2 Pagination — running')
})

test('the band toggles the pane and ⧉ copies a track as Markdown', async ($, on) => {
  const files = new Map<string, string>([['/home/t/.claude/roadmap/events/1000-o-x.json', JSON.stringify(PLAN)]])
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  let open = false
  const copied: string[] = []
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-three' }))
  on('store.get', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '+0200\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.panes', () => ({ value: open ? [{ id: 'roadmap', title: 'Roadmap' } as never] : [] }))
  on('ui.open', () => {
    open = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    open = false
    return { value: undefined }
  })
  on('ui.copy', (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)

  const band = await $.ui.mount({
    plugin: 'roadmap',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 5 } } as never,
  })
  expect(await band.find({ text: /api 0%/ })).toBeDefined()
  await band.press({ key: 'band-toggle' })
  expect(open).toBe(true)
  await band.press({ key: 'band-toggle' })
  expect(open).toBe(false)
  await band.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'fold-api' })
  await ui.press({ key: 'copy-api' })
  expect(copied[0]).toContain('## API v2 — 0% (0/2)')
  await ui.unmount()
})

test("the person's items survive a re-laid plan; an agent may refine them; removal holds", async () => {
  const add: RoadmapEvent = { kind: 'add', at: 2000, session: 'p', track: 'api', id: 'u1', title: 'test on iPad', origin: 'person' }
  const relaid: RoadmapEvent = { ...PLAN, at: 3000 } as RoadmapEvent
  const steps = (events: RoadmapEvent[]) => fold(events, [], 9000).tracks[0]?.steps ?? []
  const phases = (events: RoadmapEvent[]) => fold(events, [], 9000).tracks[0]?.phases ?? []

  // An agent re-lays the track without it: the item is still there, in "Your items", marked.
  const kept = steps([PLAN, add, relaid]).find(x => x.id === 'u1')
  expect(kept?.title).toBe('test on iPad')
  expect(kept?.addedBy).toBe('you')
  expect(phases([PLAN, add, relaid]).at(-1)?.name).toBe(YOUR_PHASE)

  // An agent moves it into a phase with a better title: its words win, the mark stays.
  const refined = {
    ...PLAN,
    at: 4000,
    phases: [{ name: 'Discovery', steps: [{ id: '1.1', title: 'Map endpoints' }, { id: 'u1', title: 'Test web on iPad Safari' }] }],
  } as RoadmapEvent
  const moved = steps([PLAN, add, refined]).find(x => x.id === 'u1')
  expect(moved?.title).toBe('Test web on iPad Safari')
  expect(moved?.addedBy).toBe('you')
  expect(phases([PLAN, add, refined]).some(p => p.name === YOUR_PHASE)).toBe(false)

  // The person renames it later: the latest word wins, in any order.
  const rename: RoadmapEvent = { kind: 'edit', at: 5000, session: 'p', track: 'api', id: 'u1', title: 'iPad + iPhone', origin: 'person' }
  expect(steps([rename, refined, add, PLAN]).find(x => x.id === 'u1')?.title).toBe('iPad + iPhone')

  // Removed: gone, and a status on it changes nothing.
  const removed: RoadmapEvent = { kind: 'edit', at: 6000, session: 'p', track: 'api', id: 'u1', removed: true, origin: 'person' }
  expect(steps([PLAN, add, removed]).some(x => x.id === 'u1')).toBe(false)
  expect(phases([PLAN, add, removed]).some(p => p.name === YOUR_PHASE)).toBe(false)
})

test('from the pane: add an item, click its icon through the states, rename it, remove it', async ($, on) => {
  const files = new Map<string, string>([['/home/t/.claude/roadmap/events/1000-o-x.json', JSON.stringify(PLAN)]])
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-four' }))
  on('store.get', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'fold-api' })
  await ui.input({ key: 'add-api', text: 'test on iPad' })
  const added = await ui.find({ text: /u\w{5} {2}test on iPad/ })
  expect(added).toBeDefined()
  const uid = /(u\w{5}) {2}test/.exec(added?.text ?? '')?.[1] ?? ''
  expect(await ui.find({ text: /✎ you/ })).toBeDefined()

  await ui.press({ key: `cycle-api/${uid}` })
  expect(await ui.find({ text: /running|for / })).toBeDefined()
  await ui.press({ key: `cycle-api/${uid}` })
  expect(await ui.find({ text: /33%/ })).toBeDefined()

  // Its phase is finished now, so it closed; open it again to rename the item.
  await ui.press({ key: 'phasefold-api::Your items' })
  await ui.press({ key: `rename-api/${uid}` })
  await ui.input({ key: `edit-api/${uid}`, text: 'iPad + iPhone' })
  expect(await ui.find({ text: new RegExp(`${uid} {2}iPad \\+ iPhone`) })).toBeDefined()

  await ui.press({ key: `remove-api/${uid}` })
  expect(await ui.find({ text: /iPad/ })).toBe(undefined)
  expect(await ui.find({ text: /0%/ })).toBeDefined()
  await ui.unmount()
})

test('/roadmap show and /roadmap hide open and close the pane, whatever its state', async ($, on) => {
  let open = false
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-five' }))
  on('store.get', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.panes', () => ({ value: open ? [{ id: 'roadmap', title: 'Roadmap' } as never] : [] }))
  on('ui.open', () => {
    open = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    open = false
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)

  const run = (args: string) => $.command.run({ command: 'roadmap', args } as never)
  await run('show')
  expect(open).toBe(true)
  await run('show')
  expect(open).toBe(true)
  await run('hide')
  expect(open).toBe(false)
  await run('hide')
  expect(open).toBe(false)
  await run('')
  expect(open).toBe(true)
})

test("priority and backlog: the person's word stands over an agent's; backlog leaves progress and next work", async () => {
  const tri = (at: number, id: string, change: object, origin: 'person' | 'agent') =>
    ({ kind: 'triage', at, session: origin, track: 'api', id, ...change, origin }) as RoadmapEvent
  const steps = (events: RoadmapEvent[]) => fold(events, [], 9000).tracks[0]?.steps ?? []
  const get = (events: RoadmapEvent[], id: string) => steps(events).find(x => x.id === id)

  expect(get([PLAN, tri(2000, '1.2', { priority: 'P1' }, 'agent')], '1.2')?.priority).toBe('P1')
  // The person set P3; a later agent proposal does not override it, in any order.
  const mixed = [PLAN, tri(2000, '1.2', { priority: 'P3' }, 'person'), tri(3000, '1.2', { priority: 'P0' }, 'agent')]
  expect(get(mixed, '1.2')?.priority).toBe('P3')
  expect(get([...mixed].reverse(), '1.2')?.priority).toBe('P3')
  expect(get(mixed, '1.2')?.triagedBy).toBe('you')
  // The person may change their own mind; null clears.
  expect(get([...mixed, tri(4000, '1.2', { priority: null }, 'person')], '1.2')?.priority).toBe(undefined)

  // Backlog: kept with its status, out of progress and out of the open list; restore brings it back.
  const started: RoadmapEvent = { kind: 'step', at: 1500, session: 's', track: 'api', id: '1.1', status: 'running' }
  const shelved = [PLAN, started, tri(2000, '1.1', { backlog: true }, 'person')]
  const b = fold(shelved, [], 9000)
  expect(b.tracks[0]?.steps.find(x => x.id === '1.1')?.status).toBe('running')
  expect(b.tracks[0] && progress(b.tracks[0]).total).toBe(1)
  expect(summary(b)).toContain('backlog (set aside, not to work on unless asked): api/1.1')
  expect(summary(b)).not.toContain('◐ api/1.1')
  const restored = fold([...shelved, tri(3000, '1.1', { backlog: false }, 'person')], [], 9000)
  expect(restored.tracks[0]?.steps.find(x => x.id === '1.1')?.backlog).toBe(false)
  expect(restored.tracks[0] && progress(restored.tracks[0]).total).toBe(2)

  // Open work is listed P0 first.
  const ranked = fold([PLAN, tri(2000, '1.2', { priority: 'P0' }, 'person')], [], 9000)
  const text = summary(ranked)
  expect(text.indexOf('api/1.2')).toBeLessThan(text.indexOf('api/1.1'))
  expect(text).toContain('P0 api/1.2')
})

test('from the pane: the chip raises priority, ⤓ sets a step aside, the Backlog tab restores it', async ($, on) => {
  const files = new Map<string, string>([['/home/t/.claude/roadmap/events/1000-o-x.json', JSON.stringify(PLAN)]])
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-six' }))
  on('store.get', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)

  // An agent proposes P2 through the tool; the person then raises it twice from the pane.
  await $.tool.call({ tool: 'mcp__roadmap__mark', step: 'api/1.2', priority: 'P2' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'fold-api' })
  expect(await ui.find({ text: /^P2$/ })).toBeDefined()
  await ui.press({ key: 'prio-api/1.2' })
  await ui.press({ key: 'prio-api/1.2' })
  expect(await ui.find({ text: /^P0$/ })).toBeDefined()
  const agentAgain = await $.tool.call({ tool: 'mcp__roadmap__mark', step: 'api/1.2', priority: 'P3' })
  expect(String(agentAgain.result)).toContain("the person's own choice stands")
  expect(await ui.find({ text: /^P0$/ })).toBeDefined()

  // ⤓ sets 1.1 aside: 0/1 and a Backlog section; the Backlog tab restores it.
  await ui.press({ key: 'shelve-api/1.1' })
  expect(await ui.find({ text: /0\/1/ })).toBeDefined()
  expect(await ui.find({ text: /Backlog 1/ })).toBeDefined()
  await ui.press({ key: 'view-backlog' })
  expect(await ui.find({ text: /1\.1 {2}Map endpoints/ })).toBeDefined()
  await ui.press({ key: 'shelve-api/1.1' })
  expect(await ui.find({ text: /backlog is empty/ })).toBeDefined()
  await ui.press({ key: 'view-tracks' })
  expect(await ui.find({ text: /0\/2/ })).toBeDefined()
  await ui.unmount()
})

test('a whole track goes to the backlog and back; its priority orders the tracks; the person wins', async () => {
  const other = { ...PLAN, track: 'docs', title: 'Docs', at: 1100 } as RoadmapEvent
  const tri = (at: number, track: string, change: object, origin: 'person' | 'agent') =>
    ({ kind: 'triage', at, session: origin, track, ...change, origin }) as RoadmapEvent
  const names = (events: RoadmapEvent[]) => fold(events, [], 9000).tracks.map(t => t.name)

  // Newest first by default; a priority lifts a track above unprioritized ones.
  expect(names([PLAN, other])).toEqual(['docs', 'api'])
  expect(names([PLAN, other, tri(2000, 'api', { priority: 'P1' }, 'person')])).toEqual(['api', 'docs'])

  // The whole track set aside: out of the next-work summary, listed apart; restore brings it back.
  const shelved = fold([PLAN, other, tri(2000, 'api', { backlog: true }, 'person')], [], 9000)
  expect(shelved.tracks.find(t => t.name === 'api')?.backlog).toBe(true)
  expect(summary(shelved)).not.toContain('api/1.1')
  expect(summary(shelved)).toContain('tracks in backlog (set aside whole, not to work on unless asked): api')
  const back = fold([PLAN, other, tri(2000, 'api', { backlog: true }, 'person'), tri(3000, 'api', { backlog: false }, 'person')], [], 9000)
  expect(back.tracks.find(t => t.name === 'api')?.backlog).toBe(false)

  // An agent cannot pull a track the person shelved back into play.
  const agentTry = fold([PLAN, tri(2000, 'api', { backlog: true }, 'person'), tri(3000, 'api', { backlog: false }, 'agent')], [], 9000)
  expect(agentTry.tracks[0]?.backlog).toBe(true)
})

test('from the pane: a track goes to the backlog tab and is restored from there', async ($, on) => {
  const files = new Map<string, string>([['/home/t/.claude/roadmap/events/1000-o-x.json', JSON.stringify(PLAN)]])
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-seven' }))
  on('store.get', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tprio-api' })
    expect(await ui.find({ text: /^P3$/ })).toBeDefined()
    await ui.press({ key: 'tshelve-api' })
    expect(await ui.find({ text: /API v2/ })).toBe(undefined)
    await ui.press({ key: 'view-backlog' })
    expect(await ui.find({ text: /API v2/ })).toBeDefined()
    await ui.press({ key: 'trestore-api' })
    expect(await ui.find({ text: /backlog is empty/ })).toBeDefined()
    await ui.press({ key: 'view-tracks' })
    expect(await ui.find({ text: /API v2/ })).toBeDefined()
    await ui.press({ key: 'tprio-api' })
    await ui.press({ key: 'tprio-api' })
    await ui.press({ key: 'tprio-api' })
    await ui.press({ key: 'tprio-api' })
    await ui.unmount()
  }
})

test('a dependency loop is found across tracks; a brief tells why, scope, done-when and what waits', async () => {
  const lay = (track: string, steps: object[], at = 1000) =>
    ({ kind: 'plan', at, session: 's', track, phases: [{ name: 'P', steps }] }) as RoadmapEvent
  const ok = fold([lay('a', [{ id: '1', title: 'A1' }, { id: '2', title: 'A2', blockedBy: ['1'] }])], [], 9000)
  expect(findCycle(ok.tracks)).toBe(undefined)
  const loop = fold(
    [
      lay('a', [{ id: '1', title: 'A1', blockedBy: ['b/1'] }]),
      lay('b', [{ id: '1', title: 'B1', blockedBy: ['a/1'] }]),
    ],
    [],
    9000,
  )
  expect(findCycle(loop.tracks)?.join(' → ')).toBe('a/1 → b/1 → a/1')

  const b = fold(
    [
      lay('a', [
        { id: '1', title: 'Schema', why: 'clients need one shape', scope: 'no DB changes', doneWhen: 'contract tests green' },
        { id: '2', title: 'Client', blockedBy: ['1'] },
      ]),
    ],
    [],
    9000,
  )
  const text = brief(b, 'a', '1') ?? ''
  expect(text).toContain('Why: clients need one shape')
  expect(text).toContain('Scope: no DB changes')
  expect(text).toContain('Done when: contract tests green')
  expect(text).toContain('Unblocks:')
  expect(text).toContain('a/2 Client')
  expect(brief(b, 'a', '2') ?? '').toContain('Waits on:')
  expect(brief(b, 'a', '2') ?? '').toContain('Done when: (not written')
})

test('roadmap plan refuses a loop; roadmap step reads the brief; roadmap done reports and files follow-ups', async ($, on) => {
  const files = new Map<string, string>()
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-eight' }))
  on('store.get', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)

  const looped = await $.tool.call({
    tool: 'mcp__roadmap__plan',
    review: { required: false },
    track: 'web',
    phases: [{ name: 'Build', steps: [{ id: '1', title: 'A', blocked_by: ['2'] }, { id: '2', title: 'B', blocked_by: ['1'] }] }],
  })
  expect(String(looped.result)).toContain('Not laid out')
  expect([...files.keys()].filter(p => p.includes('/events/')).length).toBe(0)

  await $.tool.call({
    tool: 'mcp__roadmap__plan',
    review: { required: false },
    track: 'web',
    phases: [
      {
        name: 'Build',
        steps: [
          { id: '1', title: 'Login page', why: 'users cannot sign in', scope: 'no API changes', done_when: 'e2e login passes' },
          { id: '2', title: 'Ship', checkpoint: true, blocked_by: ['1'] },
        ],
      },
    ],
  })
  const read1 = await $.tool.call({ tool: 'mcp__roadmap__step', step: 'web/1' })
  expect(String(read1.result)).toContain('Done when: e2e login passes')

  const closed = await $.tool.call({
    tool: 'mcp__roadmap__done',
    step: 'web/1',
    shipped: 'login page with remember-me',
    evidence: 'e2e 12/12',
    follow_ups: [{ title: 'Rate-limit login', priority: 'P1' }, { title: 'Password reset' }],
  })
  expect(String(closed.result)).toContain('web/1 → done')
  const f1 = /web\/(f\w{5}) Rate-limit login/.exec(String(closed.result))?.[1]
  const f2 = /web\/(f\w{5}) Password reset/.exec(String(closed.result))?.[1]
  expect(f1).toBeDefined()
  expect(f2).toBeDefined()
  expect(f1).not.toBe(f2)

  const shipped = await $.tool.call({ tool: 'mcp__roadmap__done', step: 'web/2', shipped: 'released' })
  expect(String(shipped.result)).toContain('awaiting')

  // Follow-ups: in their own phase, in the backlog, with the proposed priority; a re-lay keeps them.
  await $.tool.call({
    tool: 'mcp__roadmap__plan',
    review: { required: false },
    track: 'web',
    phases: [{ name: 'Build', steps: [{ id: '1', title: 'Login page' }, { id: '2', title: 'Ship', checkpoint: true }] }],
  })
  const status = String((await $.tool.call({ tool: 'mcp__roadmap__step', step: `web/${f1}` })).result)
  expect(status).toContain(`phase: ${FOLLOW_UPS}`)
  expect(status).toContain('priority P1')
  expect(status).toContain('IN BACKLOG')
})

test('old loose events are archived into one bundle and deleted; the roadmap reads the same', async ($, on) => {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  const removed: string[] = []
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, { text: e.text, mtimeMs: Date.now() })
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path)?.text ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({
      name,
      kind: 'file' as const,
      size: 1,
      mtimeMs: files.get(`${e.path}/${name}`)?.mtimeMs ?? 0,
      isLink: false,
    })),
  }))
  on('process.run', (_$, e) => {
    const argv = e.argv as readonly string[]
    if (argv[0] === 'rm') for (const path of argv.slice(3)) if (files.delete(path)) removed.push(path)
    return { value: { exitCode: argv[0] === 'rm' ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-nine' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)

  const dir = '/home/t/.claude/roadmap'
  const old = Date.now() - 3 * 86_400_000
  const put = (at: number, ev: object, tag: string) =>
    files.set(`${dir}/events/${at}-${tag}.json`, { text: JSON.stringify({ ...ev, at }), mtimeMs: at })
  put(old, { ...PLAN }, 'plan')
  for (let i = 1; i <= 250; i++) {
    put(old + i, { kind: 'step', session: 's', track: 'api', id: i % 2 ? '1.1' : '1.2', status: i === 250 ? 'done' : 'running' }, `s${i}`)
  }
  // Two fresh events stay loose.
  put(Date.now() - 1000, { kind: 'step', session: 's', track: 'api', id: '1.1', status: 'done' }, 'fresh1')
  put(Date.now() - 500, { kind: 'session', session: 's', title: 'fresh' }, 'fresh2')

  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)

  const bundles = under(`${dir}/archive`)
  expect(bundles.length).toBe(1)
  const lines = (files.get(`${dir}/archive/${bundles[0]}`)?.text ?? '').trim().split('\n')
  expect(lines.length).toBe(252)
  expect(JSON.parse(lines[0] ?? '{}')).toEqual({ bundle: 1, count: 251 })
  expect(removed.length).toBe(251)
  expect(under(`${dir}/events`).length).toBe(2)

  // The roadmap reads the same from the bundle plus the two loose files.
  const read = String((await $.tool.call({ tool: 'mcp__roadmap__status' })).result)
  expect(read).toContain('2/2 done')
})

test('each chat holds its item: the pane leads with it, others see who holds what, a brief warns', async ($, on) => {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, { text: e.text, mtimeMs: Date.now() })
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path)?.text ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: files.get(`${e.path}/${name}`)?.mtimeMs ?? 0, isLink: false })),
  }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-ten' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  const dir = '/home/t/.claude/roadmap'
  files.set(`${dir}/events/1000-o-x.json`, { text: JSON.stringify(PLAN), mtimeMs: 1000 })
  // Another chat, live now, holds api/1.2.
  files.set(`${dir}/live/other.json`, {
    text: JSON.stringify({ session: 'other', title: 'empty-trash fix', at: Date.now(), agents: [], focus: 'api/1.2' }),
    mtimeMs: Date.now(),
  })
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)

  // This chat reads 1.1's brief: it now holds 1.1.
  await $.tool.call({ tool: 'mcp__roadmap__step', step: 'api/1.1' })
  const warned = String((await $.tool.call({ tool: 'mcp__roadmap__step', step: 'api/1.2' })).result)
  expect(warned).toContain('Another chat holds this step right now: "empty-trash fix"')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /This chat/ })).toBeDefined()
    expect(await ui.find({ text: /● empty-trash fix/ })).toBeDefined()
    expect(await ui.find({ text: /● this chat/ })).toBeDefined()
    expect(await ui.find({ text: /api\/1\.1 {2}Map endpoints/ })).toBeDefined()
    await ui.press({ key: 'pin-api/1.2' })
    expect(await ui.find({ text: /api\/1\.2 {2}Pagination/ })).toBeDefined()
    await ui.press({ key: 'unpin' })
    expect(await ui.find({ text: /This chat/ })).toBe(undefined)
    await ui.press({ key: 'pin-api/1.1' })
    expect(await ui.find({ text: /api\/1\.1 {2}Map endpoints/ })).toBeDefined()
    await ui.unmount()
  }
  // The heartbeat tells the other chats.
  const mine = JSON.parse(files.get(`${dir}/live/session-ten.json`)?.text ?? '{}')
  expect(mine.focus).toBe('api/1.1')
})

test('two chats adding at once cannot collide on an id', async () => {
  const b = fold([PLAN], [], 9000)
  const t = b.tracks[0]!
  // Two chats drawing at the same moment, many times over: never the same id.
  for (let i = 0; i < 5000; i++) expect(nextId(t, [], 'f')).not.toBe(nextId(t, [], 'f'))
  const ids = new Set(Array.from({ length: 50 }, () => nextId(t, [], 'f')))
  expect([...ids].every(id => /^f[0-9a-z]{5}$/.test(id))).toBe(true)
  // Existing ids are never reused.
  expect(t.steps.some(s => ids.has(s.id))).toBe(false)
})

test('a bundle read while it is still being written is read again until complete', async ($, on) => {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, { text: e.text, mtimeMs: Date.now() })
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path)?.text ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-eleven' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  const dir = '/home/t/.claude/roadmap'
  const rows = [
    { n: '1-a-x.json', e: { ...PLAN, at: 1 } },
    { n: '2-a-x.json', e: { kind: 'step', at: 2, session: 's', track: 'api', id: '1.1', status: 'done' } },
    { n: '3-a-x.json', e: { kind: 'step', at: 3, session: 's', track: 'api', id: '1.2', status: 'done' } },
  ]
  const write = (count: number) =>
    files.set(`${dir}/archive/1-a-x.jsonl`, {
      text: [JSON.stringify({ bundle: 1, count: 3 }), ...rows.slice(0, count).map(r => JSON.stringify(r))].join('\n'),
      mtimeMs: 0,
    })
  write(2) // caught mid-write: the last event is not in yet
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)
  expect(String((await $.tool.call({ tool: 'mcp__roadmap__status' })).result)).toContain('1/2 done')
  write(3) // the writer finished; the loose files are already gone
  expect(String((await $.tool.call({ tool: 'mcp__roadmap__status' })).result)).toContain('2/2 done')
})

test('skipped: the person decides it with a reason, it leaves progress and unblocks; an agent only proposes', async () => {
  const plan = {
    kind: 'plan',
    at: 1,
    session: 's',
    track: 'web',
    phases: [{ name: 'P', steps: [{ id: '1', title: 'Legacy export' }, { id: '2', title: 'New export', blockedBy: ['1'] }, { id: '3', title: 'Docs' }] }],
  } as RoadmapEvent
  const step = (at: number, id: string, status: string, origin: 'person' | 'agent', reason?: string) =>
    ({ kind: 'step', at, session: origin, track: 'web', id, status, reason, origin }) as RoadmapEvent
  const get = (events: RoadmapEvent[], id: string) => fold(events, [], 9000).tracks[0]?.steps.find(x => x.id === id)

  // The person skips 1: skipped with its reason, out of progress, and 2 is no longer blocked by it.
  const skipped = [plan, step(2, '1', 'skipped', 'person', 'nobody uses it')]
  expect(get(skipped, '1')?.status).toBe('skipped')
  expect(get(skipped, '1')?.skipReason).toBe('nobody uses it')
  expect(get(skipped, '2')?.status).toBe('todo')
  expect(get([plan], '2')?.status).toBe('blocked')
  const t = fold(skipped, [], 9000).tracks[0]!
  expect(progress(t)).toEqual({ done: 0, total: 2 })
  expect(summary(fold(skipped, [], 9000))).toContain('skipped (decided not to do): web/1 — nobody uses it')

  // An agent's skip is a proposal: awaiting, with its reason, and still blocking its dependents.
  const proposed = [plan, step(2, '1', 'skipped', 'agent', 'superseded by 2')]
  expect(get(proposed, '1')?.status).toBe('awaiting')
  expect(get(proposed, '1')?.proposed).toBe('skipped')
  expect(get(proposed, '1')?.skipReason).toBe('superseded by 2')
  expect(get(proposed, '2')?.status).toBe('blocked')
  // Confirmed by the person (with the reason carried): skipped. Rejected: back to todo.
  expect(get([...proposed, step(3, '1', 'skipped', 'person', 'superseded by 2')], '1')?.status).toBe('skipped')
  expect(get([...proposed, step(3, '1', 'todo', 'person')], '1')?.status).toBe('todo')
  // A done proposal on a checkpoint still reads as a done proposal.
  const cp = { ...plan, phases: [{ name: 'P', steps: [{ id: '1', title: 'Ship', checkpoint: true }] }] } as RoadmapEvent
  expect(get([cp, step(2, '1', 'done', 'agent')], '1')?.proposed).toBe('done')
})

test('from the tool and the pane: a skip needs a reason; the person confirms a proposed skip or skips directly', async ($, on) => {
  const files = new Map<string, string>([['/home/t/.claude/roadmap/events/1000-o-x.json', JSON.stringify(PLAN)]])
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-twelve' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)

  const noReason = await $.tool.call({ tool: 'mcp__roadmap__mark', step: 'api/1.1', status: 'skipped' })
  expect(String(noReason.result)).toContain('A skip needs a reason')
  const proposed = await $.tool.call({ tool: 'mcp__roadmap__mark', step: 'api/1.1', status: 'skipped', reason: 'covered by 1.2' })
  expect(String(proposed.result)).toContain('skip proposed')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /proposes skipping: covered by 1\.2/ })).toBeDefined()
  await ui.press({ key: 'ok-api-1.1' })
  expect(await ui.find({ text: /proposes skipping/ })).toBe(undefined)
  await ui.press({ key: 'fold-api' })
  expect(await ui.find({ text: /skipped: covered by 1\.2/ })).toBeDefined() // 1.2 still open, so the phase is too
  expect(await ui.find({ text: /0\/1/ })).toBeDefined()

  // The person skips 1.2 directly, with a reason typed in the row.
  await ui.press({ key: 'skipit-api/1.2' })
  await ui.input({ key: 'skip-api/1.2', text: 'out of scope this quarter' })
  // Both steps are settled now, so the phase closed by default; open it to look.
  expect(await ui.find({ text: /skipped: out of scope this quarter/ })).toBe(undefined)
  await ui.press({ key: 'phasefold-api::Discovery' })
  expect(await ui.find({ text: /skipped: out of scope this quarter/ })).toBeDefined()
  // Clicking a skipped step's icon brings it back.
  await ui.press({ key: 'cycle-api/1.2' })
  expect(await ui.find({ text: /skipped: out of scope/ })).toBe(undefined)
  await ui.unmount()
})

test('engine versions compare by release, a dev suffix ignored', async () => {
  expect(versionAtLeast('2.1.295', '2.1.295')).toBe(true)
  expect(versionAtLeast('2.1.300-dev.20261020.t1.sha1', '2.1.295')).toBe(true)
  expect(versionAtLeast('2.1.287', '2.1.295')).toBe(false)
  expect(versionAtLeast('3.0.0', '2.1.295')).toBe(true)
})

test('Done ✓ marks a step completed in one press, a checkpoint included; done steps offer no Done', async ($, on) => {
  const cp = {
    kind: 'plan',
    at: 1000,
    session: 's',
    track: 'api',
    title: 'API v2',
    phases: [{ name: 'P', steps: [{ id: '1', title: 'Build' }, { id: '2', title: 'Ship', checkpoint: true }] }],
  }
  const files = new Map<string, string>([['/home/t/.claude/roadmap/events/1000-o-x.json', JSON.stringify(cp)]])
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-thirteen' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'fold-api' })
    if (surface === 'terminal') {
      await ui.press({ key: 'done-api/1' })
      expect(await ui.find({ text: /50%/ })).toBeDefined()
      await ui.press({ key: 'done-api/2' })
      expect(await ui.find({ text: /100%/ })).toBeDefined()
      expect(await ui.find({ key: 'done-api/1' })).toBe(undefined)
    } else {
      expect(await ui.find({ text: /100%/ })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('Copy puts a track title, or a step as "#track/id title", on the clipboard without folding', async ($, on) => {
  const files = new Map<string, string>([['/home/t/.claude/roadmap/events/1000-o-x.json', JSON.stringify(PLAN)]])
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  const copied: string[] = []
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.copy', (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-fourteen' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tcopy-api' })
  expect(copied.at(-1)).toBe('API v2')
  expect(await ui.find({ text: /Map endpoints/ })).toBe(undefined)
  await ui.press({ key: 'fold-api' })
  await ui.press({ key: 'scopy-api/1.2' })
  expect(copied.at(-1)).toBe('#api/1.2 Pagination')
  expect(await ui.find({ text: /Map endpoints/ })).toBeDefined()
  await ui.unmount()
})

test('the shared actions hold the rules once, for the Claude tools and the CLI alike', async () => {
  const ctx = (events: RoadmapEvent[], extra: object = {}) => ({ events, lives: [], now: 5000, session: 's1', actor: 'codex', ...extra })
  const laid = planAction(ctx([]), {
    track: 'API',
    review: { required: false },
    phases: [{ name: 'P', steps: [{ id: '1', title: 'A', done_when: 'tests green' }, { id: '2', title: 'B', blocked_by: ['1'] }] }],
  })
  expect(laid.ok).toBe(true)
  expect(laid.emit[0]?.kind).toBe('plan')
  expect(laid.track).toBe('api')
  const events = laid.emit

  const loop = planAction(ctx(events), { track: 'x', review: { required: false }, phases: [{ name: 'P', steps: [{ id: 'a', title: 'A', blocked_by: ['a'] }] }] })
  expect(loop.ok).toBe(false)
  expect(loop.emit.length).toBe(0)

  expect(markAction(ctx(events), { step: 'api/1', status: 'skipped' }).ok).toBe(false)
  const running = markAction(ctx(events), { step: 'api/1', status: 'running' })
  expect(running.focus).toBe('api/1')
  expect((running.emit[0] as { actor?: string }).actor).toBe('codex')

  const read = stepAction(ctx(events), { step: 'api/1' })
  expect(read.text).toContain('Done when: tests green')
  expect(read.focus).toBe('api/1')
  expect(stepAction(ctx(events, { focus: 'api/2' }), { step: 'api/1' }).focus).toBe(undefined)

  const done = doneAction(ctx(events), { step: 'api/1', shipped: 'A', follow_ups: [{ title: 'F1', priority: 'P2' }, { title: 'F2' }] })
  expect(done.emit.filter(e => e.kind === 'add').length).toBe(2)
  expect(done.emit.filter(e => e.kind === 'triage').every(e => (e as { backlog?: boolean }).backlog)).toBe(true)
  expect(doneAction(ctx(events), { step: 'api/1' }).ok).toBe(false)

  const whole = markAction(ctx(events), { step: 'api/*', priority: 'P1' })
  expect(whole.ok).toBe(true)
  expect((whole.emit[0] as { id?: string }).id).toBe(undefined)
})

test('no truncating Text holds styled Texts: every row stays one line, so scrolling stays right', async ($, on) => {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, { text: e.text, mtimeMs: Date.now() })
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path)?.text ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: files.get(`${e.path}/${name}`)?.mtimeMs ?? 0, isLink: false })),
  }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-fifteen' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  const dir = '/home/t/.claude/roadmap'
  const long = 'A very long step title that would wrap onto three lines in a narrow pane if it were allowed to'
  const plan = {
    kind: 'plan',
    at: 1000,
    session: 's',
    track: 'api',
    title: 'API v2',
    phases: [{ name: 'P', steps: [{ id: '1', title: long }, { id: '2', title: long, blockedBy: ['1', 'web/9', 'docs/3'] }] }],
  }
  files.set(`${dir}/events/1000-o-x.json`, { text: JSON.stringify(plan), mtimeMs: 1000 })
  files.set(`${dir}/live/other.json`, {
    text: JSON.stringify({ session: 'other', title: 'a chat with a long title as well', at: Date.now(), agents: [], focus: 'api/1' }),
    mtimeMs: Date.now(),
  })
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)
  await $.tool.call({ tool: 'mcp__roadmap__mark', step: 'api/1', status: 'running' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = await ui.findAll({ type: 'Text' })
  const nested = texts.filter(
    t =>
      String(t.props.wrap ?? '').startsWith('truncate') &&
      t.children.some(c => typeof c === 'object' && c !== null && (c as { type?: string }).type === 'Text'),
  )
  expect(nested.map(t => t.text)).toEqual([])
  expect(await ui.find({ text: /● this chat/ })).toBeDefined()
  expect(await ui.find({ text: /● a chat with a long ti…/ })).toBeDefined()
  await ui.unmount()
})

test('phases with work left start open, finished ones start closed, a hand toggle wins', async ($, on) => {
  const plan = {
    kind: 'plan',
    at: 1000,
    session: 's',
    track: 'api',
    title: 'API v2',
    phases: [
      { name: 'Done phase', steps: [{ id: '1', title: 'Finished A' }, { id: '2', title: 'Skipped B' }] },
      { name: 'Open phase', steps: [{ id: '3', title: 'Still to do' }] },
    ],
  }
  const events = [
    plan,
    { kind: 'step', at: 1100, session: 's', track: 'api', id: '1', status: 'done', origin: 'person' },
    { kind: 'step', at: 1200, session: 's', track: 'api', id: '2', status: 'skipped', reason: 'not needed', origin: 'person' },
  ]
  const files = new Map<string, string>(events.map((e, i) => [`/home/t/.claude/roadmap/events/${1000 + i}-o-x.json`, JSON.stringify(e)]))
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-sixteen' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'fold-api' })
    expect(await ui.find({ text: /Still to do/ })).toBeDefined()
    expect(await ui.find({ text: /Finished A/ })).toBe(undefined)
    await ui.press({ key: 'phasefold-api::Done phase' })
    expect(await ui.find({ text: /Finished A/ })).toBeDefined()
    await ui.press({ key: 'phasefold-api::Open phase' })
    expect(await ui.find({ text: /Still to do/ })).toBe(undefined)
    // Back to the defaults for the next surface.
    await ui.press({ key: 'phasefold-api::Done phase' })
    await ui.press({ key: 'phasefold-api::Open phase' })
    await ui.press({ key: 'fold-api' })
    await ui.unmount()
  }
})

test('archive: the person alone archives a track; it leaves the list and the agents, history keeps it', async () => {
  const other = { ...PLAN, track: 'docs', title: 'Docs', at: 1100 } as RoadmapEvent
  const tri = (at: number, track: string, change: object, origin: 'person' | 'agent') =>
    ({ kind: 'triage', at, session: origin, track, ...change, origin }) as RoadmapEvent
  const archived = fold([PLAN, other, tri(2000, 'api', { archived: true }, 'person')], [], 9000)
  expect(archived.tracks.find(t => t.name === 'api')?.archived).toBe(true)
  expect(summary(archived)).not.toContain('api/1.1')
  expect(summary(archived)).toContain('archived tracks (closed by the person, not to work on): api')
  // An agent cannot archive, nor bring back what the person archived.
  expect(fold([PLAN, tri(2000, 'api', { archived: true }, 'agent')], [], 9000).tracks[0]?.archived).toBe(false)
  const back = fold([PLAN, tri(2000, 'api', { archived: true }, 'person'), tri(3000, 'api', { archived: false }, 'agent')], [], 9000)
  expect(back.tracks[0]?.archived).toBe(true)
  expect(fold([PLAN, tri(2000, 'api', { archived: true }, 'person'), tri(3000, 'api', { archived: false }, 'person')], [], 9000).tracks[0]?.archived).toBe(false)
})

test('stale: running with nobody on it for hours is flagged; a recent holder or a running agent is not', async () => {
  const now = 10 * STALE_MS
  const running = (at: number) => ({ kind: 'step', at, session: 's', track: 'api', id: '1.1', status: 'running', origin: 'agent' }) as RoadmapEvent
  const step = (events: RoadmapEvent[], lives: object[] = []) =>
    fold(events, lives as never, now).tracks[0]?.steps.find(x => x.id === '1.1')
  expect(step([PLAN, running(now - 60_000)])?.stale).toBeFalsy()
  expect(step([PLAN, running(now - 3 * 3_600_000)])?.stale).toBe(true)
  // A chat that held it an hour ago (not live now) keeps it from being stale.
  expect(step([PLAN, running(now - 3 * 3_600_000)], [{ session: 'c', title: 'c', at: now - 3_600_000, agents: [], focus: 'api/1.1' }])?.stale).toBe(false)
  // So does a running agent tagged with it.
  const agent = { kind: 'agent', at: now - 3 * 3_600_000, session: 's', agentId: 'a', description: 'x', type: 'Explore', track: 'api', step: '1.1' } as RoadmapEvent
  expect(step([PLAN, running(now - 3 * 3_600_000), agent])?.stale).toBe(false)
  const b = fold([PLAN, running(now - 3 * 3_600_000)], [], now)
  expect(summary(b)).toContain('(stale: running, but nobody has been on it for hours')
  expect(brief(b, 'api', '1.1')).toContain('Stale: marked running')
})

test('from the pane: archive a finished track, find it under Archived, bring it back; a stale step offers its way out', async ($, on) => {
  const old = Date.now() - 3 * 3_600_000
  const events = [
    PLAN,
    { kind: 'step', at: 1100, session: 's', track: 'api', id: '1.1', status: 'done', origin: 'person' },
    { kind: 'step', at: 1200, session: 's', track: 'api', id: '1.2', status: 'done', origin: 'person' },
    { kind: 'plan', at: 1300, session: 's', track: 'web', title: 'Web app', phases: [{ name: 'P', steps: [{ id: '1', title: 'Left running' }] }] },
    { kind: 'step', at: old, session: 's', track: 'web', id: '1', status: 'running', origin: 'agent' },
  ]
  const files = new Map<string, string>(events.map((e, i) => [`/home/t/.claude/roadmap/events/${1000 + i}-o-x.json`, JSON.stringify(e)]))
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-seventeen' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // The finished track offers Archive; archiving hides it from the list.
    expect(await ui.find({ text: /API v2/ })).toBeDefined()
    await ui.press({ key: 'tarchive-api' })
    expect(await ui.find({ text: /API v2/ })).toBe(undefined)
    await ui.press({ key: 'view-backlog' })
    expect(await ui.find({ text: /^Archived$/ })).toBeDefined()
    await ui.press({ key: 'tunarchive-api' })
    await ui.press({ key: 'view-tracks' })
    expect(await ui.find({ text: /API v2/ })).toBeDefined()
    // The step left running for hours is stale: Needs you offers it back to todo.
    expect(await ui.find({ text: /1 stale/ })).toBeDefined()
    if (surface === 'desktop') {
      await ui.press({ key: 'stale-todo-web-1' })
      expect(await ui.find({ text: /stale/ })).toBe(undefined)
    }
    await ui.unmount()
  }
})

test('review policy: a worker\'s done waits for a review that meets it; cross-model means another family', async () => {
  const plan = {
    kind: 'plan',
    at: 1,
    session: 's',
    track: 'api',
    review: { required: true, independence: 'cross-model', mode: 'adversarial' },
    phases: [{ name: 'P', steps: [{ id: '1', title: 'Fence' }, { id: '2', title: 'Docs', review: { required: false } }] }],
  } as RoadmapEvent
  const work = (at: number, id: string, status: string, actor: string, session: string, origin = 'agent') =>
    ({ kind: 'step', at, session, track: 'api', id, status, actor, origin }) as RoadmapEvent
  const review = (at: number, actor: string, session: string, verdict: string) =>
    ({ kind: 'review', at, session, track: 'api', id: '1', actor, verdict }) as RoadmapEvent
  const get = (events: RoadmapEvent[], id = '1') => fold(events, [], 9999).tracks[0]?.steps.find(x => x.id === id)
  const impl = [plan, work(2, '1', 'running', 'claude', 'c1'), work(3, '1', 'done', 'claude', 'c1')]

  // Claude implemented and says done: it waits, a review is owed.
  expect(get(impl)?.status).toBe('awaiting')
  expect(get(impl)?.reviewPending).toBe(true)
  expect(get(impl)?.reviewState).toBe('missing')
  // Another Claude session's review does not count for cross-model …
  expect(get([...impl, review(4, 'claude', 'c2', 'pass')])?.status).toBe('awaiting')
  // … Codex's does: done.
  expect(get([...impl, review(4, 'codex', 'x1', 'pass')])?.reviewState).toBe('reviewed')
  expect(get([...impl, review(4, 'codex', 'x1', 'findings')])?.reviewState).toBe('reviewed')
  // A cross-model pass is a report, not a close: no agent can prove which model wrote it, so it waits
  // for the person — whose confirm closes it.
  expect(get([...impl, review(4, 'codex', 'x1', 'pass')])?.status).toBe('awaiting')
  expect(get([...impl, review(4, 'codex', 'x1', 'pass')])?.reviewPending).toBe(false)
  expect(get([...impl, review(4, 'codex', 'x1', 'pass')])?.passedReview?.actor).toBe('codex')
  expect(get([...impl, review(4, 'codex', 'x1', 'pass'), work(5, '1', 'done', 'person', 'p', 'person')])?.status).toBe('done')
  expect(summary(fold([...impl, review(4, 'codex', 'x1', 'pass')], [], 9999))).toContain('reviewed by codex: pass — the person confirms')
  // A failed review keeps it out, and says so.
  expect(get([...impl, review(4, 'codex', 'x1', 'fail')])?.reviewState).toBe('failed')
  expect(get([...impl, review(4, 'codex', 'x1', 'fail')])?.status).toBe('awaiting')
  // A new attempt (running again) needs a new review: the old one does not carry over.
  expect(get([...impl, review(4, 'codex', 'x1', 'pass'), work(5, '1', 'running', 'claude', 'c1'), work(6, '1', 'done', 'claude', 'c1')])?.status).toBe('awaiting')
  // The person's own done is final: an override.
  expect(get([...impl, work(4, '1', 'done', 'person', 'p', 'person')])?.status).toBe('done')
  // Symmetric: Codex implements, Claude reviews.
  const byCodex = [plan, work(2, '1', 'running', 'codex', 'x1'), work(3, '1', 'done', 'codex', 'x1'), review(4, 'claude', 'c1', 'pass')]
  expect(get(byCodex)?.reviewState).toBe('reviewed')
  // A step that opts out is done as usual.
  expect(get([plan, work(2, '2', 'done', 'claude', 'c1')], '2')?.status).toBe('done')
  // other-session: the same family from another session counts; the implementing session does not.
  const other = { ...plan, review: { required: true, independence: 'other-session' } } as RoadmapEvent
  const implO = [other, work(2, '1', 'running', 'claude', 'c1'), work(3, '1', 'done', 'claude', 'c1')]
  expect(get([...implO, review(4, 'claude', 'c1', 'pass')])?.status).toBe('awaiting')
  expect(get([...implO, review(4, 'claude', 'c2', 'pass')])?.status).toBe('done')
})

test('new steps must carry a review policy; existing ones may go without; Codex is suggested when installed', async () => {
  const ctx = (events: RoadmapEvent[], extra: object = {}) => ({ events, lives: [], now: 5000, session: 's1', actor: 'claude', ...extra })
  const none = planAction(ctx([]), { track: 'api', phases: [{ name: 'P', steps: [{ id: '1', title: 'A' }] }] })
  expect(none.ok).toBe(false)
  expect(none.text).toContain('new steps need a review policy (1)')
  const bad = planAction(ctx([]), { track: 'api', phases: [{ name: 'P', steps: [{ id: '1', title: 'A', review: { required: true, independence: 'whoever' } }] }] })
  expect(bad.ok).toBe(false)
  const first = planAction(ctx([]), {
    track: 'api',
    review: { required: true, independence: 'cross-model', mode: 'adversarial' },
    phases: [{ name: 'P', steps: [{ id: '1', title: 'A' }] }],
  })
  expect(first.ok).toBe(true)
  // Re-laid without a policy: the existing step is fine, and the track keeps its default for a new one.
  const again = planAction(ctx(first.emit, { now: 5001 }), { track: 'api', phases: [{ name: 'P', steps: [{ id: '1', title: 'A' }, { id: '2', title: 'B' }] }] })
  expect(again.ok).toBe(true)
  const board = fold([...first.emit, ...again.emit], [], 5000)
  expect(board.tracks[0]?.steps.find(x => x.id === '2')?.review?.independence).toBe('cross-model')

  const events = [...first.emit, ...markAction(ctx(first.emit), { step: 'api/1', status: 'running' }).emit]
  const hinted = stepAction(ctx(events, { hints: { codexInstalled: true, cli: 'roadmap' } }), { step: 'api/1' })
  expect(hinted.text).toContain('cross-model review (adversarial) required')
  expect(hinted.text).toContain('the reviewer must not be claude')
  expect(hinted.text).toContain('Codex is installed here')
  expect(hinted.text).toContain('roadmap review api/1 --verdict')
  expect(stepAction(ctx(events), { step: 'api/1' }).text).not.toContain('Codex is installed')

  // Still running: nothing reported done, nothing to review yet.
  expect(reviewAction(ctx(events, { actor: 'codex', session: 'x1' }), { step: 'api/1', verdict: 'pass' }).ok).toBe(false)
  const reported = [...events, ...doneAction(ctx(events, { now: 5002 }), { step: 'api/1', shipped: 'A' }).emit]
  // A Claude review of Claude's work is recorded, but says it does not count.
  const own = reviewAction(ctx(reported, { now: 5003 }), { step: 'api/1', verdict: 'pass' })
  expect(own.ok).toBe(true)
  expect(own.text).toContain('does not satisfy the policy')
  const codex = reviewAction(ctx(reported, { actor: 'codex', session: 'x1', now: 5003 }), { step: 'api/1', verdict: 'pass', evidence: 'no findings' })
  expect(codex.text).not.toContain('does not satisfy')
  expect(codex.text).toContain('confirmed by the person')
  expect(reviewAction(ctx(reported, { now: 5003 }), { step: 'api/1', verdict: 'maybe' }).ok).toBe(false)
})

test('review policy holds up: a re-lay keeps it, an earlier review does not count, ties are read one way', async () => {
  const ctx = (events: RoadmapEvent[], extra: object = {}) => ({ events, lives: [], now: 5000, session: 's1', actor: 'claude', ...extra })
  const strict = { required: true, independence: 'cross-model', mode: 'adversarial' }
  const work = (at: number, status: string, actor: string, session: string) =>
    ({ kind: 'step', at, session, track: 'api', id: '1', status, actor, origin: 'agent' }) as RoadmapEvent
  const review = (at: number, actor: string, verdict: string, session = 'x1') =>
    ({ kind: 'review', at, session, track: 'api', id: '1', actor, verdict }) as RoadmapEvent
  const get = (events: RoadmapEvent[]) => fold(events, [], 9999).tracks[0]?.steps.find(x => x.id === '1')

  // 1. Re-laid without `review`, a step keeps its own policy; a plan cannot lower it, and says so.
  const first = planAction(ctx([]), { track: 'api', phases: [{ name: 'P', steps: [{ id: '1', title: 'A', review: strict }] }] })
  expect(first.ok).toBe(true)
  const relaid = planAction(ctx(first.emit, { now: 5001 }), { track: 'api', phases: [{ name: 'P', steps: [{ id: '1', title: 'A' }] }] })
  expect(fold([...first.emit, ...relaid.emit], [], 5000).tracks[0]?.steps[0]?.review?.independence).toBe('cross-model')
  const lowered = planAction(ctx(first.emit, { now: 5001 }), { track: 'api', phases: [{ name: 'P', steps: [{ id: '1', title: 'A', review: { required: false } }] }] })
  expect(lowered.text).toContain('Kept the stricter review policy')
  expect(fold([...first.emit, ...lowered.emit], [], 5000).tracks[0]?.steps[0]?.review?.required).toBe(true)
  // … the track's default likewise; raising a policy works.
  const t1 = planAction(ctx([]), { track: 'api', review: strict, phases: [{ name: 'P', steps: [{ id: '1', title: 'A' }] }] })
  const t2 = planAction(ctx(t1.emit, { now: 5001 }), { track: 'api', review: { required: true, independence: 'any' }, phases: [{ name: 'P', steps: [{ id: '1', title: 'A' }] }] })
  expect(t2.text).toContain('the track')
  expect(fold([...t1.emit, ...t2.emit], [], 5000).tracks[0]?.review?.independence).toBe('cross-model')
  const weak = planAction(ctx([]), { track: 'api', phases: [{ name: 'P', steps: [{ id: '1', title: 'A', review: { required: true, independence: 'any' } }] }] })
  const raised = planAction(ctx(weak.emit, { now: 5001 }), { track: 'api', phases: [{ name: 'P', steps: [{ id: '1', title: 'A', review: strict }] }] })
  expect(raised.text).not.toContain('Kept the stricter')
  expect(fold([...weak.emit, ...raised.emit], [], 5000).tracks[0]?.steps[0]?.review?.independence).toBe('cross-model')

  // 2. A review written before the work does not count for it; the CLI and tool refuse one with no work yet.
  const plan = first.emit[0]!
  expect(reviewAction(ctx([plan], { actor: 'codex', session: 'x1' }), { step: 'api/1', verdict: 'pass' }).ok).toBe(false)
  expect(get([plan, review(2, 'codex', 'pass'), work(3, 'running', 'claude', 'c1'), work(4, 'done', 'claude', 'c1')])?.status).toBe('awaiting')
  expect(get([plan, review(2, 'codex', 'pass'), work(4, 'done', 'claude', 'c1')])?.status).toBe('awaiting')
  expect(get([plan, work(3, 'running', 'claude', 'c1'), work(4, 'done', 'claude', 'c1'), review(5, 'codex', 'pass')])?.reviewState).toBe('reviewed')

  // 3. `review: {}` is not a policy: `required` must be said.
  const empty = planAction(ctx([]), { track: 'api', phases: [{ name: 'P', steps: [{ id: '1', title: 'A', review: {} }] }] })
  expect(empty.ok).toBe(false)
  expect(empty.text).toContain('review.required must be true or false')
  expect(planAction(ctx([]), { track: 'api', review: {}, phases: [{ name: 'P', steps: [{ id: '1', title: 'A' }] }] }).ok).toBe(false)

  // 5. Same millisecond: a review at the moment the work starts does not count, and the board does not
  // depend on the order events were read in (a pass and a fail at once read as failed).
  expect(get([plan, work(3, 'running', 'claude', 'c1'), review(3, 'codex', 'pass'), work(4, 'done', 'claude', 'c1')])?.status).toBe('awaiting')
  const tie = [plan, work(3, 'running', 'claude', 'c1'), work(4, 'done', 'claude', 'c1'), review(5, 'codex', 'pass', 'x1'), review(5, 'gemini', 'fail', 'g1')]
  for (const events of [tie, [...tie].reverse(), [tie[0]!, tie[4]!, tie[2]!, tie[3]!, tie[1]!]]) {
    expect(get(events)?.reviewState).toBe('failed')
    expect(get(events)?.status).toBe('awaiting')
  }
  // A done and a running in one millisecond: whether the work was reopened is unknown, so the review
  // does not count, read in either order.
  const sameMs = [plan, work(3, 'running', 'claude', 'c1'), work(3, 'done', 'claude', 'c1'), review(4, 'codex', 'pass')]
  expect(get(sameMs)?.status).toBe('awaiting')
  expect(get([...sameMs].reverse())?.status).toBe('awaiting')
  expect(get([plan, work(2, 'running', 'claude', 'c1'), work(3, 'done', 'claude', 'c1'), work(3, 'running', 'claude', 'c1'), review(4, 'codex', 'pass')])?.reviewState).toBe('missing')
  // An agent that starts and ends in one millisecond ends, whichever file is read first.
  const start = { kind: 'agent', at: 7, session: 's2', agentId: 'a1', description: 'x', type: 'Explore' } as RoadmapEvent
  const end = { kind: 'agent-end', at: 7, session: 's2', agentId: 'a1', status: 'done' } as RoadmapEvent
  expect(fold([end, start], [], 9999).agents[0]?.status).toBe('done')

  // 6. A model family is its leading word, however the actor is spelled.
  for (const name of ['claude', 'Claude', 'claude-opus', 'claude_code', 'claude.opus', 'claude:sonnet', 'CLAUDE CODE']) expect(family(name)).toBe('claude')
  expect(family('codex')).toBe('codex')
  expect(family(undefined)).toBe('unknown')
  expect(get([plan, work(3, 'running', 'claude', 'c1'), work(4, 'done', 'claude', 'c1'), review(5, 'claude_code', 'pass')])?.status).toBe('awaiting')
})

test('review policy, second round: no plan sheds a policy, each done needs its review, a declared actor proves nothing', async () => {
  const ctx = (events: RoadmapEvent[], extra: object = {}) => ({ events, lives: [], now: 5000, session: 's1', actor: 'claude', ...extra })
  const cross = { required: true, independence: 'cross-model', mode: 'adversarial' }
  const work = (at: number, status: string, id = '1') =>
    ({ kind: 'step', at, session: 'c1', track: 'api', id, status, actor: 'claude', origin: 'agent' }) as RoadmapEvent
  const review = (at: number, verdict: string, via?: string, actor = 'codex') =>
    ({ kind: 'review', at, session: 'x1', track: 'api', id: '1', actor, verdict, via }) as RoadmapEvent
  const get = (events: RoadmapEvent[]) => fold(events, [], 99999).tracks[0]?.steps.find(x => x.id === '1')
  const lay = (events: RoadmapEvent[], now: number, input: object) => planAction(ctx(events, { now }), { track: 'api', ...input })

  // A. A step under the track's policy cannot opt out by a re-lay.
  const t = lay([], 1, { review: cross, phases: [{ name: 'P', steps: [{ id: '1', title: 'A' }] }] }).emit
  const reported = [...t, work(2, 'running'), work(3, 'done')]
  expect(get(reported)?.status).toBe('awaiting')
  const optOut = lay(reported, 4, { phases: [{ name: 'P', steps: [{ id: '1', title: 'A', review: { required: false } }] }] })
  expect(optOut.text).toContain('Kept the stricter review policy')
  expect(get([...reported, ...optOut.emit])?.status).toBe('awaiting')
  expect(get([...reported, ...optOut.emit])?.review?.independence).toBe('cross-model')
  // … a new step may still opt out on purpose.
  const fresh = lay(t, 4, { phases: [{ name: 'P', steps: [{ id: '1', title: 'A' }, { id: '2', title: 'B', review: { required: false } }] }] })
  expect(fold([...t, ...fresh.emit], [], 9).tracks[0]?.steps.find(x => x.id === '2')?.review?.required).toBe(false)

  // B. Dropping the step from the plan and adding it back does not shed its policy either.
  const dropped = lay(reported, 4, { phases: [{ name: 'P', steps: [{ id: '2', title: 'B', review: { required: false } }] }] }).emit
  const readded = lay([...reported, ...dropped], 5, { phases: [{ name: 'P', steps: [{ id: '1', title: 'A', review: { required: false } }] }] }).emit
  expect(get([...reported, ...dropped, ...readded])?.status).toBe('awaiting')

  // C. Each done is new work: a pass on version 1 does not cover version 2.
  expect(get([...reported, review(4, 'pass')])?.reviewState).toBe('reviewed')
  expect(get([...reported, review(4, 'pass'), work(5, 'done')])?.status).toBe('awaiting')
  expect(get([...reported, review(4, 'pass'), work(5, 'done'), review(6, 'pass')])?.reviewState).toBe('reviewed')
  // … and a review while the work is reopened (running) counts for nothing.
  expect(get([...reported, work(4, 'running'), review(5, 'pass'), work(6, 'done')])?.status).toBe('awaiting')
  expect(reviewAction(ctx([...reported, work(4, 'running')], { actor: 'codex', session: 'x1', via: 'process', channel: 'cli', now: 6 }), { step: 'api/1', verdict: 'pass' }).ok).toBe(false)

  // D. A declared actor never satisfies cross-model; a host-established one does; pre-`via` reviews still count.
  expect(get([...reported, review(4, 'pass', 'declared')])?.status).toBe('awaiting')
  expect(get([...reported, review(4, 'pass', 'process')])?.reviewState).toBe('reviewed')
  expect(get([...reported, review(4, 'pass', 'codex-sandbox')])?.reviewState).toBe('reviewed')
  expect(get([...reported, review(4, 'pass')])?.reviewState).toBe('reviewed')
  const declared = reviewAction(ctx(reported, { actor: 'gemini', session: 'g1', via: 'declared', channel: 'cli', now: 6 }), { step: 'api/1', verdict: 'pass' })
  expect(declared.text).toContain('only declared')
  // The CLI never records a review as Claude: Claude reviews through its own tool.
  const asClaude = reviewAction(ctx(reported, { session: 'c9', via: 'process', channel: 'cli', now: 6 }), { step: 'api/1', verdict: 'pass' })
  expect(asClaude.ok).toBe(false)
  expect(reviewAction(ctx(reported, { session: 'c9', via: 'claude-code', channel: 'tool', now: 6 }), { step: 'api/1', verdict: 'pass' }).ok).toBe(true)

  // E. "Never lower" holds part by part: a stronger independence does not buy a weaker mode.
  const w1 = lay([], 1, { phases: [{ name: 'P', steps: [{ id: '1', title: 'A', review: { required: true, independence: 'any', mode: 'adversarial' } }] }] }).emit
  const w2 = lay(w1, 2, { phases: [{ name: 'P', steps: [{ id: '1', title: 'A', review: { required: true, independence: 'other-session', mode: 'standard' } }] }] })
  expect(w2.text).toContain('Kept the stricter')
  const merged = get([...w1, ...w2.emit])?.review
  expect(merged?.independence).toBe('other-session')
  expect(merged?.mode).toBe('adversarial')
})

test('review policy, round four: an add cannot shed the floor, a half-said policy reads one way, the summary names the verdict', async () => {
  const cross = { required: true, independence: 'cross-model', mode: 'adversarial' }
  const work = (at: number, status: string, origin = 'agent', actor = 'claude') =>
    ({ kind: 'step', at, session: 'c1', track: 'api', id: '1', status, actor, origin }) as RoadmapEvent
  const review = (at: number, verdict: string) =>
    ({ kind: 'review', at, session: 'x1', track: 'api', id: '1', actor: 'codex', verdict, via: 'codex-sandbox' }) as RoadmapEvent
  const plan = (at: number, steps: object[], extra: object = {}) => ({ kind: 'plan', at, session: 's', track: 'api', phases: [{ name: 'P', steps }], ...extra }) as RoadmapEvent
  const get = (events: RoadmapEvent[]) => fold(events, [], 99999).tracks[0]?.steps.find(x => x.id === '1')

  // 1. Laid with a cross-model policy, reported done, dropped from the plan, brought back by an `add`:
  // it still needs its review, and a pass still waits for the person.
  const base = [plan(1, [{ id: '1', title: 'A', review: cross }]), work(2, 'running'), work(3, 'done'), plan(4, [{ id: '2', title: 'B', review: { required: false } }])]
  const add = { kind: 'add', at: 5, session: 'c1', track: 'api', id: '1', title: 'A', origin: 'agent' } as RoadmapEvent
  expect(get([...base, add])?.status).toBe('awaiting')
  expect(get([...base, add])?.review?.independence).toBe('cross-model')
  expect(get([...base, add, review(6, 'pass')])?.status).toBe('awaiting')
  expect(get([...base, add, review(6, 'pass'), work(7, 'done', 'person', 'person')])?.status).toBe('done')

  // 2. A half-said policy in the journal reads as the plan tool would write it: cross-model, and
  // failing closed — anything but an explicit `required: false` requires a review.
  for (const review_ of [{ required: true }, { required: true, independence: 'whoever' }, {}, { required: 'yes' }]) {
    const events = [plan(1, [{ id: '1', title: 'A', review: review_ }]), work(2, 'running'), work(3, 'done'), review(4, 'pass')]
    expect(get(events)?.review?.independence).toBe('cross-model')
    expect(get(events)?.status).toBe('awaiting')
  }
  expect(get([plan(1, [{ id: '1', title: 'A', review: { required: false } }]), work(2, 'done')])?.status).toBe('done')
  // … and the plan tool writes that normal form, so nothing half-said reaches the journal.
  const laid = planAction({ events: [], lives: [], now: 1, session: 's', actor: 'claude' }, { track: 'api', phases: [{ name: 'P', steps: [{ id: '1', title: 'A', review: { required: true } }] }] })
  expect(JSON.stringify((laid.emit[0] as { phases: { steps: { review: unknown }[] }[] }).phases[0]!.steps[0]!.review)).toBe(
    JSON.stringify({ required: true, independence: 'cross-model', mode: 'standard' }),
  )

  // 3. The summary names the verdict, not only the reviewer.
  const reviewed = [plan(1, [{ id: '1', title: 'A', review: cross }]), work(2, 'running'), work(3, 'done'), review(4, 'findings')]
  expect(summary(fold(reviewed, [], 99999))).toContain('reviewed by codex: findings — the person confirms')
})

test('moved: a step hands its obligation to another; the person confirms; dependents and review policy follow it', async () => {
  const ctx = (events: RoadmapEvent[], extra: object = {}) => ({ events, lives: [], now: 100, session: 's1', actor: 'claude', ...extra })
  const cross = { required: true, independence: 'cross-model', mode: 'adversarial' }
  const plan = {
    kind: 'plan', at: 1, session: 's', track: 'api',
    phases: [{ name: 'P', steps: [
      { id: '1', title: 'Fence', review: cross },
      { id: '2', title: 'Unified fence', review: { required: false } },
      { id: '3', title: 'Uses the fence', blockedBy: ['1'], review: { required: false } },
      { id: '4', title: 'Later', review: { required: false } },
    ] }],
  } as RoadmapEvent
  const step = (at: number, id: string, status: string, origin = 'agent', extra: object = {}) =>
    ({ kind: 'step', at, session: origin === 'person' ? 'p' : 'c1', track: 'api', id, status, actor: origin === 'person' ? 'person' : 'claude', origin, ...extra }) as RoadmapEvent
  const moveBy = (at: number, id: string, to: string, origin = 'person') => step(at, id, 'moved', origin, { movedTo: to, reason: 'folded into the unified fence' })
  const board = (events: RoadmapEvent[]) => fold(events, [], 9999)
  const get = (events: RoadmapEvent[], id: string) => board(events).tracks[0]?.steps.find(x => x.id === id)

  // The action: a move needs a target that exists, is not itself, does not loop back; and a reason.
  expect(markAction(ctx([plan]), { step: 'api/1', status: 'moved', reason: 'r' }).ok).toBe(false)
  expect(markAction(ctx([plan]), { step: 'api/1', status: 'moved', to: '2' }).ok).toBe(false)
  expect(markAction(ctx([plan]), { step: 'api/1', status: 'moved', to: 'api/9', reason: 'r' }).ok).toBe(false)
  expect(markAction(ctx([plan]), { step: 'api/1', status: 'moved', to: '1', reason: 'r' }).text).toContain('onto itself')
  const loop = markAction(ctx([plan, moveBy(2, '1', 'api/2')]), { step: 'api/2', status: 'moved', to: 'api/1', reason: 'r' })
  expect(loop.ok).toBe(false)
  expect(loop.text).toContain('leads back')
  // An agent's move is a proposal: it awaits the person, and dependents still wait on the step itself.
  const proposed = markAction(ctx([plan]), { step: 'api/1', status: 'moved', to: '2', reason: 'folded into the unified fence' })
  expect(proposed.ok).toBe(true)
  expect(proposed.text).toContain('move to api/2 proposed')
  const p1 = [plan, ...proposed.emit]
  expect(get(p1, '1')?.status).toBe('awaiting')
  expect(get(p1, '1')?.proposed).toBe('moved')
  expect(get(p1, '1')?.movedTo).toBe('api/2')
  expect(get(p1, '3')?.status).toBe('blocked')
  expect(summary(board(p1))).toContain('a move to api/2 awaits the person')

  // Confirmed: the step is moved, not done; its dependent now waits on the target, and is free once it is done.
  const m = [...p1, moveBy(200, '1', 'api/2')]
  expect(get(m, '1')?.status).toBe('moved')
  expect(get(m, '1')?.movedFinal).toBe('api/2')
  expect(get(m, '2')?.carries).toEqual(['api/1'])
  expect(get(m, '3')?.status).toBe('blocked')
  expect(get([...m, step(300, '2', 'done', 'person')], '3')?.status).toBe('todo')
  // Progress sets the moved step aside: it is neither done nor still to do here.
  expect(progress(board(m).tracks[0]!).total).toBe(3)
  // Its review policy travels: the target, laid with no review, now needs a cross-model one.
  expect(get(m, '2')?.review?.independence).toBe('cross-model')
  const doneThere = [...m, step(300, '2', 'running'), step(301, '2', 'done')]
  expect(get(doneThere, '2')?.status).toBe('awaiting')
  expect(get(doneThere, '2')?.reviewPending).toBe(true)
  expect(get(doneThere, '3')?.status).toBe('blocked')
  // Briefs, the summary and Markdown say where the obligation went.
  expect(brief(board(m), 'api', '1')).toContain('its obligation now lives in api/2')
  expect(brief(board(m), 'api', '2')).toContain('Also answers for: api/1')
  expect(brief(board(m), 'api', '3')).toContain('this waits on that step now')
  expect(summary(board(m))).toContain('moved (obligation handed to another step): api/1 → api/2')
  expect(trackMarkdown(board(m).tracks[0]!, 9999, 0)).toContain('[>] api/1 Fence — moved to api/2')

  // A chain resolves to its end, which answers for every step moved along it.
  const chain = [...m, moveBy(400, '2', 'api/4')]
  expect(get(chain, '1')?.movedFinal).toBe('api/4')
  expect(get(chain, '4')?.carries?.sort()).toEqual(['api/1', 'api/2'])
  expect(get(chain, '4')?.review?.independence).toBe('cross-model')
  // A chain that loops (written by hand) or whose end left the plan ends nowhere: dependents stay blocked.
  const looped = [...m, moveBy(400, '2', 'api/1')]
  expect(get(looped, '1')?.movedFinal).toBe(undefined)
  expect(get(looped, '3')?.status).toBe('blocked')
  // … until the person settles it: a done on step 2 ends 2's move, so 1's chain ends there again.
  expect(get([...looped, step(500, '2', 'done', 'person')], '1')?.movedFinal).toBe('api/2')
  expect(get([...looped, step(500, '2', 'done', 'person')], '3')?.status).toBe('todo')
  // The person rejects a proposed move: back to work.
  expect(get([...p1, step(200, '1', 'todo', 'person')], '1')?.status).toBe('todo')
  // A `moved` without a target is no move at all.
  expect(get([plan, step(2, '1', 'moved', 'person')], '1')?.status).toBe('todo')
})

test('moved, second round: only the person undoes a move, a dropped source still hands on its policy, a move is checked when confirmed', async () => {
  const ctx = (events: RoadmapEvent[], extra: object = {}) => ({ events, lives: [], now: 100, session: 's1', actor: 'claude', ...extra })
  const cross = { required: true, independence: 'cross-model', mode: 'adversarial' }
  const off = { required: false }
  const plan = (at: number, ids: string[]) =>
    ({ kind: 'plan', at, session: 's', track: 'a', phases: [{ name: 'P', steps: ids.map(id => ({ id, title: `S${id}`, review: id === '1' ? cross : off, ...(id === '3' ? { blockedBy: ['1'] } : {}) })) }] }) as RoadmapEvent
  const step = (at: number, id: string, status: string, origin = 'agent', extra: object = {}) =>
    ({ kind: 'step', at, session: origin === 'person' ? 'p' : 'c1', track: 'a', id, status, actor: origin === 'person' ? 'person' : 'claude', origin, ...extra }) as RoadmapEvent
  const move = (at: number, id: string, to: string, origin = 'person') => step(at, id, 'moved', origin, { movedTo: to, reason: 'r' })
  const get = (events: RoadmapEvent[], id: string) => fold(events, [], 9999).tracks[0]?.steps.find(x => x.id === id)
  const base = [plan(1, ['1', '2', '3', '4']), move(10, '1', 'a/2')]

  // 1. A worker's later report cannot undo a confirmed move, nor free its dependents early.
  expect(get([...base, step(20, '1', 'done')], '1')?.status).toBe('moved')
  expect(get([...base, step(20, '1', 'done')], '3')?.status).toBe('blocked')
  expect(get([...base, step(20, '1', 'running')], '1')?.status).toBe('moved')
  const agent = { kind: 'agent', at: 5, session: 'c1', agentId: 'g', description: 'x', type: 'Explore', track: 'a', step: '1' } as RoadmapEvent
  const agentEnd = { kind: 'agent-end', at: 10, session: 'c1', agentId: 'g', status: 'done' } as RoadmapEvent
  expect(get([...base, agent, agentEnd], '1')?.status).toBe('moved')
  expect(get([...base, agent, agentEnd], '3')?.status).toBe('blocked')
  // … the person can: their own word undoes it.
  expect(get([...base, step(20, '1', 'todo', 'person')], '1')?.status).toBe('todo')

  // 2. The source leaving the plan does not take its policy with it: the target still needs a cross-model review.
  const dropped = [...base, plan(20, ['2', '3', '4'])]
  expect(get(dropped, '2')?.carries).toEqual(['a/1'])
  expect(get(dropped, '2')?.review?.independence).toBe('cross-model')
  expect(get([...dropped, step(30, '2', 'running'), step(31, '2', 'done')], '2')?.status).toBe('awaiting')

  // 3. Two proposals that would loop each pass on their own; once one is confirmed, the other cannot be.
  const p1 = markAction(ctx([plan(1, ['1', '2', '3', '4'])]), { step: 'a/1', status: 'moved', to: '2', reason: 'r' })
  const p2 = markAction(ctx([plan(1, ['1', '2', '3', '4']), ...p1.emit], { now: 101 }), { step: 'a/2', status: 'moved', to: '1', reason: 'r' })
  expect(p1.ok && p2.ok).toBe(true)
  const confirmedOne = [plan(1, ['1', '2', '3', '4']), ...p1.emit, ...p2.emit, move(200, '1', 'a/2')]
  expect(get(confirmedOne, '2')?.moveProblem).toContain('loop back here')
  expect(checkMove(confirmedOne, 300, 'a', '2', 'a/1')).toContain('leads back')
  // A target that left the plan between proposal and confirmation cannot be confirmed either.
  const p4 = markAction(ctx([plan(1, ['1', '2', '3', '4'])]), { step: 'a/1', status: 'moved', to: '4', reason: 'r' })
  const gone = [plan(1, ['1', '2', '3', '4']), ...p4.emit, plan(200, ['1', '2', '3'])]
  expect(get(gone, '1')?.moveProblem).toContain('no longer exists')
  expect(checkMove(gone, 300, 'a', '1', 'a/4')).toContain('does not exist')
  expect(checkMove([plan(1, ['1', '2'])], 300, 'a', '1', 'a/2')).toBe(undefined)
})

test('the pane will not confirm a move that no longer stands, even from a stale render', async ($, on) => {
  const plan = (at: number, ids: string[]) => ({ kind: 'plan', at, session: 's', track: 'api', title: 'API', phases: [{ name: 'P', steps: ids.map(id => ({ id, title: `S${id}`, review: { required: false } })) }] })
  const events = [plan(1000, ['1', '2']), { kind: 'step', at: 1100, session: 'c1', track: 'api', id: '1', status: 'moved', movedTo: 'api/2', reason: 'r', actor: 'claude', origin: 'agent' }]
  const files = new Map<string, string>(events.map((e, i) => [`/home/t/.claude/roadmap/events/${1000 + i}-o-x.json`, JSON.stringify(e)]))
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-move' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as { message?: unknown }).message ?? JSON.stringify(e)))
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /Confirm move/ })).toBeDefined()
  // Another chat drops the target before the person clicks.
  files.set('/home/t/.claude/roadmap/events/1792000000000-o-y.json', JSON.stringify(plan(1200, ['1'])))
  await ui.press({ key: 'ok-api-1' })
  expect([...files.values()].some(t => t.includes('"status":"moved"') && t.includes('"origin":"person"'))).toBe(false)
  expect(toasts.some(t => t.includes('Not moved'))).toBe(true)
  await ui.unmount()
  // Drawn again, the pane says why and offers no Confirm move.
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await again.find({ text: /but api\/2 no longer exists/ })).toBeDefined()
  expect(await again.find({ text: /Confirm move/ })).toBe(undefined)
  await again.unmount()
})

test('a chat whose plugin code changed on disk says to restart; a file merely touched does not', async ($, on) => {
  const plan = { kind: 'plan', at: 1000, session: 's', track: 'api', title: 'API', phases: [{ name: 'P', steps: [{ id: '1', title: 'A', review: { required: false } }] }] }
  const files = new Map<string, string>([['/home/t/.claude/roadmap/events/1000-o-x.json', JSON.stringify(plan)]])
  const hooks = [
    { name: 'model.ts', text: 'export const a = 1', mtimeMs: 1 },
    { name: 'view.tsx', text: 'export const b = 2', mtimeMs: 1 },
    { name: 'notes.md', text: 'not code', mtimeMs: 1 },
  ]
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: e.path.includes('/hooks/') ? (hooks.find(h => e.path.endsWith(`/${h.name}`))?.text ?? '') : (files.get(e.path) ?? '') }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: (e.path ?? '').endsWith('/hooks')
      ? hooks.map(h => ({ name: h.name, kind: 'file' as const, size: h.text.length, mtimeMs: h.mtimeMs, isLink: false }))
      : under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-code' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  const copied: string[] = []
  on('ui.copy', (_$, e) => {
    copied.push((e as { text: string }).text)
    return { value: { isCopied: true } }
  })
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  // The clock ticks only when the test says so.
  const waiting: (() => void)[] = []
  on('clock.every', () => new Promise(resolve => waiting.push(() => resolve({ value: undefined }))))
  const sleep = (ms: number) => new Promise(r => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout(() => r(undefined), ms))
  const tick = async () => {
    for (let i = 0; i < 50 && waiting.length === 0; i++) await sleep(5)
    waiting.shift()?.()
    for (let i = 0; i < 50 && waiting.length === 0; i++) await sleep(5)
    await sleep(20)
  }
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)
  const band = () =>
    $.ui.mount({
      plugin: 'roadmap',
      surface: 'desktop',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 5 } } as never,
    })

  await tick()
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /Roadmap updated/ })).toBe(undefined)
  await ui.unmount()
  // Touched, not changed: same text, a new time.
  hooks[0]!.mtimeMs = 2
  await tick()
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /Roadmap updated/ })).toBe(undefined)
  await ui.unmount()
  // A file that is not code changes: still nothing.
  hooks[2]!.text = 'still not code, but longer'
  await tick()
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /Roadmap updated/ })).toBe(undefined)
  await ui.unmount()
  // The code changes: the pane and the band say so.
  hooks[1]!.text = 'export const b = 3'
  hooks[1]!.mtimeMs = 3
  await tick()
  for (const surface of ['terminal', 'desktop'] as const) {
    const each = await $.ui.mount({ ...PANE, surface })
    expect(await each.find({ text: /Roadmap updated — run \/reload-plugins/ })).toBeDefined()
    await each.press({ key: 'copy-reload' })
    expect(copied.pop()).toBe('/reload-plugins')
    await each.unmount()
  }
  const b = await band()
  expect(await b.find({ text: /↻ \/reload-plugins/ })).toBeDefined()
  await b.unmount()
  // Put back as it was loaded: nothing to restart for.
  hooks[1]!.text = 'export const b = 2'
  hooks[1]!.mtimeMs = 4
  await tick()
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /Roadmap updated/ })).toBe(undefined)
  await ui.unmount()
})

test('projects: a track belongs to the repo it was laid out from; the person can move it; each project sees its own', async () => {
  const off = { required: false }
  const plan = (at: number, track: string, project?: string, session = 's') =>
    ({ kind: 'plan', at, session, track, project, phases: [{ name: 'P', steps: [{ id: '1', title: `${track} work`, review: off }] }] }) as RoadmapEvent
  const session = (at: number, id: string, project?: string) => ({ kind: 'session', at, session: id, title: id, actor: 'claude', project }) as RoadmapEvent
  const step = (at: number, track: string, sessionId: string) =>
    ({ kind: 'step', at, session: sessionId, track, id: '1', status: 'running', actor: 'claude', origin: 'agent' }) as RoadmapEvent
  const triage = (at: number, track: string, project: string | null, origin = 'person') => ({ kind: 'triage', at, session: 'p', track, project, origin }) as RoadmapEvent
  const track = (events: RoadmapEvent[], name: string) => fold(events, [], 9999).tracks.find(t => t.name === name)

  // The first plan sets it; a later plan from another repo does not move it.
  const base = [plan(1, 'web', '/repos/web'), plan(2, 'api', '/repos/api')]
  expect(track(base, 'web')?.project).toBe('/repos/web')
  expect(track(base, 'web')?.projectBy).toBe('plan')
  expect(track([...base, plan(3, 'web', '/repos/api')], 'web')?.project).toBe('/repos/web')
  // A track laid out before projects existed takes the project most of its chats worked in…
  const legacy = [plan(1, 'docs'), session(2, 'a', '/repos/web'), session(2, 'b', '/repos/api'), step(3, 'docs', 'a'), step(4, 'docs', 'a'), step(5, 'docs', 'b')]
  expect(track(legacy, 'docs')?.project).toBe('/repos/web')
  expect(track(legacy, 'docs')?.projectBy).toBe('inferred')
  // … and one nobody can place stays in no project.
  expect(track([plan(1, 'docs')], 'docs')?.project).toBe(undefined)
  // Re-laying an old track from some other folder does not place it there: its chats' project wins.
  expect(track([...legacy, plan(9, 'docs', '/tmp/scratch')], 'docs')?.project).toBe('/repos/web')
  // The person's word places it, or takes it out of any; an agent's word does not.
  expect(track([...base, triage(5, 'web', '/repos/api')], 'web')?.project).toBe('/repos/api')
  expect(track([...base, triage(5, 'web', '/repos/api')], 'web')?.projectBy).toBe('you')
  expect(track([...legacy, triage(9, 'docs', null)], 'docs')?.project).toBe(undefined)
  expect(track([...base, triage(5, 'web', '/repos/api', 'agent')], 'web')?.project).toBe('/repos/web')

  // Projects are named by their folder, made unique when two share a name.
  const twins = fold([plan(1, 'a', '/x/one/api'), plan(2, 'b', '/x/two/api'), plan(3, 'c', '/repos/web')], [], 9)
  expect(twins.projects.map(p => p.name)).toEqual(['api (one)', 'api (two)', 'web'])
  expect(twins.projects.find(p => p.key === '/repos/web')?.tracks).toBe(1)

  // A project sees its own tracks and those placed nowhere; '*' sees every one.
  const board = fold([...base, plan(3, 'docs')], [], 9)
  expect(forProject(board, '/repos/web').tracks.map(t => t.name).sort()).toEqual(['docs', 'web'])
  expect(forProject(board, '*').tracks.length).toBe(3)
  // The agents' summary is the chat's project, with the others named in one line.
  const said = summary(board, { project: '/repos/web' })
  expect(said).toContain('Project: web')
  expect(said).toContain('web/1 web work')
  expect(said).toContain('docs/1 docs work')
  expect(said).not.toContain('api/1 api work')
  expect(said).toContain('other projects (not this chat\'s; roadmap status with all shows them): api (1 track)')
  // The tools: a plan records the chat's project, status scopes to it unless asked for all, a brief names it.
  const ctx = { events: base, lives: [], now: 50, session: 's9', actor: 'claude', project: '/repos/web' }
  const laid = planAction(ctx, { track: 'ops', phases: [{ name: 'P', steps: [{ id: '1', title: 'Ops', review: off }] }] })
  expect(fold([...base, ...laid.emit], [], 99).tracks.find(t => t.name === 'ops')?.project).toBe('/repos/web')
  expect(statusAction(ctx).text).not.toContain('api/1')
  expect(statusAction(ctx, { all: true }).text).toContain('api/1')
  expect(brief(board, 'api', '1')).toContain('project: api')
})

test('the pane shows this chat\'s project, switches to another or All, and places a track', async ($, on) => {
  const off = { required: false }
  const plan = (at: number, track: string, project?: string) => ({ kind: 'plan', at, session: 's', track, title: track.toUpperCase(), project, phases: [{ name: 'P', steps: [{ id: '1', title: `${track} work`, review: off }] }] })
  const events = [plan(1000, 'web', '/repos/web'), plan(1001, 'api', '/repos/api'), plan(1002, 'docs')]
  const files = new Map<string, string>(events.map((e, i) => [`/home/t/.claude/roadmap/events/${1000 + i}-o-x.json`, JSON.stringify(e)]))
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  // This chat works in a worktree of the web repository.
  on('process.run', (_$, e) =>
    e.argv[0] === 'git'
      ? { value: { exitCode: 0, stdout: '/repos/web/.git\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      : { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } },
  )
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-proj' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/repos/web-wt/feature', surface: null, isInteractive: true } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // This chat's project, and the tracks placed nowhere.
  expect(await ui.find({ text: /\[web\]/ })).toBeDefined()
  expect(await ui.find({ text: /WEB/ })).toBeDefined()
  expect(await ui.find({ text: /DOCS/ })).toBeDefined()
  expect(await ui.find({ text: /API/ })).toBe(undefined)
  expect(await ui.find({ text: /in no project/ })).toBeDefined()
  // Another project, then All.
  await ui.press({ key: 'proj-0' })
  expect(await ui.find({ text: /API/ })).toBeDefined()
  expect(await ui.find({ text: /WEB/ })).toBe(undefined)
  await ui.press({ key: 'proj-all' })
  expect(await ui.find({ text: /WEB/ })).toBeDefined()
  expect(await ui.find({ text: /API/ })).toBeDefined()
  // Placing the unplaced track: the first press puts it in the first project.
  await ui.press({ key: 'tplace-docs' })
  expect([...files.values()].some(t => t.includes('"kind":"triage"') && t.includes('"project":"/repos/api"') && t.includes('"origin":"person"'))).toBe(true)
  await ui.unmount()
  // The band speaks for this chat's project.
  const band = await $.ui.mount({
    plugin: 'roadmap',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 5 } } as never,
  })
  expect(await band.find({ text: /web 0%/ })).toBeDefined()
  expect(await band.find({ text: /api 0%/ })).toBe(undefined)
  await band.unmount()
})

test('projects, second round: who works where stays in its project; external links say so; names stay unique', async () => {
  const off = { required: false }
  const plan = (at: number, track: string, project?: string, steps: object[] = [{ id: '1', title: `${track} work`, review: off }]) =>
    ({ kind: 'plan', at, session: 's', track, project, phases: [{ name: 'P', steps }] }) as RoadmapEvent
  const session = (at: number, id: string, project?: string) => ({ kind: 'session', at, session: id, title: `chat ${id}`, actor: 'claude', project }) as RoadmapEvent
  const agent = (at: number, sessionId: string, agentId: string) => ({ kind: 'agent', at, session: sessionId, agentId, description: `agent of ${sessionId}`, type: 'Explore' }) as RoadmapEvent
  const events = [
    plan(1, 'web', '/repos/web', [{ id: '1', title: 'Front', blockedBy: ['api/1'], review: off }]),
    plan(2, 'api', '/repos/api'),
    session(3, 'w', '/repos/web'),
    session(3, 'a', '/repos/api'),
    agent(4, 'w', 'gw'),
    agent(4, 'a', 'ga'),
  ]
  const lives = [
    { session: 'w', title: 'chat w', at: 9990, agents: [], project: '/repos/web' },
    { session: 'a', title: 'chat a', at: 9990, agents: [], project: '/repos/api' },
  ]
  const whole = fold(events, lives, 9999)
  const web = forProject(whole, '/repos/web')
  // Sessions and their agents are scoped like the tracks.
  // (`s` laid out the plans without ever saying where it works: like an unplaced track, it shows everywhere.)
  expect(web.sessions.map(s => s.id).sort()).toEqual(['s', 'w'])
  expect(forProject(fold([...events, session(3, 'old')], lives, 9999), '/repos/web').sessions.map(s => s.id).sort()).toEqual(['old', 's', 'w'])
  expect(web.agents.map(a => a.id)).toEqual(['gw'])
  const ctx = { events, lives, now: 9999, session: 'me', actor: 'claude', project: '/repos/web' }
  expect(statusAction(ctx).text).toContain('chat w')
  expect(statusAction(ctx).text).not.toContain('chat a')
  expect(statusAction(ctx, { all: true }).text).toContain('chat a')
  // A dependency into another project says so: summary, brief.
  expect(summary(whole, { project: '/repos/web' })).toContain('(blocked by api/1 (in project api))')
  expect(brief(whole, 'web', '1')).toContain('api/1 [in project api]')
  expect(brief(whole, 'api', '1')).not.toContain('[in project')
  // A project with only archived tracks is still listed (the picker offers it).
  const archivedOnly = fold([...events, { kind: 'triage', at: 5, session: 'p', track: 'api', archived: true, origin: 'person' } as RoadmapEvent], [], 9999)
  expect(archivedOnly.projects.find(p => p.key === '/repos/api')?.archived).toBe(1)
  // Names stay unique however deep the clash goes.
  const deep = fold([plan(1, 'a', '/x/group/api'), plan(2, 'b', '/y/group/api'), plan(3, 'c', '/z/other/api')], [], 9)
  expect(deep.projects.map(p => p.name)).toEqual(['api (other)', 'api (x/group)', 'api (y/group)'])
  // Round two. A session that moved to another repository is shown where it works now (its live file).
  const moved = fold(events, [{ session: 'a', title: 'chat a', at: 9990, agents: [], project: '/repos/web', activity: 'Edit: x.ts' }], 9999)
  expect(forProject(moved, '/repos/web').sessions.map(s => s.id)).toContain('a')
  const apiNow = forProject(moved, '/repos/api')
  expect(apiNow.sessions.filter(s => workingIn(apiNow, s)).map(s => s.id)).not.toContain('a')
  // A made-up name never meets a real folder's name.
  const odd = fold([plan(1, 'a', '/x/a'), plan(2, 'b', '/y/a'), plan(3, 'c', '/z/a (x)')], [], 9)
  expect(new Set(odd.projects.map(p => p.name)).size).toBe(3)
  // The external mark holds in All and in Markdown too, not only in a narrowed view.
  expect(summary(whole, { project: '*' })).toContain('(blocked by api/1 (in project api))')
  expect(boardMarkdown(whole, 9999, 0)).toContain('waits on api/1 (in project api)')
  expect(boardMarkdown(forProject(whole, '/repos/web'), 9999, 0)).toContain('waits on api/1 (in project api)')
  // Two moves confirmed at once into a loop end nowhere: the person is shown it, to undo one.
  const loop = fold(
    [
      plan(1, 'm', '/repos/web', [{ id: '1', title: 'One', review: off }, { id: '2', title: 'Two', review: off }]),
      { kind: 'step', at: 5, session: 'p', track: 'm', id: '1', status: 'moved', movedTo: 'm/2', reason: 'r', origin: 'person', actor: 'person' } as RoadmapEvent,
      { kind: 'step', at: 5, session: 'q', track: 'm', id: '2', status: 'moved', movedTo: 'm/1', reason: 'r', origin: 'person', actor: 'person' } as RoadmapEvent,
    ],
    [],
    9,
  )
  expect(attention(loop).brokenMoves.map(s => s.id).sort()).toEqual(['1', '2'])
})

test('projects, third round: a session that moves keeps its past where it happened', async () => {
  const off = { required: false }
  const plan = (at: number, track: string, sessionId = 's') =>
    ({ kind: 'plan', at, session: sessionId, track, phases: [{ name: 'P', steps: [{ id: '1', title: `${track} work`, review: off }] }] }) as RoadmapEvent
  const session = (at: number, id: string, project: string) => ({ kind: 'session', at, session: id, title: `chat ${id}`, actor: 'claude', project }) as RoadmapEvent
  const step = (at: number, track: string, sessionId: string) =>
    ({ kind: 'step', at, session: sessionId, track, id: '1', status: 'running', actor: 'claude', origin: 'agent' }) as RoadmapEvent
  const agent = (at: number, id: string) => ({ kind: 'agent', at, session: 'm', agentId: id, description: `agent ${id}`, type: 'Explore' }) as RoadmapEvent
  // The session works in A, then moves to B and does nothing more there.
  const history = [plan(1, 'docs', 'm'), session(1, 'm', '/repos/a'), step(2, 'docs', 'm'), step(3, 'docs', 'm'), agent(4, 'ga'), session(10, 'm', '/repos/b')]
  const board = fold(history, [], 99)
  // 1. The track it worked on in A stays in A.
  expect(board.tracks.find(t => t.name === 'docs')?.project).toBe('/repos/a')
  // 2. The agent it ran in A stays in A — pane and Days alike.
  expect(forProject(board, '/repos/a').agents.map(a => a.id)).toEqual(['ga'])
  expect(forProject(board, '/repos/b').agents.map(a => a.id)).toEqual([])
  expect(days(forProject(board, '/repos/a'), 99, 0).flatMap(d => d.entries).some(e => e.kind === 'agent')).toBe(true)
  // The session itself works in B now; its start stays in A's history (Days), not B's.
  const inB = forProject(board, '/repos/b')
  const inA = forProject(board, '/repos/a')
  expect(inB.sessions.filter(s => workingIn(inB, s)).map(s => s.id)).toEqual(['m'])
  expect(inA.sessions.filter(s => workingIn(inA, s)).map(s => s.id)).not.toContain('m')
  expect(days(inA, 99, 0).flatMap(d => d.entries).some(e => e.kind === 'session' && e.text === 'chat m')).toBe(true)
  expect(days(inB, 99, 0).flatMap(d => d.entries).some(e => e.kind === 'session' && e.text === 'chat m')).toBe(false)
  // Work written in the same millisecond as the session's word for B is B's.
  const sameMs = fold([...history, session(30, 'm', '/repos/c'), plan(30, 'ops', 'm')], [], 99)
  expect(sameMs.tracks.find(t => t.name === 'ops')?.project).toBe('/repos/c')
  // 3. A live file older than the session's move does not pull it back.
  const stale = fold([...history, agent(12, 'gb')], [{ session: 'm', title: 'chat m', at: 5, agents: [], project: '/repos/a' }], 99)
  expect(stale.sessions.find(s => s.id === 'm')?.project).toBe('/repos/b')
  expect(forProject(stale, '/repos/b').agents.map(a => a.id)).toEqual(['gb'])
  expect(forProject(stale, '/repos/a').agents.map(a => a.id)).toEqual(['ga'])
  // … while a newer one does move it.
  expect(fold(history, [{ session: 'm', title: 'chat m', at: 20, agents: [], project: '/repos/c' }], 99).sessions.find(s => s.id === 'm')?.project).toBe('/repos/c')
})

test('the pane keeps a way to every project, shows only its own chats, and offers to undo a move going nowhere', async ($, on) => {
  const off = { required: false }
  const plan = (at: number, track: string, project?: string, steps: object[] = [{ id: '1', title: `${track} work`, review: off }]) =>
    ({ kind: 'plan', at, session: 's', track, title: track.toUpperCase(), project, phases: [{ name: 'P', steps }] })
  const events = [
    plan(1000, 'web', '/repos/web', [{ id: '1', title: 'Front', blockedBy: ['api/1'], review: off }, { id: '2', title: 'One', review: off }, { id: '3', title: 'Two', review: off }]),
    plan(1001, 'api', '/repos/api'),
    { kind: 'triage', at: 1002, session: 'p', track: 'api', archived: true, origin: 'person' },
    { kind: 'step', at: 1003, session: 'p', track: 'web', id: '2', status: 'moved', movedTo: 'web/3', reason: 'r', origin: 'person', actor: 'person' },
    { kind: 'step', at: 1003, session: 'q', track: 'web', id: '3', status: 'moved', movedTo: 'web/2', reason: 'r', origin: 'person', actor: 'person' },
    { kind: 'session', at: 1004, session: 'other', title: 'A chat in api', actor: 'claude', project: '/repos/api' },
  ]
  const files = new Map<string, string>(events.map((e, i) => [`/home/t/.claude/roadmap/events/${1000 + i}-o-x.json`, JSON.stringify(e)]))
  files.set('/home/t/.claude/roadmap/live/other.json', JSON.stringify({ session: 'other', title: 'A chat in api', at: Date.now(), activity: 'Edit: secret.ts', project: '/repos/api', agents: [] }))
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: Date.now(), isLink: false })),
  }))
  on('process.run', (_$, e) =>
    e.argv[0] === 'git'
      ? { value: { exitCode: 0, stdout: '/repos/web/.git\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      : { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } },
  )
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-p2' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/repos/web', surface: null, isInteractive: true } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // A project whose only track is archived is still offered, and so is All.
  expect(await ui.find({ text: / api / })).toBeDefined()
  expect(await ui.find({ text: / All / })).toBeDefined()
  // Another project's chat and what it is doing stay out of this project's pane.
  expect(await ui.find({ text: /A chat in api/ })).toBe(undefined)
  expect(await ui.find({ text: /secret\.ts/ })).toBe(undefined)
  // The loop of two moves comes to the person, with a way out.
  expect(await ui.find({ text: /going nowhere/ })).toBeDefined()
  await ui.press({ key: 'unmove-web-2' })
  expect([...files.values()].some(t => t.includes('"id":"2"') && t.includes('"status":"todo"') && t.includes('"origin":"person"'))).toBe(true)
  // A dependency into another project says so.
  await ui.press({ key: 'fold-web' })
  expect(await ui.find({ text: /waits on api\/1 \(in project api\)/ })).toBeDefined()
  // All shows the other chat, and the dependency still says it lies in another project.
  await ui.press({ key: 'proj-all' })
  expect(await ui.find({ text: /A chat in api/ })).toBeDefined()
  expect(await ui.find({ text: /waits on api\/1 \(in project api\)/ })).toBeDefined()
  await ui.unmount()
})

test('the search above the tracks finds tracks and steps, ignoring case and accents', async ($, on) => {
  const off = { required: false }
  const events = [
    { kind: 'plan', at: 1000, session: 's', track: 'api', title: 'API v2', phases: [{ name: 'P', steps: [{ id: '1', title: 'Fence', review: off }, { id: '2', title: 'Zażółć gęślą jaźń', review: off }] }] },
    { kind: 'plan', at: 1001, session: 's', track: 'web', title: 'Web app', phases: [{ name: 'Q', steps: [{ id: '1', title: 'Login page', review: off }] }] },
    { kind: 'plan', at: 1002, session: 's', track: 'old', title: 'Old gesla work', phases: [{ name: 'R', steps: [{ id: '1', title: 'Clean', review: off }] }] },
    { kind: 'triage', at: 1003, session: 'p', track: 'old', archived: true, origin: 'person' },
  ]
  const files = new Map<string, string>(events.map((e, i) => [`/home/t/.claude/roadmap/events/${1000 + i}-o-x.json`, JSON.stringify(e)]))
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-search' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)

  expect(matches('Zażółć gęślą jaźń', 'GESLA zaz')).toBe(true)
  expect(matches('Zażółć gęślą jaźń', 'gesla login')).toBe(false)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // Without a search: the tracks, folded; the archived one is not among them.
    expect(await ui.find({ text: /Web app/ })).toBeDefined()
    expect(await ui.find({ text: /Old gesla work/ })).toBe(undefined)
    expect(await ui.find({ text: /Zażółć/ })).toBe(undefined)
    // Typing narrows as it goes: the matching step shows, opened; another track's title matches too,
    // even archived — a search looks everywhere.
    await ui.input({ key: 'search', text: 'gesla', kind: 'change' })
    expect(await ui.find({ text: /Zażółć gęślą jaźń/ })).toBeDefined()
    expect(await ui.find({ text: /Fence/ })).toBe(undefined)
    expect(await ui.find({ text: /Old gesla work/ })).toBeDefined()
    expect(await ui.find({ text: /Web app/ })).toBe(undefined)
    expect(await ui.find({ text: /2 tracks, 1 step match "gesla"/ })).toBeDefined()
    // A step's ref finds it too.
    await ui.input({ key: 'search', text: 'web/1', kind: 'change' })
    expect(await ui.find({ text: /Login page/ })).toBeDefined()
    await ui.input({ key: 'search', text: 'nothing like it' })
    expect(await ui.find({ text: /Nothing matches "nothing like it"/ })).toBeDefined()
    await ui.press({ key: 'search-clear' })
    expect(await ui.find({ text: /Web app/ })).toBeDefined()
    expect(await ui.find({ text: /API v2/ })).toBeDefined()
    expect(await ui.find({ text: /match/ })).toBe(undefined)
    await ui.unmount()
  }
})

test('a chat older than some state keys still draws the pane and the band', async ($, on) => {
  const plan = { kind: 'plan', at: 1000, session: 's', track: 'api', title: 'API v2', phases: [{ name: 'P', steps: [{ id: '1', title: 'Fence', review: { required: false } }] }] }
  const files = new Map<string, string>([['/home/t/.claude/roadmap/events/1000-o-x.json', JSON.stringify(plan)]])
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-old' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  // This chat's state contract predates these keys: reading or writing them is refused.
  const newer = ['focus', 'phaseOpen', 'editing', 'project', 'outdated', 'search']
  on('state.get', (_$, e: any, next: any) => (newer.includes(e.key) ? { deny: `no state key ${e.key}` } : next(e)))
  on('state.set', (_$, e: any, next: any) => (newer.includes(e.key) ? { deny: `no state key ${e.key}` } : next(e)))
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /API v2/ })).toBeDefined()
  expect(await ui.find({ text: /could not draw/ })).toBe(undefined)
  // Folding a phase and pinning write newer keys: refused quietly, the pane keeps working.
  await ui.press({ key: 'fold-api' })
  expect(await ui.find({ text: /Fence/ })).toBeDefined()
  // Searching writes a newer key too: refused quietly, the tracks stay as they were.
  await ui.input({ key: 'search', text: 'nothing like it', kind: 'change' })
  expect(await ui.find({ text: /API v2/ })).toBeDefined()
  await ui.unmount()
  const band = await $.ui.mount({
    plugin: 'roadmap',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 5 } } as never,
  })
  expect(await band.find({ text: /api 0%/ })).toBeDefined()
  await band.unmount()
})

test('chains: what each step unblocks down the chain, the step to pick next, the longest open chain', async () => {
  const off = { required: false }
  const plan = (at: number, track: string, steps: object[]) => ({ kind: 'plan', at, session: 's', track, phases: [{ name: 'P', steps: steps.map(x => ({ review: off, ...x })) }] }) as RoadmapEvent
  const word = (at: number, track: string, id: string, status: string, extra: object = {}) =>
    ({ kind: 'step', at, session: 'p', track, id, status, origin: 'person', actor: 'person', ...extra }) as RoadmapEvent
  const base = [
    plan(1, 'a', [{ id: '1', title: 'Schema' }, { id: '2', title: 'Client', blockedBy: ['1'] }, { id: '3', title: 'Docs', blockedBy: ['1'] }, { id: '4', title: 'Lint' }]),
    plan(2, 'b', [{ id: '1', title: 'App', blockedBy: ['a/2'] }, { id: '2', title: 'Old path' }, { id: '3', title: 'Uses it', blockedBy: ['2'] }]),
  ]
  const at = (events: RoadmapEvent[], ref: string, lives: any[] = []) => {
    const [t, id] = ref.split('/')
    return fold(events, lives, 99).tracks.find(x => x.name === t)!.steps.find(x => x.id === id)!
  }
  const track = (events: RoadmapEvent[], name: string, lives: any[] = []) => fold(events, lives, 99).tracks.find(x => x.name === name)!
  // Down the chain and across tracks: a/1 → a/2 → b/1, and a/1 → a/3.
  expect(at(base, 'a/1').unblocks).toBe(3)
  expect(at(base, 'a/2').unblocks).toBe(1)
  expect(at(base, 'a/4').unblocks).toBe(0)
  expect(track(base, 'a').longest).toBe(3)
  // The step that unblocks most is next, unless something is more urgent.
  expect(track(base, 'a').next).toBe('a/1')
  expect(track([...base, { kind: 'triage', at: 3, session: 'p', track: 'a', id: '4', priority: 'P1', origin: 'person' } as RoadmapEvent], 'a').next).toBe('a/4')
  // A step a chat holds is not offered as next.
  expect(track(base, 'a', [{ session: 'c', title: 'c', at: 95, agents: [], focus: 'a/1' }]).next).toBe('a/4')
  // A done step in the middle: what waited on it no longer waits on what came before it.
  const midDone = [...base, word(3, 'a', '2', 'done')]
  expect(at(midDone, 'a/1').unblocks).toBe(1)
  expect(at(midDone, 'a/2').unblocks).toBe(undefined)
  // Through a move: b/3 waited on b/2, whose obligation went to a/4 — so a/4 unblocks it.
  const moved = [...base, word(3, 'b', '2', 'moved', { movedTo: 'a/4', reason: 'r' })]
  expect(at(moved, 'a/4').unblocks).toBe(1)
  // A set-aside step neither counts nor is offered.
  const shelved = [...base, { kind: 'triage', at: 3, session: 'p', track: 'a', id: '3', backlog: true, origin: 'person' } as RoadmapEvent]
  expect(at(shelved, 'a/1').unblocks).toBe(2)
  // A loop written by hand does not hang the count.
  const loop = [plan(1, 'x', [{ id: '1', title: 'One', blockedBy: ['2'] }, { id: '2', title: 'Two', blockedBy: ['1'] }])]
  expect(at(loop, 'x/1').unblocks).toBe(1)
  // Agents read it in the summary and the brief.
  const board = fold(base, [], 99)
  expect(summary(board)).toContain('a — a: 0/4 done (next: a/1; longest open chain: 3 steps)')
  expect(summary(board)).toContain('a/1 Schema [unblocks 3]')
  expect(brief(board, 'a', '1')).toContain('Unblocks: 3 open steps wait on it, down the chain')
})

test('the Tracks view marks the next step, what each step unblocks, and the longest chain', async ($, on) => {
  const off = { required: false }
  const plan = { kind: 'plan', at: 1000, session: 's', track: 'api', title: 'API v2', phases: [{ name: 'P', steps: [
    { id: '1', title: 'Schema', review: off }, { id: '2', title: 'Client', blockedBy: ['1'], review: off }, { id: '3', title: 'Docs', blockedBy: ['2'], review: off },
  ] }] }
  const files = new Map<string, string>([['/home/t/.claude/roadmap/events/1000-o-x.json', JSON.stringify(plan)]])
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({ value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })) }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-chain' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /▸ next 1/ })).toBeDefined()
    expect(await ui.find({ text: /chain 3/ })).toBeDefined()
    if (!(await ui.find({ text: /Schema/ }))) await ui.press({ key: 'fold-api' })
    expect(await ui.find({ text: /Schema/ })).toBeDefined()
    expect(await ui.find({ text: /⇢2/ })).toBeDefined()
    expect(await ui.find({ text: /⇢1/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the chain graph: boxes and arrows left to right, moves dashed, the longest open chain marked; Mermaid out', async () => {
  const off = { required: false }
  const plan = (at: number, track: string, steps: object[]) => ({ kind: 'plan', at, session: 's', track, phases: [{ name: 'P', steps: steps.map(x => ({ review: off, ...x })) }] }) as RoadmapEvent
  const word = (at: number, track: string, id: string, status: string, extra: object = {}) =>
    ({ kind: 'step', at, session: 'p', track, id, status, origin: 'person', actor: 'person', ...extra }) as RoadmapEvent
  const events = [
    plan(1, 'api', [{ id: '1', title: 'Pagination' }, { id: '2', title: 'One "error" format', blockedBy: ['1'] }, { id: '3', title: 'Load test', blockedBy: ['2'], checkpoint: true }, { id: '9', title: 'Alone' }]),
    plan(2, 'web', [{ id: '1', title: 'Billing', blockedBy: ['api/2'] }, { id: '2', title: 'Old view' }, { id: '3', title: 'Export', blockedBy: ['2'] }]),
    word(3, 'api', '1', 'done'),
    word(4, 'web', '2', 'moved', { movedTo: 'web/1', reason: 'r' }),
  ]
  const g = chainGraph(fold(events, [], 99))
  // Only steps in some chain; a step alone stays out.
  expect(g.nodes.map(n => n.ref)).toEqual(['api/1', 'api/2', 'api/3', 'web/1', 'web/2', 'web/3'])
  const col = (ref: string) => g.nodes.find(n => n.ref === ref)!.layer
  expect([col('api/1'), col('api/2'), col('api/3'), col('web/1'), col('web/3')]).toEqual([0, 1, 2, 2, 3])
  // A move is a dashed arrow to where it went; what waited on the moved step now hangs off the target.
  expect(g.edges.filter(e => e.moved).map(e => `${e.from}->${e.to}`)).toEqual(['web/2->web/1'])
  expect(g.edges.some(e => e.to === 'web/3' && e.from === 'web/1')).toBe(true)
  expect(g.edges.some(e => e.to === 'web/3' && e.from === 'web/2')).toBe(false)
  // The longest open chain: api/2 → web/1 → web/3 (three open steps), not through the done api/1.
  expect(g.nodes.filter(n => n.critical).map(n => n.ref)).toEqual(['api/2', 'web/1', 'web/3'])
  // Mermaid: valid ids, quotes escaped, a checkpoint as a hexagon, the same text however the board is read.
  const m = mermaidOf(g)
  expect(m.startsWith('```mermaid\nflowchart LR\n')).toBe(true)
  expect(m).toContain('One #quot;error#quot; format')
  expect(m).toContain('s_api_2f_3{{"⊘ api/3 Load test"}}:::blocked')
  expect(m).toContain('s_web_2f_2 -.->|moved| s_web_2f_1')
  for (const line of m.split('\n').filter(l => /^\s+s_/.test(l))) expect(/^\s+s_[A-Za-z0-9_]+/.test(line)).toBe(true)
  expect(mermaidOf(chainGraph(fold([...events].reverse(), [], 99)))).toBe(m)
  expect(mermaidOf(chainGraph(fold([...events, word(5, 'web', '1', 'running')], [], 99))).split('\n').length).toBe(m.split('\n').length)
  // A terminal gets the same as text; a loop written by hand does not hang it.
  // A straight run stays at one indent; only a fork indents its branches.
  expect(chainText(g)).toEqual([
    '✓ api/1 Pagination',
    '→ ○ api/2 One "error" format  ▸ next  ★',
    '   → ⊘ api/3 Load test',
    '   → ⊘ web/1 Billing  ★',
    '   → ⊘ web/3 Export  ★',
    '↪ web/2 Old view',
    '↪ ⊘ web/1 (above)',
  ])
  const loop = chainGraph(fold([plan(1, 'x', [{ id: '1', title: 'One', blockedBy: ['2'] }, { id: '2', title: 'Two', blockedBy: ['1'] }])], [], 9))
  expect(chainText(loop).length).toBeGreaterThan(0)
  // Nothing waits on anything: an empty graph says so in Mermaid too.
  expect(mermaidOf(chainGraph(fold([plan(1, 'z', [{ id: '1', title: 'Solo' }])], [], 9)))).toContain('no dependencies between steps yet')
})

test('chains, second round: set-aside tracks count nowhere, chains cross projects, every character keeps its id', async () => {
  const off = { required: false }
  const plan = (at: number, track: string, steps: object[], project?: string) =>
    ({ kind: 'plan', at, session: 's', track, project, phases: [{ name: 'P', steps: steps.map(x => ({ review: off, ...x })) }] }) as RoadmapEvent
  const shelve = (at: number, track: string) => ({ kind: 'triage', at, session: 'p', track, backlog: true, origin: 'person' }) as RoadmapEvent
  // 4.1: a track in the backlog neither adds to what a/1 unblocks nor lengthens its chain.
  const shelved = [plan(1, 'a', [{ id: '1', title: 'Base' }]), plan(2, 'b', [{ id: '1', title: 'Later', blockedBy: ['a/1'] }, { id: '2', title: 'Then', blockedBy: ['1'] }]), shelve(3, 'b')]
  const sb = fold(shelved, [], 99)
  expect(sb.tracks.find(t => t.name === 'a')!.steps[0]!.unblocks).toBe(0)
  expect(sb.tracks.find(t => t.name === 'a')!.longest).toBe(1)
  expect(chainGraph(sb).nodes.length).toBe(0)
  // 4.2: a chain into another project keeps its arrow, with the other project named — from either side.
  const cross = fold([plan(1, 'a', [{ id: '1', title: 'Base' }], '/repos/a'), plan(2, 'b', [{ id: '1', title: 'Uses it', blockedBy: ['a/1'] }], '/repos/b')], [], 99)
  const fromB = chainGraph(cross, '/repos/b')
  expect(fromB.edges.map(e => `${e.from}->${e.to}`)).toEqual(['a/1->b/1'])
  expect(fromB.nodes.find(n => n.ref === 'a/1')?.external).toBe('a')
  expect(fromB.nodes.find(n => n.ref === 'b/1')?.external).toBe(undefined)
  expect(mermaidOf(fromB)).toContain('a/1 Base (in project a)')
  expect(chainGraph(cross, '/repos/a').nodes.find(n => n.ref === 'b/1')?.external).toBe('b')
  // … and a chain wholly in another project stays out of this one.
  const apart = fold([plan(1, 'a', [{ id: '1', title: 'X' }, { id: '2', title: 'Y', blockedBy: ['1'] }], '/repos/a'), plan(2, 'b', [{ id: '1', title: 'Z' }], '/repos/b')], [], 99)
  expect(chainGraph(apart, '/repos/b').nodes.length).toBe(0)
  // A moved step in a set-aside track still hands its dependents to where its obligation went.
  const movedAside = fold(
    [
      plan(1, 'a', [{ id: '2', title: 'Target' }, { id: '3', title: 'Waits', blockedBy: ['c/1'] }]),
      plan(2, 'c', [{ id: '1', title: 'Old' }]),
      { kind: 'step', at: 3, session: 'p', track: 'c', id: '1', status: 'moved', movedTo: 'a/2', reason: 'r', origin: 'person' } as RoadmapEvent,
      shelve(4, 'c'),
    ],
    [],
    99,
  )
  expect(chainGraph(movedAside).edges.map(e => `${e.from}->${e.to}`)).toEqual(['a/2->a/3'])
  // Mermaid ids: two emoji ids stay two nodes, and no arrow points at itself.
  const emoji = chainGraph(fold([plan(1, 'e', [{ id: '😀', title: 'Smile' }, { id: '😁', title: 'Grin', blockedBy: ['😀'] }])], [], 9))
  const m = mermaidOf(emoji)
  const ids = m.split('\n').filter(l => /\["/.test(l)).map(l => l.trim().split('[')[0])
  expect(new Set(ids).size).toBe(2)
  const arrow = m.split('\n').find(l => l.includes('==>') || l.includes('-->'))!.trim().split(/\s+/)
  expect(arrow[0]).not.toBe(arrow[2])
})

test('chains, one track at a time: its road ahead, its neighbours, no shortcuts, never too wide', async () => {
  const off = { required: false }
  const plan = (at: number, track: string, steps: object[]) => ({ kind: 'plan', at, session: 's', track, phases: [{ name: 'P', steps: steps.map(x => ({ review: off, ...x })) }] }) as RoadmapEvent
  const done = (at: number, track: string, id: string) => ({ kind: 'step', at, session: 'p', track, id, status: 'done', origin: 'person', actor: 'person' }) as RoadmapEvent
  const events = [
    plan(1, 'a', [
      { id: '0', title: 'Long done' }, { id: '1', title: 'Done base', blockedBy: ['0'] }, { id: '2', title: 'Open', blockedBy: ['1'] },
      { id: '3', title: 'Then', blockedBy: ['2', '1'] }, { id: '4', title: 'Side', blockedBy: ['2'] }, { id: '5', title: 'Side 2', blockedBy: ['2'] },
    ]),
    plan(2, 'b', [{ id: '1', title: 'Vendor' }, { id: '2', title: 'Far away', blockedBy: ['1'] }]),
    plan(3, 'c', [{ id: '1', title: 'Uses a/3', blockedBy: ['a/3'] }]),
    plan(4, 'x', [{ id: '1', title: 'X', blockedBy: ['b/1'] }]),
    done(5, 'a', '0'),
    done(6, 'a', '1'),
  ]
  const board = fold(events, [], 99)
  const g = chainGraph(board, undefined, { track: 'a' })
  const refs = g.nodes.map(n => n.ref)
  // The done step that leads to an open one stays (context); the one before it folds away.
  expect(refs).toContain('a/1')
  expect(refs).not.toContain('a/0')
  expect(g.hidden).toBe(1)
  // A neighbour in another track is shown, marked; a step two tracks away is not.
  expect(g.nodes.find(n => n.ref === 'c/1')?.foreign).toBe(true)
  expect(refs).not.toContain('b/1')
  // a/1 → a/3 is implied by a/1 → a/2 → a/3: drawn once, through a/2.
  expect(g.edges.some(e => e.from === 'a/1' && e.to === 'a/3')).toBe(false)
  expect(g.edges.some(e => e.from === 'a/2' && e.to === 'a/3')).toBe(true)
  // Three steps side by side wrap to the pane's width instead of widening the picture.
  // Review round: a chain through two other tracks stays whole (a/1 → b/1 → c/1 → a/2).
  const through = chainGraph(
    fold(
      [
        plan(1, 'a', [{ id: '1', title: 'Start' }, { id: '2', title: 'End', blockedBy: ['c/1'] }]),
        plan(2, 'b', [{ id: '1', title: 'Middle', blockedBy: ['a/1'] }]),
        plan(3, 'c', [{ id: '1', title: 'Later', blockedBy: ['b/1'] }]),
      ],
      [],
      9,
    ),
    undefined,
    { track: 'a' },
  )
  expect(through.edges.map(e => `${e.from}->${e.to}`).sort()).toEqual(['a/1->b/1', 'b/1->c/1', 'c/1->a/2'])
  // This chat's finished step is never folded away.
  const old = fold([...events, done(7, 'a', '0')], [], 99)
  expect(chainGraph(old, undefined, { track: 'a' }).nodes.some(n => n.ref === 'a/0')).toBe(false)
  expect(chainGraph(old, undefined, { track: 'a', focus: 'a/0' }).nodes.some(n => n.ref === 'a/0')).toBe(true)
  // This chat's step is marked: in the text tree, and with a halo in the drawing.
  expect(chainText(g, 'a/2').some(l => l.includes('a/2 Open') && l.includes('● this chat'))).toBe(true)
  expect(chainSvg(g, { focus: 'a/2' }).svg).toContain('#f0883e')
  expect(chainSvg(g).svg).not.toContain('#f0883e')
  const narrow = chainSvg(g, { maxAcross: 1 })
  const wide = chainSvg(g, { maxAcross: 3 })
  expect(narrow.width).toBeLessThan(wide.width)
  expect(narrow.height).toBeGreaterThan(wide.height)
})

test('a chain too large for the drawing element reads as text instead', async ($, on) => {
  const off = { required: false }
  const steps = Array.from({ length: 320 }, (_, i) => ({ id: `${i}`, title: `Step number ${i} of a very long chain of work`, review: off, ...(i ? { blockedBy: [`${i - 1}`] } : {}) }))
  const plan = { kind: 'plan', at: 1000, session: 's', track: 'big', title: 'Big', phases: [{ name: 'P', steps }] }
  const files = new Map<string, string>([['/home/t/.claude/roadmap/events/1000-o-x.json', JSON.stringify(plan)]])
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({ value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })) }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-big' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'view-chains' })
  expect(await ui.find({ text: /Too large to draw here/ })).toBeDefined()
  expect(await ui.find({ text: /big\/0 Step number 0/ })).toBeDefined()
  await ui.unmount()
})

test('the Chains tab draws the graph (a text tree in the terminal) and copies it as Mermaid', async ($, on) => {
  const off = { required: false }
  const plan = { kind: 'plan', at: 1000, session: 's', track: 'api', title: 'API v2', phases: [{ name: 'P', steps: [
    { id: '1', title: 'Schema', blockedBy: ['ext/1'], review: off }, { id: '2', title: 'Client', blockedBy: ['1'], review: off },
  ] }] }
  // A step of another project that this chat's chain waits on.
  const ext = { kind: 'plan', at: 999, session: 's', track: 'ext', title: 'Vendor', project: '/other', phases: [{ name: 'P', steps: [{ id: '1', title: 'Vendor SDK', review: off }] }] }
  const files = new Map<string, string>([
    ['/home/t/.claude/roadmap/events/1000-o-x.json', JSON.stringify(plan)],
    ['/home/t/.claude/roadmap/events/0999-o-x.json', JSON.stringify(ext)],
  ])
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({ value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })) }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-chains' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  const copied: string[] = []
  on('ui.copy', (_$, e) => {
    copied.push((e as { text: string }).text)
    return { value: { isCopied: true } }
  })
  const opened: any[] = []
  on('ui.open', (_$, e) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)
  // A second track with a chain: the tab offers both, one at a time, starting with this chat's.
  files.set('/home/t/.claude/roadmap/events/1001-o-x.json', JSON.stringify({ kind: 'plan', at: 1001, session: 's', track: 'web', title: 'Web', phases: [{ name: 'P', steps: [{ id: '1', title: 'Page', review: off }, { id: '2', title: 'Form', blockedBy: ['1'], review: off }] }] }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'view-chains' })
    expect(await ui.find({ text: /\[api\]/ })).toBeDefined()
    if (surface === 'terminal') expect(await ui.find({ text: /web\/2 Form/ })).toBe(undefined)
    await ui.press({ key: 'chain-track-1' })
    if (surface === 'terminal') expect(await ui.find({ text: /→ ⊘ web\/2 Form/ })).toBeDefined()
    await ui.press({ key: 'chain-track-0' })
    expect(await ui.find({ text: /Copy as Mermaid/ })).toBeDefined()
    if (surface === 'terminal') {
      expect(await ui.find({ text: /→ ⊘ api\/2 Client/ })).toBeDefined()
      expect(await ui.find({ text: /ext\/1 Vendor SDK \(in project other\)/ })).toBeDefined()
    }
    await ui.press({ key: 'copy-mermaid' })
    expect(copied.pop()).toContain('s_api_2f_1 ==> s_api_2f_2')
    if (surface === 'desktop') {
      // ⤢ Wide opens the diagram alone in a wide pane of its own.
      await ui.press({ key: 'chain-wide' })
      expect(opened.some(o => o.id === 'roadmap-chains' && o.columns === 200 && o.closeOnEscape === true)).toBe(true)
    } else expect(await ui.find({ text: /⤢ Wide/ })).toBe(undefined)
    await ui.press({ key: 'view-tracks' })
    await ui.unmount()
  }
  // Pinned to api/2, the tab says where this chat stands in the chain.
  const pinned = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pinned.press({ key: 'fold-api' })
  await pinned.press({ key: 'pin-api/2' })
  await pinned.press({ key: 'view-chains' })
  expect(await pinned.find({ text: /● this chat/ })).toBeDefined()
  expect(await pinned.find({ text: /level 3 of 3/ })).toBeDefined()
  await pinned.press({ key: 'view-tracks' })
  await pinned.unmount()
  const wide = await $.ui.mount({ ...PANE, requestId: 'roadmap-chains', surface: 'desktop' })
  expect(await wide.find({ text: /Esc closes this pane/ })).toBeDefined()
  expect(await wide.find({ text: /Copy as Mermaid/ })).toBeDefined()
  expect(await wide.find({ text: /⤢ Wide/ })).toBe(undefined)
  await wide.unmount()
  // A track whose chains are all done says so, and Show done draws them.
  files.set('/home/t/.claude/roadmap/events/1002-o-x.json', JSON.stringify({ kind: 'step', at: 1002, session: 'p', track: 'web', id: '1', status: 'done', origin: 'person', actor: 'person' }))
  files.set('/home/t/.claude/roadmap/events/1003-o-x.json', JSON.stringify({ kind: 'step', at: 1003, session: 'p', track: 'web', id: '2', status: 'done', origin: 'person', actor: 'person' }))
  const later = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await later.press({ key: 'view-chains' })
  await later.press({ key: 'chain-track-1' })
  expect(await later.find({ text: /Nothing open in this track's chains: 2 finished steps are folded/ })).toBeDefined()
  await later.press({ key: 'chain-done' })
  expect(await later.find({ text: /→ ✓ web\/2 Form/ })).toBeDefined()
  await later.unmount()
})

test('the pane names whose review is owed: the other model by name, else in general terms', async () => {
  const cross = { required: true, independence: 'cross-model' }
  expect(whoseReview({ review: cross, implementer: { actor: 'claude' } })).toBe("Codex's review")
  expect(whoseReview({ review: cross, implementer: { actor: 'codex' } })).toBe("Claude's review")
  expect(whoseReview({ review: cross, implementer: { actor: 'gemini' } })).toBe("another model's review")
  expect(whoseReview({ review: { independence: 'other-session' } })).toBe('a review from another chat')
  expect(whoseReview({ review: { independence: 'any' } })).toBe('a review')
})

test('a reviewer cannot reopen the work it came to review by marking it running', async () => {
  const cross = { required: true, independence: 'cross-model', mode: 'adversarial' }
  const plan = { kind: 'plan', at: 1, session: 's', track: 'a', phases: [{ name: 'P', steps: [{ id: '1', title: 'Harness', review: cross }, { id: '2', title: 'Gate', checkpoint: true, review: { required: false } }] }] } as RoadmapEvent
  const claude = (events: RoadmapEvent[], now: number) => ({ events, lives: [], now, session: 'c1', actor: 'claude', via: 'claude-code', channel: 'tool' as const })
  const codex = (events: RoadmapEvent[], now: number) => ({ events, lives: [], now, session: 'x1', actor: 'codex', via: 'codex-sandbox', channel: 'cli' as const })
  let events: RoadmapEvent[] = [plan]
  events = [...events, ...markAction(claude(events, 10), { step: 'a/1', status: 'running' }).emit]
  events = [...events, ...doneAction(claude(events, 20), { step: 'a/1', shipped: 'harness' }).emit]
  const step = (evs: RoadmapEvent[], id = '1') => fold(evs, [], 99).tracks[0]!.steps.find(x => x.id === id)!
  expect(step(events).reviewPending).toBe(true)
  // The reviewer's reflex — mark it running — is refused, and says what to do instead.
  const reflex = markAction(codex(events, 30), { step: 'a/1', status: 'running' })
  expect(reflex.ok).toBe(false)
  expect(reflex.text).toContain('Reviewing it? Do not mark it running')
  expect(reflex.text).toContain('roadmap review a/1')
  // Saying "I am reviewing" writes nothing: the report and its implementer stay.
  const start = reviewAction(codex(events, 30), { step: 'a/1', start: true })
  expect(start.ok).toBe(true)
  expect(start.emit).toEqual([])
  expect(start.focus).toBe('a/1')
  // The verdict then counts for Claude's work.
  events = [...events, ...reviewAction(codex(events, 40), { step: 'a/1', verdict: 'pass', evidence: 'ok' }).emit]
  expect(step(events).implementer?.actor).toBe('claude')
  expect(step(events).reviewState).toBe('reviewed')
  // Reopening on purpose still works, and says so in its consequences.
  const reopened = markAction(codex([...events.slice(0, 3)], 50), { step: 'a/1', status: 'running', reopen: true })
  expect(reopened.ok).toBe(true)
  expect(step([...events.slice(0, 3), ...reopened.emit]).implementer?.actor).toBe('codex')
  // A checkpoint awaiting the person is guarded the same way (without the review hint).
  let cp: RoadmapEvent[] = [plan]
  cp = [...cp, ...markAction(claude(cp, 10), { step: 'a/2', status: 'running' }).emit]
  cp = [...cp, ...doneAction(claude(cp, 20), { step: 'a/2', shipped: 'gate' }).emit]
  const cpRun = markAction(codex(cp, 30), { step: 'a/2', status: 'running' })
  expect(cpRun.ok).toBe(false)
  expect(cpRun.text).toContain("waits for the person's confirmation")
  expect(cpRun.text).not.toContain('Reviewing it?')
  // A step not yet reported runs as before.
  expect(markAction(codex([plan], 5), { step: 'a/1', status: 'running' }).ok).toBe(true)
  // The brief tells a reviewer up front.
  expect(brief(fold(events.slice(0, 3), [], 99), 'a', '1')).toContain('Reviewing it? Do not mark it running')
})

test('a pane whose data never comes says so in time, and a (re)loaded module asks its panes to redraw', async ($, on) => {
  const plan = { kind: 'plan', at: 1000, session: 's', track: 'api', title: 'API v2', phases: [{ name: 'P', steps: [{ id: '1', title: 'Fence', review: { required: false } }] }] }
  const files = new Map<string, string>([['/home/t/.claude/roadmap/events/1000-o-x.json', JSON.stringify(plan)]])
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({ value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })) }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-stuck' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  const asked: string[] = []
  on('ui.invalidate', (_$, e: any) => {
    asked.push(String(e?.event ?? e))
    return { value: undefined }
  })
  on('clock.sleep', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)
  expect(asked.some(a => a.includes('ui.render'))).toBe(true)
  // The load is written to this chat's diagnostics log, where a blank pane can be traced later.
  const log = [...files.entries()].find(([path]) => path === '/home/t/.claude/roadmap/diag/session-stuck.log')?.[1] ?? ''
  expect(log).toContain('module loaded')
  expect(log).toContain('journal read in')
  // Data that never comes: the wait ends with a reason the pane draws, instead of the host's placeholder.
  const late = await inTime(() => Promise.resolve(), new Promise<never>(() => undefined)).then(
    () => 'drawn',
    (err: Error) => err.message,
  )
  expect(late).toContain('did not come in time')
  // Data that comes is passed through.
  expect(await inTime(() => new Promise(() => undefined), Promise.resolve('board'))).toBe('board')
})

test('the pane shows a review owed and offers the person to confirm without it', async ($, on) => {
  const plan = {
    kind: 'plan',
    at: 1000,
    session: 's',
    track: 'api',
    title: 'API v2',
    review: { required: true, independence: 'cross-model' },
    phases: [{ name: 'P', steps: [{ id: '1', title: 'Fence' }] }],
  }
  const events = [
    plan,
    { kind: 'step', at: 1100, session: 'c1', track: 'api', id: '1', status: 'running', actor: 'claude', origin: 'agent' },
    { kind: 'step', at: 1200, session: 'c1', track: 'api', id: '1', status: 'done', actor: 'claude', origin: 'agent' },
  ]
  const files = new Map<string, string>(events.map((e, i) => [`/home/t/.claude/roadmap/events/${1000 + i}-o-x.json`, JSON.stringify(e)]))
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-eighteen' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /waits for Codex's review — a model other than claude must review it/ })).toBeDefined()
    expect(await ui.find({ text: /Confirm without Codex's review/ })).toBeDefined()
    await ui.press({ key: 'fold-api' })
    expect(await ui.find({ text: /review owed/ })).toBeDefined()
    await ui.press({ key: 'fold-api' })
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'ok-api-1' })
  expect(await ui.find({ text: /Confirm without/ })).toBe(undefined)
  expect(await ui.find({ text: /100%/ })).toBeDefined()
  await ui.unmount()
})

test('a reviewer files its findings as follow-ups, also after the person accepted the review', async () => {
  const events = [
    { kind: 'plan', at: 1, session: 's', track: 'api', review: { required: true, independence: 'cross-model' }, phases: [{ name: 'P', steps: [{ id: '1', title: 'A' }] }] },
    { kind: 'step', at: 2, session: 'c1', track: 'api', id: '1', status: 'running', actor: 'claude', origin: 'agent' },
    { kind: 'step', at: 3, session: 'c1', track: 'api', id: '1', status: 'done', actor: 'claude', origin: 'agent' },
    { kind: 'review', at: 4, session: 'x1', track: 'api', id: '1', actor: 'codex', verdict: 'findings', via: 'codex-sandbox' },
    { kind: 'step', at: 5, session: 'p', track: 'api', id: '1', status: 'done', actor: 'person', origin: 'person' },
  ] as RoadmapEvent[]
  const r = reviewAction(
    { events, lives: [], now: 10, session: 'x1', actor: 'codex', via: 'codex-sandbox', channel: 'cli' },
    { step: 'api/1', verdict: 'findings', evidence: 'two loose ends', follow_ups: [{ title: 'Tighten the probe', priority: 'P2' }, { title: '' }] },
  )
  expect(r.ok).toBe(true)
  expect(r.text).toMatch(/api\/f\w+ Tighten the probe/)
  const board = fold([...events, ...r.emit], [], 99)
  const steps = board.tracks[0]!.steps
  // The accepted step stays done; the finding waits in the backlog, under Follow-ups, for the person.
  expect(steps.find(x => x.id === '1')?.status).toBe('done')
  const f = steps.find(x => x.title === 'Tighten the probe')
  expect(f?.backlog).toBe(true)
  expect(f?.priority).toBe('P2')
  expect(board.tracks[0]!.phases.find(p => p.stepIds.includes(f!.id))?.name).toBe(FOLLOW_UPS)
  expect(steps.length).toBe(2)
})

test('every review round stays visible: a fail, the fixes, the next pass', async ($, on) => {
  const plan = {
    kind: 'plan',
    at: 1000,
    session: 's',
    track: 'api',
    title: 'API v2',
    review: { required: true, independence: 'cross-model' },
    phases: [{ name: 'P', steps: [{ id: '1', title: 'Fence' }] }],
  }
  const events = [
    plan,
    { kind: 'step', at: 1100, session: 'c1', track: 'api', id: '1', status: 'running', actor: 'claude', origin: 'agent' },
    { kind: 'step', at: 1200, session: 'c1', track: 'api', id: '1', status: 'done', actor: 'claude', origin: 'agent' },
    { kind: 'review', at: 1300, session: 'x1', track: 'api', id: '1', actor: 'codex', verdict: 'fail', via: 'codex-sandbox', evidence: 'two holes' },
    { kind: 'step', at: 1400, session: 'c1', track: 'api', id: '1', status: 'running', actor: 'claude', origin: 'agent' },
    { kind: 'step', at: 1500, session: 'c1', track: 'api', id: '1', status: 'done', actor: 'claude', origin: 'agent' },
    { kind: 'review', at: 1600, session: 'x1', track: 'api', id: '1', actor: 'codex', verdict: 'findings', via: 'codex-sandbox', evidence: 'holes closed' },
  ]
  // The fold keeps every round; only the one after the latest done counts.
  const step = fold(events as RoadmapEvent[], [], 9999).tracks[0]!.steps[0]!
  expect(step.reviewRounds?.map(r => r.verdict)).toEqual(['fail', 'findings'])
  expect(step.reviews.map(r => r.verdict)).toEqual(['findings'])
  expect(step.reviewState).toBe('reviewed')
  const text = brief(fold(events as RoadmapEvent[], [], 9999), 'api', '1')
  expect(text).toContain('round 1, review by codex: fail (of earlier work) — two holes')
  expect(text).toContain('round 2, review by codex: findings — holes closed')
  const files = new Map<string, string>(events.map((e, i) => [`/home/t/.claude/roadmap/events/${1000 + i}-o-x.json`, JSON.stringify(e)]))
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-rounds' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // The step leads its line (the track's long title used to push it out of sight).
    expect(await ui.find({ text: /^api\/1 $/ })).toBeDefined()
    expect(await ui.find({ text: /findings by codex \(codex-sandbox\) · round 2, before: fail — holes closed/ })).toBeDefined()
    expect(await ui.find({ text: /^Confirm ✓$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the pane shows a cross-model pass with its reviewer, for the person to confirm', async ($, on) => {
  const plan = {
    kind: 'plan',
    at: 1000,
    session: 's',
    track: 'api',
    title: 'API v2',
    review: { required: true, independence: 'cross-model' },
    phases: [{ name: 'P', steps: [{ id: '1', title: 'Fence' }] }],
  }
  const events = [
    plan,
    { kind: 'step', at: 1100, session: 'c1', track: 'api', id: '1', status: 'running', actor: 'claude', origin: 'agent' },
    { kind: 'step', at: 1200, session: 'c1', track: 'api', id: '1', status: 'done', actor: 'claude', origin: 'agent' },
    { kind: 'review', at: 1300, session: 'x1', track: 'api', id: '1', actor: 'codex', verdict: 'pass', via: 'codex-sandbox', evidence: 'no findings' },
  ]
  const files = new Map<string, string>(events.map((e, i) => [`/home/t/.claude/roadmap/events/${1000 + i}-o-x.json`, JSON.stringify(e)]))
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-eighteen' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /pass by codex \(codex-sandbox\) — no findings/ })).toBeDefined()
    expect(await ui.find({ text: /Confirm without/ })).toBe(undefined)
    expect(await ui.find({ text: /Confirm ✓/ })).toBeDefined()
    await ui.press({ key: 'fold-api' })
    expect(await ui.find({ text: /reviewed · to confirm/ })).toBeDefined()
    await ui.press({ key: 'fold-api' })
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'ok-api-1' })
  expect(await ui.find({ text: /Confirm ✓/ })).toBe(undefined)
  expect(await ui.find({ text: /100%/ })).toBeDefined()
  await ui.unmount()
})

test('the pane offers a proposed move for the person to confirm, then shows where it went', async ($, on) => {
  const plan = {
    kind: 'plan',
    at: 1000,
    session: 's',
    track: 'api',
    title: 'API v2',
    phases: [{ name: 'P', steps: [{ id: '1', title: 'Fence', review: { required: false } }, { id: '2', title: 'Unified fence', review: { required: false } }] }],
  }
  const events = [
    plan,
    { kind: 'step', at: 1100, session: 'c1', track: 'api', id: '1', status: 'moved', movedTo: 'api/2', reason: 'folded into the unified fence', actor: 'claude', origin: 'agent' },
  ]
  const files = new Map<string, string>(events.map((e, i) => [`/home/t/.claude/roadmap/events/${1000 + i}-o-x.json`, JSON.stringify(e)]))
  const under = (dir: string) =>
    [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/'))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 }))
  on('fs.list', (_$, e) => ({
    value: under(e.path ?? '').map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'session-eighteen' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => e)
  await $.session.start({ source: 'startup', cwd: '/w', surface: null, isInteractive: true } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /proposes moving it to api\/2: folded into the unified fence/ })).toBeDefined()
    expect(await ui.find({ text: /Confirm move/ })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'ok-api-1' })
  expect(await ui.find({ text: /Confirm move/ })).toBe(undefined)
  expect([...files.values()].some(t => t.includes('"status":"moved"') && t.includes('"origin":"person"') && t.includes('"movedTo":"api/2"'))).toBe(true)
  await ui.unmount()
})
