export type RoadmapStatus = 'todo' | 'running' | 'done' | 'failed' | 'blocked' | 'awaiting' | 'skipped' | 'moved'

export type RoadmapPriority = 'P0' | 'P1' | 'P2' | 'P3'

/** Who wrote an event: the person (pane buttons) or a worker (a Claude session, Codex, …). */
export type RoadmapOrigin = 'person' | 'agent'

/**
 * How a step's work must be reviewed before it counts as done.
 * `independence`: `any` reviewer; `other-session` — not the session that implemented it;
 * `cross-model` — a different model family from the implementer's (Claude implements → e.g. Codex
 * reviews, and the other way round). `mode` says what kind of review is asked for.
 */
export type RoadmapReviewPolicy = {
  required: boolean
  independence?: 'any' | 'other-session' | 'cross-model'
  mode?: 'standard' | 'adversarial'
}

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
  /** How its work must be reviewed; absent, the track's default applies. */
  review?: RoadmapReviewPolicy
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
      /** The track's default review policy for its steps. */
      review?: RoadmapReviewPolicy
      actor?: string
    }
  /** A review of a step's work, written by the reviewer (its own session and actor). */
  | {
      kind: 'review'
      at: number
      session: string
      track: string
      id: string
      actor: string
      verdict: 'pass' | 'findings' | 'fail'
      evidence?: string
      note?: string
      /**
       * How `actor` was established: `claude-code` (the mod's own tool), `process` (the CLI found the
       * nearest Codex or Claude process above it), `codex-sandbox` (inside Codex's sandbox, where the
       * process tree cannot be read) or `declared` (`--actor` / $ROADMAP_ACTOR, nothing behind it — never
       * counts as a cross-model review).
       */
      via?: string
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
      /** Why a step is skipped or moved: required with `skipped` and `moved`. */
      reason?: string
      /** With `moved`: the step (`<track>/<id>`) its obligation now lives in. */
      movedTo?: string
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
      /** A whole track archived (true) or brought back (false). The person's word only. */
      archived?: boolean
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
  proposed?: 'done' | 'skipped' | 'moved'
  /** With `moved` (or a proposed move): the step its obligation was handed to, and why. */
  movedTo?: string
  moveReason?: string
  /** Where the obligation ends up after a chain of moves; absent when the chain is broken or loops. */
  movedFinal?: string
  /** Steps whose obligation was moved here (directly or through a chain): this step answers for them. */
  carries?: string[]
  /** Running, but nobody has been on it for a while: probably abandoned. Computed, never written. */
  stale?: boolean
  /** The review policy in force (the step's, else its track's). */
  review?: RoadmapReviewPolicy
  /** Who implemented it: the last worker that started or finished it. */
  implementer?: { actor: string; session: string }
  /** Reviews recorded since the current attempt started, oldest first. */
  reviews: RoadmapReview[]
  /** `satisfied` once a qualifying review passed; `missing` while one is owed; `failed` after a qualifying fail. */
  reviewState?: 'satisfied' | 'missing' | 'failed' | 'reviewed'
  /**
   * The qualifying review that passed, if one did. Under a cross-model policy a pass is `reviewed`, not
   * `satisfied`: no agent on this machine can prove which model wrote a review, so the person confirms.
   */
  passedReview?: RoadmapReview
  /** Awaiting because the review its policy requires is still missing (not because of a checkpoint). */
  reviewPending?: boolean
  /** When a worker last reported it done, if no running has reopened it since: the work a review reviews. */
  reportedAt?: number
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
  /** Archived by the person: hidden everywhere but the Backlog tab and history, restorable. */
  archived: boolean
  triagedBy?: string
  /** The default review policy for the track's steps. */
  review?: RoadmapReviewPolicy
}

export type RoadmapReview = { actor: string; session: string; verdict: 'pass' | 'findings' | 'fail'; at: number; evidence?: string; note?: string; via?: string }

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
