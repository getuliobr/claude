export type IssueState = 'open' | 'closed' | 'all'

/**
 * Which issues each project lists: by state, only those assigned to you, and
 * a query in GitHub's search syntax (`assignee:@me label:bug`), `''` for none.
 */
export type IssueFilter = { state: IssueState; mine: boolean; query: string }

/** An issue as GitHub names it: `owner/repo` and its number. */
export type IssueRef = { repo: string; number: number }

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
      kind: 'issue'
      dir: string
      repo: string
      number: number
      title: string
      isClosed: boolean
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

export type IssueComment = { author: string; age: string; body: string }

/** An issue as the buffer draws it, cut to fit a `Client`'s props. */
export type IssueDetail = {
  repo: string
  number: number
  title: string
  isClosed: boolean
  /** `Open`, `Closed`, `Closed as not planned`. */
  stateLabel: string
  author: string
  /** Since it was opened. */
  age: string
  labels: string[]
  assignees: string[]
  milestone: string
  url: string
  body: string
  /** The body was longer than the room: it ends early. */
  isBodyCut: boolean
  comments: IssueComment[]
  /** Comments past the room, left out. */
  omitted: number
}

/** What the hooks module hands the `Client` on every draw. */
export type IssuesProps = {
  mode: 'list' | 'issue'
  /** The session's root folder, by name. */
  root: string
  filter: IssueFilter
  /**
   * The open issue. Where the sheet above the prompt shows it, the pane stays
   * the list and marks its row; elsewhere the pane shows it (`mode: 'issue'`).
   */
  open: IssueRef | null
  /** The list's rows; empty while the pane shows an issue. */
  rows: ListRow[]
  /** The issue the pane shows, and its contents unless reading it failed. */
  ref: IssueRef | null
  issue: IssueDetail | null
  /** Why `issue` is null while one is open. */
  error: string
  /** Fallbacks for the region's size before the surface has laid it out. */
  width: number
  height: number
}

export type IssueAction = 'open' | 'send' | 'fill' | 'agent' | 'browse' | 'mention'

/** What the `Client` posts back. */
export type IssuesMessage =
  | { op: 'toggle' | 'expand' | 'collapse'; dir: string }
  | { op: IssueAction; repo: string; number: number }
  | { op: 'copy'; repo: string; number: number; as: 'number' | 'url' }
  | { op: 'query'; text: string }
  | { op: 'back' | 'refresh' | 'cycleState' | 'toggleMine' | 'collapseAll' | 'quit' }

declare module 'claude-code' {
  interface PluginState {
    'gh-issues': {
      /** Project folders the person closed; every project starts open. */
      collapsed: Shaped<string[]>
      filter: Shaped<IssueFilter>
      /** The issue shown in the buffer, or null for the list. */
      opened: Shaped<IssueRef | null>
      /** Bumped to read GitHub again. */
      rev: number
      /** True once the person closed the pane, so a reload keeps it shut. */
      isDismissed: boolean
    }
  }
}
