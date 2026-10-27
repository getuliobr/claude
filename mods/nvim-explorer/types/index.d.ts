export type ExplorerFilters = { showHidden: boolean; showIgnored: boolean }

/**
 * A row's git state: its own (`dirty` and the rest), `contains` for a folder
 * holding changes, or `''` for a clean one.
 */
export type GitMark =
  | ''
  | 'dirty'
  | 'staged'
  | 'untracked'
  | 'renamed'
  | 'conflict'
  | 'ignored'
  | 'contains'

/** One visible row of the tree, in the order it is drawn. */
export type TreeRow = {
  /** Relative to the session's root, where it started; `/`-separated. */
  path: string
  depth: number
  isDir: boolean
  isOpen: boolean
  /** The last of its parent's shown children: the guide turns the corner. */
  isLast: boolean
  git: GitMark
}

/** What the hooks module hands the tree's `Client` on every draw. */
export type TreeProps = {
  root: string
  rows: TreeRow[]
  isTruncated: boolean
  icons: 'nerd' | 'unicode'
  filters: ExplorerFilters
  /** Fallbacks for the region's size before the surface has laid it out. */
  width: number
  height: number
}

/** What the tree's `Client` posts back. */
export type TreeMessage =
  | { op: 'toggle' | 'open' | 'close' | 'mention'; path: string }
  | { op: 'copy'; path: string; as: 'name' | 'relative' | 'absolute' }
  | { op: 'refresh' | 'collapseAll' | 'toggleHidden' | 'toggleIgnored' | 'quit' }

declare module 'claude-code' {
  interface PluginState {
    'nvim-explorer': {
      expanded: Shaped<string[]>
      filters: Shaped<ExplorerFilters>
      /** Bumped to re-read the disk and git. */
      rev: number
      /** True once the person closed the pane, so a reload keeps it shut. */
      isDismissed: boolean
    }
  }
}
