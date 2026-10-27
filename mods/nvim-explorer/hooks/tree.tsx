import type {
  ClientKeyEvent,
  ClientModule,
  ClientPointerEvent,
  ClientSurface,
  RenderElement,
} from 'claude-code'

import type { GitMark, TreeMessage, TreeProps, TreeRow } from '../types'

// tokyonight (night), the palette the tree, its cursorline and bar draw in.
const COLOR = {
  fg: '#c0caf5',
  muted: '#565f89',
  guide: '#3b4261',
  folder: '#7aa2f7',
  root: '#bb9af7',
  cursorLine: '#292e42',
  endOfBuffer: '#3b4261',
  modeFg: '#1a1b26',
  modeBg: '#7aa2f7',
  helpBg: '#bb9af7',
  barBg: '#1f2335',
  barMid: '#3b4261',
  barFg: '#a9b1d6',
} as const

const GIT: Record<Exclude<GitMark, ''>, { sign: string; color: string }> = {
  dirty: { sign: '✗', color: '#e0af68' },
  staged: { sign: '✓', color: '#9ece6a' },
  untracked: { sign: '★', color: '#73daca' },
  renamed: { sign: '➜', color: '#bb9af7' },
  conflict: { sign: '!', color: '#f7768e' },
  ignored: { sign: '◌', color: '#545c7e' },
  contains: { sign: '●', color: '#e0af68' },
}

// The header row above the tree and the status bar below it.
const CHROME_ROWS = 2
const SCROLLOFF = 2

type View = {
  /** The path under the cursor: kept by path so a redraw keeps the row. */
  cursor: string
  /** Where it last stood, for when that path is gone. */
  index: number
  /** The first tree row in the window. */
  top: number
  /** The first key of a two-key chord (`g`), shown in the bar as vim does. */
  pending: string
  isHelp: boolean
}

const INITIAL: View = { cursor: '', index: 0, top: 0, pending: '', isHelp: false }

const HELP: readonly (readonly [string, string])[] = [
  ['j k', 'down / up'],
  ['gg G', 'top / bottom'],
  ['^d ^u', 'half page down / up'],
  ['l', 'open folder'],
  ['h', 'close folder / parent'],
  ['<CR> o', 'toggle folder'],
  ['<BS>', 'close parent'],
  ['P', 'parent folder'],
  ['K J', 'first / last sibling'],
  ['<CR> @', 'file: @mention it'],
  ['y Y gy', 'copy name / rel / abs'],
  ['H', 'toggle dotfiles'],
  ['I', 'toggle git ignored'],
  ['W', 'collapse all'],
  ['R', 'refresh'],
  ['q', 'close the pane'],
  ['?', 'close this help'],
]

const Tree: ClientModule<TreeProps, View> = (props, surface) => {
  const width = surface.columns > 0 ? surface.columns : props.width
  const height = surface.rows > 0 ? surface.rows : props.height
  const bodyRows = Math.max(1, height - CHROME_ROWS)
  const view = surface.state ?? INITIAL
  const { index, top } = settle(view, props.rows, bodyRows)

  surface.onKey(key => onKey(key, props, surface, bodyRows))
  surface.onPointer(event => onPointer(event, props, surface, bodyRows))

  const { Box, Text } = surface.elements
  const guides = guidesOf(props.rows)
  const body: RenderElement[] = []
  if (view.isHelp) {
    body.push(...helpLines(surface, width))
  } else {
    for (let i = top; i < Math.min(props.rows.length, top + bodyRows); i++) {
      const row = props.rows[i]
      if (row === undefined) break
      body.push(
        rowLine(surface, props.icons, row, guides[i] ?? '', i === index, isEmpty(props.rows, i), width),
      )
    }
  }
  while (body.length < bodyRows) {
    body.push(<Text color={COLOR.endOfBuffer}>~</Text>)
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text color={COLOR.root} bold wrap="truncate-start">
        {props.root}
      </Text>
      {body.slice(0, bodyRows)}
      {statusLine(surface, props, view, index, top, bodyRows, width)}
    </Box>
  )
}

export default Tree

function rowLine(
  surface: ClientSurface<View>,
  icons: TreeProps['icons'],
  row: TreeRow,
  guide: string,
  isCursor: boolean,
  isEmptyDir: boolean,
  width: number,
): RenderElement {
  const { Text } = surface.elements
  const bg = isCursor ? COLOR.cursorLine : undefined
  const icon = iconOf(row, icons, isEmptyDir)
  const git = row.git === '' ? undefined : GIT[row.git]
  const sign = git === undefined ? '' : ` ${git.sign}`
  const room = width - cells(guide) - cells(icon.arrow) - cells(icon.glyph) - cells(sign)
  const name = clip(nameOf(row.path), Math.max(1, room))
  const pad = ' '.repeat(Math.max(0, room - cells(name)))
  // A folder's `contains` dot is colored; its name stays a folder's.
  const plainColor = row.isDir ? COLOR.folder : COLOR.fg
  const nameColor = git === undefined || row.git === 'contains' ? plainColor : git.color

  return (
    <Text wrap="truncate-end" backgroundColor={bg}>
      <Text color={COLOR.guide} backgroundColor={bg}>
        {guide}
      </Text>
      <Text color={COLOR.muted} backgroundColor={bg}>
        {icon.arrow}
      </Text>
      <Text color={icon.color} backgroundColor={bg}>
        {icon.glyph}
      </Text>
      <Text color={nameColor} backgroundColor={bg} bold={row.isOpen}>
        {name}
      </Text>
      <Text backgroundColor={bg}>{pad}</Text>
      <Text color={git?.color} backgroundColor={bg}>
        {sign}
      </Text>
    </Text>
  )
}

function statusLine(
  surface: ClientSurface<View>,
  props: TreeProps,
  view: View,
  index: number,
  top: number,
  bodyRows: number,
  width: number,
): RenderElement {
  const { Text } = surface.elements
  const mode = view.isHelp ? ' HELP ' : ' NORMAL '
  const name = ' NvimTree '
  const flags =
    (props.filters.showHidden ? '' : ' H') +
    (props.filters.showIgnored ? '' : ' I') +
    (props.isTruncated ? ' +' : '')
  const total = props.rows.length
  const where =
    total <= bodyRows
      ? 'All'
      : top === 0
        ? 'Top'
        : top + bodyRows >= total
          ? 'Bot'
          : `${Math.round((top / (total - bodyRows)) * 100)}%`
  const right = `${view.pending}${flags} ${where} ${total === 0 ? 0 : index + 1}:${total} `
  const pad = ' '.repeat(Math.max(0, width - cells(mode) - cells(name) - cells(right)))

  return (
    <Text wrap="truncate-end">
      <Text
        color={COLOR.modeFg}
        backgroundColor={view.isHelp ? COLOR.helpBg : COLOR.modeBg}
        bold
      >
        {mode}
      </Text>
      <Text color={COLOR.folder} backgroundColor={COLOR.barMid}>
        {name}
      </Text>
      <Text color={COLOR.barFg} backgroundColor={COLOR.barBg}>
        {pad}
        {right}
      </Text>
    </Text>
  )
}

function helpLines(surface: ClientSurface<View>, width: number): RenderElement[] {
  const { Text } = surface.elements
  const keyWidth = 8

  return HELP.map(([keys, what]) => (
    <Text wrap="truncate-end">
      <Text color={COLOR.folder}>{keys.padEnd(keyWidth)}</Text>
      <Text color={COLOR.fg}>{clip(what, Math.max(1, width - keyWidth))}</Text>
    </Text>
  ))
}

function onKey(
  key: ClientKeyEvent,
  props: TreeProps,
  surface: ClientSurface<View>,
  bodyRows: number,
): void {
  const view = surface.state ?? INITIAL
  const rows = props.rows
  const { index, top } = settle(view, rows, bodyRows)
  const row = rows[index]
  const half = Math.max(1, Math.floor(bodyRows / 2))
  const go = (to: number): void => {
    const at = clamp(to, 0, rows.length - 1)
    const next: View = { ...view, pending: '', cursor: rows[at]?.path ?? '', index: at, top }
    surface.setState({ ...next, top: settle(next, rows, bodyRows).top })
  }
  const send = (message: TreeMessage): void => {
    surface.post(message)
    if (view.pending !== '') surface.setState({ ...view, pending: '' })
  }

  if (view.isHelp) {
    surface.setState({ ...view, isHelp: false, pending: '' })

    return
  }
  if (key.ctrl) {
    if (key.key === 'd') go(index + half)
    if (key.key === 'u') go(index - half)
    if (key.key === 'f') go(index + bodyRows)
    if (key.key === 'b') go(index - bodyRows)

    return
  }
  if (view.pending === 'g') {
    if (key.key === 'g') go(0)
    else if (key.key === 'y' && row !== undefined) send({ op: 'copy', path: row.path, as: 'absolute' })
    else surface.setState({ ...view, pending: '' })

    return
  }

  switch (key.key) {
    case 'j':
    case 'down':
      return go(index + 1)
    case 'k':
    case 'up':
      return go(index - 1)
    case 'G':
    case 'end':
      return go(rows.length - 1)
    case 'home':
      return go(0)
    case 'pagedown':
      return go(index + bodyRows)
    case 'pageup':
      return go(index - bodyRows)
    case 'g':
      return surface.setState({ ...view, pending: 'g' })
    case 'P':
      return go(parentOf(rows, index))
    case 'K':
      return go(siblingEdge(rows, index, -1))
    case 'J':
      return go(siblingEdge(rows, index, 1))
    case 'R':
      return send({ op: 'refresh' })
    case 'H':
      return send({ op: 'toggleHidden' })
    case 'I':
      return send({ op: 'toggleIgnored' })
    case 'W':
      return send({ op: 'collapseAll' })
    case 'q':
      return send({ op: 'quit' })
    case '?':
      return surface.setState({ ...view, isHelp: true, pending: '' })
  }
  if (row === undefined) return

  switch (key.key) {
    case 'l':
    case 'right':
      if (!row.isDir) return send({ op: 'mention', path: row.path })
      if (!row.isOpen) return send({ op: 'open', path: row.path })
      if (!isEmpty(rows, index)) go(index + 1)

      return
    case 'h':
    case 'left':
      if (row.isDir && row.isOpen) return send({ op: 'close', path: row.path })

      return go(parentOf(rows, index))
    case 'return':
    case 'o':
      return send({ op: row.isDir ? 'toggle' : 'mention', path: row.path })
    case '@':
      return send({ op: 'mention', path: row.path })
    case 'backspace': {
      const parent = parentOf(rows, index)
      const folder = rows[parent]
      if (parent === index || folder === undefined) return
      go(parent)

      return send({ op: 'close', path: folder.path })
    }
    case 'y':
      return send({ op: 'copy', path: row.path, as: 'name' })
    case 'Y':
      return send({ op: 'copy', path: row.path, as: 'relative' })
  }
}

function onPointer(
  event: ClientPointerEvent,
  props: TreeProps,
  surface: ClientSurface<View>,
  bodyRows: number,
): void {
  if (event.type !== 'down' || event.button !== 'left') return
  const view = surface.state ?? INITIAL
  if (view.isHelp) {
    surface.setState({ ...view, isHelp: false })

    return
  }
  const { index, top } = settle(view, props.rows, bodyRows)
  // Row 0 is the header.
  const at = top + event.y - 1
  const row = props.rows[at]
  if (event.y < 1 || event.y > bodyRows || row === undefined) return

  // A folder opens on its first click; a file is mentioned on a second one.
  if (row.isDir) surface.post({ op: 'toggle', path: row.path } satisfies TreeMessage)
  else if (at === index) surface.post({ op: 'mention', path: row.path } satisfies TreeMessage)
  surface.setState({ ...view, cursor: row.path, index: at, top, pending: '' })
}

/** Where the cursor and window stand for these rows, without writing state. */
function settle(
  view: View,
  rows: readonly TreeRow[],
  bodyRows: number,
): { index: number; top: number } {
  const found = rows.findIndex(row => row.path === view.cursor)
  const index = found >= 0 ? found : clamp(view.index, 0, rows.length - 1)
  const off = Math.min(SCROLLOFF, Math.floor((bodyRows - 1) / 2))
  const lastTop = Math.max(0, rows.length - bodyRows)
  let top = clamp(view.top, 0, lastTop)
  if (index < top + off) top = Math.max(0, index - off)
  if (index > top + bodyRows - 1 - off) top = Math.min(lastTop, index - bodyRows + 1 + off)

  return { index, top }
}

/**
 * nvim-tree's indent markers: a `│` down each level whose folder has more
 * below, and `└` on a folder's last child.
 */
function guidesOf(rows: readonly TreeRow[]): string[] {
  const isLastAt: boolean[] = []

  return rows.map(row => {
    isLastAt[row.depth] = row.isLast
    isLastAt.length = row.depth + 1
    let guide = ''
    for (let level = 0; level < row.depth; level++) {
      if (level === row.depth - 1) guide += row.isLast ? '└ ' : '│ '
      else guide += isLastAt[level + 1] ? '  ' : '│ '
    }

    return guide
  })
}

function parentOf(rows: readonly TreeRow[], index: number): number {
  const depth = rows[index]?.depth ?? 0
  for (let i = index - 1; i >= 0; i--) {
    if ((rows[i]?.depth ?? 0) < depth) return i
  }

  return index
}

/** The first (`-1`) or last (`1`) row among the cursor row's siblings. */
function siblingEdge(rows: readonly TreeRow[], index: number, direction: -1 | 1): number {
  const depth = rows[index]?.depth ?? 0
  let edge = index
  for (let i = index + direction; i >= 0 && i < rows.length; i += direction) {
    const other = rows[i]?.depth ?? 0
    if (other < depth) break
    if (other === depth) edge = i
  }

  return edge
}

function isEmpty(rows: readonly TreeRow[], index: number): boolean {
  const row = rows[index]

  return row !== undefined && row.isDir && row.isOpen && (rows[index + 1]?.depth ?? -1) <= row.depth
}

type Icon = { arrow: string; glyph: string; color: string }

// Nerd Font glyphs as nvim-tree and nvim-web-devicons draw them, by code
// point so the source reads in an editor without a Nerd Font.
const nf = (code: number): string => String.fromCodePoint(code)

const NERD = {
  arrowClosed: `${nf(0xf460)} `,
  arrowOpen: `${nf(0xf47c)} `,
  folder: `${nf(0xe5ff)} `,
  folderOpen: `${nf(0xe5fe)} `,
  folderEmptyOpen: `${nf(0xf115)} `,
  file: nf(0xf4a5),
} as const

const BY_NAME: Record<string, readonly [string, string]> = {
  '.gitignore': [nf(0xe702), '#f54d27'],
  '.gitattributes': [nf(0xe702), '#f54d27'],
  '.gitmodules': [nf(0xe702), '#f54d27'],
  '.env': [nf(0xf462), '#faf743'],
  // Codicons' Claude mark and Material Design's robot, for agent instructions.
  'CLAUDE.md': [nf(0xec82), '#d97757'],
  'AGENTS.md': [nf(0xf06a9), '#cbcb41'],
  'package.json': [nf(0xe71e), '#e8274b'],
  'package-lock.json': [nf(0xe71e), '#7a0d21'],
  Dockerfile: [nf(0xf308), '#458ee6'],
  LICENSE: [nf(0xe60a), '#d0bf41'],
  Makefile: [nf(0xe779), '#6d8086'],
}

const BY_EXTENSION: Record<string, readonly [string, string]> = {
  md: [nf(0xe609), '#dddddd'],
  mdx: [nf(0xe609), '#519aba'],
  js: [nf(0xe60c), '#cbcb41'],
  mjs: [nf(0xe60c), '#f1e05a'],
  cjs: [nf(0xe60c), '#cbcb41'],
  jsx: [nf(0xe7ba), '#20c2e3'],
  ts: [nf(0xe628), '#519aba'],
  mts: [nf(0xe628), '#519aba'],
  tsx: [nf(0xe7ba), '#1354bf'],
  json: [nf(0xe60b), '#cbcb41'],
  py: [nf(0xe606), '#ffbc03'],
  sh: [nf(0xe795), '#89e051'],
  bash: [nf(0xe795), '#89e051'],
  zsh: [nf(0xe795), '#89e051'],
  ps1: [nf(0xe795), '#4273ca'],
  html: [nf(0xe736), '#e44d26'],
  css: [nf(0xe749), '#42a5f5'],
  scss: [nf(0xe603), '#f55385'],
  yml: [nf(0xe6a8), '#6d8086'],
  yaml: [nf(0xe6a8), '#6d8086'],
  toml: [nf(0xe6b2), '#9c4221'],
  lua: [nf(0xe620), '#51a0cf'],
  rs: [nf(0xe7a8), '#dea584'],
  go: [nf(0xe627), '#519aba'],
  java: [nf(0xe738), '#cc3e44'],
  rb: [nf(0xe791), '#701516'],
  php: [nf(0xe608), '#a074c4'],
  c: [nf(0xe61e), '#599eff'],
  h: [nf(0xf0fd), '#a074c4'],
  cpp: [nf(0xe61d), '#519aba'],
  cs: [nf(0xe648), '#596706'],
  sql: [nf(0xe706), '#dad8d8'],
  png: [nf(0xe60d), '#a074c4'],
  jpg: [nf(0xe60d), '#a074c4'],
  jpeg: [nf(0xe60d), '#a074c4'],
  gif: [nf(0xe60d), '#a074c4'],
  webp: [nf(0xe60d), '#a074c4'],
  ico: [nf(0xe60d), '#cbcb41'],
  svg: [nf(0xe60d), '#ffb13b'],
  pdf: [nf(0xf1c1), '#b30b00'],
  txt: [nf(0xf15c), '#89e051'],
  lock: [nf(0xf023), '#bbbbbb'],
  env: [nf(0xf462), '#faf743'],
  xml: [nf(0xe619), '#e37933'],
  vue: [nf(0xe6a0), '#8dc149'],
  svelte: [nf(0xe697), '#ff3e00'],
}

function iconOf(row: TreeRow, icons: TreeProps['icons'], isEmptyDir: boolean): Icon {
  if (icons === 'unicode') {
    return {
      arrow: row.isDir ? (row.isOpen ? '▾ ' : '▸ ') : '  ',
      glyph: '',
      color: COLOR.folder,
    }
  }
  if (row.isDir) {
    const glyph = isEmptyDir
      ? NERD.folderEmptyOpen
      : row.isOpen
        ? NERD.folderOpen
        : NERD.folder

    return {
      arrow: row.isOpen ? NERD.arrowOpen : NERD.arrowClosed,
      glyph,
      color: COLOR.folder,
    }
  }
  const name = nameOf(row.path)
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  const [glyph, color] = BY_NAME[name] ?? BY_EXTENSION[extension] ?? [NERD.file, COLOR.fg]

  return { arrow: '  ', glyph: `${glyph} `, color }
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Terminal cells a string takes: one per code point, as these glyphs draw. */
function cells(text: string): number {
  return [...text].length
}

function clip(text: string, room: number): string {
  const points = [...text]

  return points.length <= room ? text : `${points.slice(0, Math.max(0, room - 1)).join('')}…`
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(Math.max(low, high), value))
}
