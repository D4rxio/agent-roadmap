import { expect, test } from 'claude-code/testing'

import { YOUR_PHASE, dayLabel, dayOf, days, fold, progress, parseRef, refInText, summary, timelineBar, trackMarkdown, when } from '../hooks/model'
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
    expect(await ui.find({ text: /Map endpoints/ })).toBe(undefined)
    await ui.press({ key: 'fold-api' })
    expect(await ui.find({ text: /Map endpoints/ })).toBeDefined()
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
  expect(await ui.find({ text: /u1 {2}test on iPad/ })).toBeDefined()
  expect(await ui.find({ text: /✎ you/ })).toBeDefined()

  await ui.press({ key: 'cycle-api/u1' })
  expect(await ui.find({ text: /running|for / })).toBeDefined()
  await ui.press({ key: 'cycle-api/u1' })
  expect(await ui.find({ text: /33%/ })).toBeDefined()

  await ui.press({ key: 'rename-api/u1' })
  await ui.input({ key: 'edit-api/u1', text: 'iPad + iPhone' })
  expect(await ui.find({ text: /u1 {2}iPad \+ iPhone/ })).toBeDefined()

  await ui.press({ key: 'remove-api/u1' })
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
