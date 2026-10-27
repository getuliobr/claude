import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { ExplorerFilters, GitMark, TreeMessage, TreeProps, TreeRow } from '../types'
import { hasChanges, markOf, parseGitStatus } from './git'
import type { GitStatus } from './git'

const PANE = 'explorer'
const TITLE = 'NvimTree'
// nvim-tree's default width is 30; two more for the git column.
const WIDTH = 32
// A Client's props are capped at 100,000 characters serialized.
const MAX_ROWS = 900
const NEVER_SHOWN = new Set(['.git'])
// Repositories read per refresh: the root's, then those whose folders show.
const MAX_REPOS = 8
// Tools that can change what is on disk: the tree re-reads after each.
const MUTATING_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'PowerShell',
])
const ROOT_COLOR = '#bb9af7'

const expanded = atom({ plugin: 'nvim-explorer', key: 'expanded' } as const, [], {
  shape: 'expanded-1',
})
const filters = atom(
  { plugin: 'nvim-explorer', key: 'filters' } as const,
  { showHidden: true, showIgnored: true },
  { shape: 'filters-1' },
)
const rev = atom({ plugin: 'nvim-explorer', key: 'rev' } as const, 0)
const isDismissed = atom(
  { plugin: 'nvim-explorer', key: 'isDismissed' } as const,
  false,
)

// One `git status` per repository and revision, shared by every draw that
// asks for it. Keyed by the repository's folder in the tree, '' for the root's.
let gitAt:
  | { revision: number; root: string; repos: Map<string, Promise<GitStatus | undefined>> }
  | undefined

/** A repository and the folder in the tree it starts at. */
type Repo = { dir: string; status: GitStatus | undefined }

export const register: Register = (on, options) => {
  const icons = options.icons === 'nerd' ? 'nerd' : 'unicode'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tree',
      description: 'Toggle the Neovim-style file explorer pane',
    })
    if (!(await read($, isDismissed))) {
      void $.ui.open({ id: PANE, title: TITLE, columns: WIDTH })
    }
    // Catches what changes on disk outside Claude's own tools.
    $.clock.every(5000, () => void refreshIfShown($).catch(() => {}))

    return next(e)
  })

  on('command.run', { command: 'tree' }, async $ => {
    const isShown = (await $.ui.panes()).some(
      pane => pane.id === PANE && pane.isShown,
    )
    if (isShown) {
      await $.ui.close({ id: PANE })

      return { text: 'File explorer closed.' }
    }
    await update($, isDismissed, () => false)
    await $.ui.open({ id: PANE, title: TITLE, columns: WIDTH, focus: true })

    return { text: 'File explorer opened. Click the tree for hjkl keys, ? for help.' }
  })

  // Neither hook judges anything: a failure lets the close or the call go on.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'unload') await update($, isDismissed, () => true)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (MUTATING_TOOLS.has(e.tool)) await bump($).catch(() => {})

    return result
  }).catch(($, e, next) => next(e))

  on('ui.message', { requestId: PANE }, async ($, e, next) => {
    const message = parseMessage(e.data)
    if (message !== undefined) await act($, message, e.surface)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // The tree stays where the session started: a shell `cd` does not move it.
    const [open, shown, revision, top] = await Promise.all([
      read($, expanded),
      read($, filters),
      read($, rev),
      $.session.root(),
    ])
    const { rows, isTruncated } = await walk(
      $,
      top,
      new Set(open),
      shown,
      gitStatusAt($, top, revision),
    )
    const root = rootLabel(top)
    const width = e.props.bodyColumns
    const height = e.props.scroll.bodyRows

    if (e.surface === 'terminal' || e.surface === 'desktop') {
      const { Client } = $.ui.resolve(e)
      const props: TreeProps = {
        root,
        rows,
        isTruncated,
        icons,
        filters: shown,
        width,
        height,
      }

      return (
        <Client
          key="tree"
          module="./tree.tsx"
          props={props}
          width={width}
          height={height}
        />
      )
    }

    // No Client on this surface: a plain list of rows to press.
    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Text color={ROOT_COLOR} bold>
          {root}
        </Text>
        {rows.map(row => (
          <Button
            key={row.path}
            plain
            onPress={() =>
              act($, { op: row.isDir ? 'toggle' : 'mention', path: row.path }, e.surface)
            }
          >
            {'  '.repeat(row.depth)}
            {row.isDir ? (row.isOpen ? '▾ ' : '▸ ') : '  '}
            {nameOf(row.path)}
          </Button>
        ))}
      </Box>
    )
  })
}

async function act(
  $: EngineInterface,
  message: TreeMessage,
  surface: RenderSurface,
): Promise<void> {
  switch (message.op) {
    case 'toggle':
      await update($, expanded, list =>
        list.includes(message.path)
          ? list.filter(path => path !== message.path)
          : [...list, message.path],
      )
      break
    case 'open':
      await update($, expanded, list =>
        list.includes(message.path) ? list : [...list, message.path],
      )
      break
    case 'close':
      await update($, expanded, list => list.filter(path => path !== message.path))
      break
    case 'collapseAll':
      await update($, expanded, () => [])
      break
    case 'toggleHidden':
      await update($, filters, now => ({ ...now, showHidden: !now.showHidden }))
      break
    case 'toggleIgnored':
      await update($, filters, now => ({ ...now, showIgnored: !now.showIgnored }))
      break
    case 'refresh':
      await bump($)
      break
    case 'mention': {
      // After a `cd` a path from the root no longer resolves: spell it whole.
      const [root, cwd] = await Promise.all([$.session.root(), $.session.cwd()])
      const path = root === cwd ? message.path : absoluteOf(root, message.path)
      await $.prompt.fill({ text: mentionOf(path), mode: 'insert' })
      break
    }
    case 'copy': {
      const text = await copyText($, message.path, message.as)
      const copied = await $.ui.copy({ text, surface })
      $.ui.toast(copied.isCopied ? `Copied ${text}` : `Could not copy: ${copied.reason}`)
      break
    }
    case 'quit':
      await $.ui.close({ id: PANE })
      break
  }
}

async function bump($: EngineInterface): Promise<void> {
  await update($, rev, n => n + 1)
}

async function refreshIfShown($: EngineInterface): Promise<void> {
  const panes = await $.ui.panes()
  if (panes.some(pane => pane.id === PANE && pane.isShown && pane.isPlaced)) {
    await bump($)
  }
}

async function walk(
  $: EngineInterface,
  root: string,
  open: ReadonlySet<string>,
  shown: ExplorerFilters,
  statusOf: (dir: string) => Promise<GitStatus | undefined>,
): Promise<{ rows: TreeRow[]; isTruncated: boolean }> {
  const rows: TreeRow[] = []
  let isTruncated = false

  const visit = async (dir: string, depth: number, repo: Repo): Promise<void> => {
    const entries = await $.fs.list(absoluteOf(root, dir)).catch(() => [])
    const kept = entries
      .map(entry => {
        const path = dir === '' ? entry.name : `${dir}/${entry.name}`
        const isDir = entry.kind === 'dir'

        return { name: entry.name, path, isDir, git: markOf(repo.status, within(repo, path), isDir) }
      })
      .filter(
        child =>
          !NEVER_SHOWN.has(child.name) &&
          (shown.showHidden || !child.name.startsWith('.')) &&
          (shown.showIgnored || child.git !== 'ignored'),
      )
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || compareNames(a.name, b.name))
    // A folder with a repository of its own is read by that repository. The
    // repositories take their reads in the order the rows are drawn, so past
    // MAX_REPOS it is the ones further down that go unread.
    const isRepo = await Promise.all(
      kept.map(child =>
        child.isDir
          ? $.fs.exists(absoluteOf(root, `${child.path}/.git`)).catch(() => false)
          : false,
      ),
    )
    const children = await Promise.all(
      kept.map(async (child, index) => {
        if (!isRepo[index]) return { ...child, repo }
        const own = { dir: child.path, status: await statusOf(child.path) }

        return { ...child, repo: own, git: topMark(own.status, child.git) }
      }),
    )

    for (const [index, child] of children.entries()) {
      if (rows.length >= MAX_ROWS) {
        isTruncated = true

        return
      }
      const isOpen = child.isDir && open.has(child.path)
      rows.push({
        path: child.path,
        depth,
        isDir: child.isDir,
        isOpen,
        isLast: index === children.length - 1,
        git: child.git,
      })
      if (isOpen) await visit(child.path, depth + 1, child.repo)
    }
  }

  await visit('', 0, { dir: '', status: await statusOf('') })

  return { rows, isTruncated }
}

/** A path in the tree as its repository names it. */
function within(repo: Repo, path: string): string {
  return repo.dir === '' ? path : path.slice(repo.dir.length + 1)
}

// A repository's own folder: `contains` when anything inside it changed, or
// what the repository around it says when it went unread.
function topMark(status: GitStatus | undefined, outer: GitMark): GitMark {
  if (status === undefined || outer === 'ignored') return outer

  return hasChanges(status) ? 'contains' : ''
}

// Case-insensitive, with case breaking ties so the order never depends on
// what the disk listed first.
function compareNames(a: string, b: string): number {
  return compareStrings(a.toLowerCase(), b.toLowerCase()) || compareStrings(a, b)
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// Past MAX_REPOS a repository goes unread and its rows are drawn clean, so a
// folder of many projects never starts a `git status` for each.
function gitStatusAt(
  $: EngineInterface,
  root: string,
  revision: number,
): (dir: string) => Promise<GitStatus | undefined> {
  if (gitAt?.revision !== revision || gitAt.root !== root) {
    gitAt = { revision, root, repos: new Map() }
  }
  const { repos } = gitAt

  return dir => {
    const known = repos.get(dir)
    if (known !== undefined) return known
    if (repos.size >= MAX_REPOS) return Promise.resolve(undefined)
    const status = readGitStatus($, absoluteOf(root, dir)).catch(() => undefined)
    repos.set(dir, status)

    return status
  }
}

// Outside a repository, or without git, every row is drawn clean.
async function readGitStatus(
  $: EngineInterface,
  cwd: string,
): Promise<GitStatus | undefined> {
  const prefix = await $.process.run(['git', 'rev-parse', '--show-prefix'], { cwd })
  if (prefix.exitCode !== 0) return undefined
  const status = await $.process.run(
    ['git', 'status', '--porcelain=v1', '-z', '--ignored'],
    { cwd },
  )
  if (status.exitCode !== 0) return undefined

  return parseGitStatus(status.stdout, prefix.stdout.trim())
}

function parseMessage(data: unknown): TreeMessage | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const { op, path, as } = data as Record<string, unknown>
  switch (op) {
    case 'refresh':
    case 'collapseAll':
    case 'toggleHidden':
    case 'toggleIgnored':
    case 'quit':
      return { op }
    case 'toggle':
    case 'open':
    case 'close':
    case 'mention':
      return isTreePath(path) ? { op, path } : undefined
    case 'copy':
      return isTreePath(path) &&
        (as === 'name' || as === 'relative' || as === 'absolute')
        ? { op, path, as }
        : undefined
    default:
      return undefined
  }
}

// What the Client posts is input: only a relative path that stays inside.
function isTreePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path !== '' &&
    !/^([\\/]|[A-Za-z]:)/.test(path) &&
    !path.split(/[\\/]/).includes('..')
  )
}

async function copyText(
  $: EngineInterface,
  path: string,
  as: 'name' | 'relative' | 'absolute',
): Promise<string> {
  if (as === 'name') return nameOf(path)
  if (as === 'relative') return path

  return absoluteOf(await $.session.root(), path)
}

/** A `/`-separated path in the tree, whole, in the root's own separators. */
function absoluteOf(root: string, path: string): string {
  if (path === '') return root
  const separator = root.includes('\\') ? '\\' : '/'

  return `${root.replace(/[\\/]$/, '')}${separator}${path.split('/').join(separator)}`
}

function mentionOf(path: string): string {
  return /\s/.test(path) ? `@"${path}" ` : `@${path} `
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function rootLabel(cwd: string): string {
  const trimmed = cwd.replace(/\\/g, '/').replace(/\/+$/, '')

  return nameOf(trimmed) || '/'
}
