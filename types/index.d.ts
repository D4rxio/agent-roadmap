export type RoadmapStatus = 'todo' | 'running' | 'done' | 'failed' | 'blocked' | 'awaiting' | 'skipped'

export type RoadmapPriority = 'P0' | 'P1' | 'P2' | 'P3'

/** Who wrote an event: the person (pane buttons) or a worker (a Claude session, Codex, …). */
export type RoadmapOrigin = 'person' | 'agent'

export type RoadmapPlanStep = {
  id: string
  title: string
  /** Only the person closes it: a worker's `done` leaves it awaiting confirmation. */
  checkpoint?: boolean
  /** Step ids (same track) or `<track>/<id>` that must be done first. */
  blockedBy?: string[]
  /** Why this step exists: the problem it solves. */
  why?: string
  /** Its boundaries: what is in, and what must not be touched. */
  scope?: string
  /** How to tell it is finished: the done criteria. */
  doneWhen?: string
}

/** One line of the shared journal: each is its own file, so sessions never overwrite each other. */
export type RoadmapEvent =
  | {
      kind: 'plan'
      at: number
      session: string
      track: string
      title?: string
      phases: { name: string; steps: RoadmapPlanStep[] }[]
      actor?: string
    }
  | {
      kind: 'step'
      at: number
      session: string
      track: string
      id: string
      status: RoadmapStatus
      note?: string
      evidence?: string
      /** Why a step is skipped: required with `skipped`. */
      reason?: string
      origin?: RoadmapOrigin
      actor?: string
    }
  | { kind: 'session'; at: number; session: string; title: string; track?: string; actor?: string }
  | {
      kind: 'agent'
      at: number
      session: string
      agentId: string
      description: string
      type: string
      track?: string
      step?: string
    }
  | { kind: 'agent-end'; at: number; session: string; agentId: string; status: RoadmapStatus }
  /** A step the person added from the pane: laid over every plan, so a re-laid track keeps it. */
  | {
      kind: 'add'
      at: number
      session: string
      track: string
      id: string
      title: string
      phase?: string
      origin?: RoadmapOrigin
    }
  /** A rename or removal of a step; the latest word on a title wins, a plan's included. */
  | {
      kind: 'edit'
      at: number
      session: string
      track: string
      id: string
      title?: string
      removed?: boolean
      origin?: RoadmapOrigin
    }
  /**
   * Planning, not execution: a priority (`null` clears it) and/or the backlog flag. Per field the
   * person's latest word wins; an agent's applies only where the person has said nothing.
   */
  | {
      kind: 'triage'
      at: number
      session: string
      track: string
      /** Absent: the whole track. */
      id?: string
      priority?: RoadmapPriority | null
      backlog?: boolean
      origin?: RoadmapOrigin
    }

/** A session's live file, rewritten while it works: what it and its agents do right now. */
export type RoadmapLive = {
  session: string
  title: string
  track?: string
  /** What the main loop does now: its last tool call, shortened. */
  activity?: string
  /** The item this chat holds: `<track>/<id>` (or a bare track). */
  focus?: string
  at: number
  agents: { agentId: string; activity?: string; tools: number }[]
}

export type RoadmapStep = {
  track: string
  id: string
  title: string
  phase: string
  status: RoadmapStatus
  startedAt?: number
  endedAt?: number
  note?: string
  evidence?: string
  checkpoint: boolean
  blockedBy: string[]
  /** Who last moved it: a session title, `you`, or an actor. */
  lastBy?: string
  lastAt?: number
  agents: string[]
  /** Set on a step the person added; an agent may refine it, the mark stays. */
  addedBy?: 'you'
  /** Why it was skipped (with `skipped`, or with `awaiting` when a worker proposes a skip). */
  skipReason?: string
  /** What an `awaiting` step waits for the person to confirm. */
  proposed?: 'done' | 'skipped'
  /** Why this step exists: the problem it solves. */
  why?: string
  /** Its boundaries: what is in, and what must not be touched. */
  scope?: string
  /** How to tell it is finished: the done criteria. */
  doneWhen?: string
  priority?: RoadmapPriority
  /** Set aside: kept with its status, left out of the track's progress until restored. */
  backlog: boolean
  /** `you` when the person set the priority or backlog, else the agent session that did. */
  triagedBy?: string
}

export type RoadmapTrack = {
  name: string
  title: string
  phases: { name: string; stepIds: string[] }[]
  steps: RoadmapStep[]
  createdAt: number
  updatedAt: number
  priority?: RoadmapPriority
  /** The whole track set aside: out of the main list, the status line and next work. */
  backlog: boolean
  triagedBy?: string
}

export type RoadmapSession = {
  id: string
  title: string
  actor: string
  track?: string
  startedAt: number
  lastAt: number
  isLive: boolean
  activity?: string
  /** The item this live chat holds, `<track>/<id>`. */
  focus?: string
}

export type RoadmapAgent = {
  id: string
  session: string
  description: string
  type: string
  track?: string
  step?: string
  status: RoadmapStatus
  startedAt: number
  endedAt?: number
  activity?: string
  tools: number
}

export type RoadmapBoard = {
  tracks: RoadmapTrack[]
  sessions: RoadmapSession[]
  agents: RoadmapAgent[]
  at: number
}

export type RoadmapWindow = '1h' | '24h' | '7d' | 'all'

declare module 'claude-code' {
  interface PluginState {
    roadmap: {
      board: RoadmapBoard
      window: RoadmapWindow
      collapsed: string[]
      view: 'tracks' | 'days'
      expanded: string[]
      paneOpen: boolean
      band: boolean
      tz: number
      /** `<track>/<id>` of the step whose title is being edited, or ''. */
      editing: string
      /** The item this chat holds, `<track>/<id>`, or ''. */
      focus: string
      /** Phases this chat opened or closed by hand, `<track>::<phase>` → open; others follow the default. */
      phaseOpen: Record<string, boolean>
    }
  }
}
