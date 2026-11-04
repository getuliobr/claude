export type PrState = 'open' | 'closed' | 'merged' | 'all'

/**
 * Whose pull requests each project lists: everyone's, the ones you opened,
 * or the ones waiting on your review.
 */
export type PrWho = 'all' | 'mine' | 'review'

/**
 * Which pull requests each project lists: by state, by whose they are, and a
 * query in GitHub's search syntax (`label:bug draft:false`), `''` for none.
 */
export type PrFilter = { state: PrState; who: PrWho; query: string }

/** A pull request as GitHub names it: `owner/repo` and its number. */
export type PrRef = { repo: string; number: number }

/** Where a pull request stands, as GitHub's icon for it shows. */
export type PrStatus = 'open' | 'draft' | 'merged' | 'closed'

/**
 * Its checks summed up: `fail` when any failed, else `pending` when any
 * still runs, else `pass`; `''` when it has none.
 */
export type Checks = 'pass' | 'fail' | 'pending' | ''

/** One visible row of the list, in the order it is drawn. */
export type ListRow =
  | {
      kind: 'project'
      /** The project's folder under the session's root; `''` for the root. */
      dir: string
      name: string
      /** `owner/repo`, or `''` for a project with no GitHub remote. */
      repo: string
      isOpen: boolean
      count: number
      /** The listing stopped at its limit: there may be more. */
      isLimited: boolean
      isFailed: boolean
    }
  | {
      kind: 'pr'
      dir: string
      repo: string
      number: number
      title: string
      status: PrStatus
      checks: Checks
      /** Since the last update, short: `5m`, `2d`, `3w`. */
      age: string
      isLast: boolean
    }
  | {
      kind: 'note'
      dir: string
      text: string
      isError: boolean
      isLast: boolean
    }

/** What the hooks module hands the list's `Client` on every draw. */
export type PrsProps = {
  /** The session's root folder, by name. */
  root: string
  filter: PrFilter
  /** The pull request the sheet above the prompt shows, marked in the list. */
  open: PrRef | null
  rows: ListRow[]
  /** Fallbacks for the region's size before the surface has laid it out. */
  width: number
  height: number
}

/** What the sheet shows of the open pull request. */
export type SheetTab = 'conversation' | 'files'

export type PrAction = 'open' | 'diff' | 'review' | 'fix' | 'fill' | 'agent' | 'browse' | 'mention'

/** What the `Client` and the sheet's buttons post back. */
export type PrsMessage =
  | { op: 'toggle' | 'expand' | 'collapse'; dir: string }
  | { op: PrAction; repo: string; number: number }
  | { op: 'copy'; repo: string; number: number; as: 'number' | 'url' }
  | { op: 'query'; text: string }
  | { op: 'back' | 'refresh' | 'cycleState' | 'cycleWho' | 'collapseAll' | 'quit' }

declare module 'claude-code' {
  interface PluginState {
    'gh-prs': {
      /** Project folders the person closed; every project starts open. */
      collapsed: Shaped<string[]>
      filter: Shaped<PrFilter>
      /** The pull request the sheet shows, or null for none. */
      opened: Shaped<PrRef | null>
      /** Its conversation or its changed files. */
      tab: Shaped<SheetTab>
      /** Bumped to read GitHub again. */
      rev: number
      /** True once the person closed the pane, so a reload keeps it shut. */
      isDismissed: boolean
    }
  }
}
