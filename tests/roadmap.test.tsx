import { expect, test } from 'claude-code/testing'

import { doneAction, markAction, planAction, stepAction } from '../hooks/actions'
import { versionAtLeast } from '../hooks/register'

import { FOLLOW_UPS, STALE_MS, YOUR_PHASE, brief, nextId, dayLabel, dayOf, days, findCycle, fold, progress, parseRef, refInText, summary, timelineBar, trackMarkdown, when } from '../hooks/model'
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
    track: 'web',
    phases: [{ name: 'Build', steps: [{ id: '1', title: 'A', blocked_by: ['2'] }, { id: '2', title: 'B', blocked_by: ['1'] }] }],
  })
  expect(String(looped.result)).toContain('Not laid out')
  expect([...files.keys()].filter(p => p.includes('/events/')).length).toBe(0)

  await $.tool.call({
    tool: 'mcp__roadmap__plan',
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
    phases: [{ name: 'P', steps: [{ id: '1', title: 'A', done_when: 'tests green' }, { id: '2', title: 'B', blocked_by: ['1'] }] }],
  })
  expect(laid.ok).toBe(true)
  expect(laid.emit[0]?.kind).toBe('plan')
  expect(laid.track).toBe('api')
  const events = laid.emit

  const loop = planAction(ctx(events), { track: 'x', phases: [{ name: 'P', steps: [{ id: 'a', title: 'A', blocked_by: ['a'] }] }] })
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
