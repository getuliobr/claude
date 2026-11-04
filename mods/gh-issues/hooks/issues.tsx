import type {
  ClientKeyEvent,
  ClientModule,
  ClientPointerEvent,
  ClientSurface,
  RenderElement,
} from 'claude-code'

import type { IssueRef, IssuesMessage, IssuesProps, ListRow } from '../types'

// tokyonight (night), the palette FileTree draws in.
const COLOR = {
  fg: '#c0caf5',
  muted: '#565f89',
  comment: '#737aa2',
  guide: '#3b4261',
  folder: '#7aa2f7',
  root: '#bb9af7',
  number: '#ff9e64',
  open: '#9ece6a',
  closed: '#9d7cd8',
  error: '#f7768e',
  cursorLine: '#292e42',
  endOfBuffer: '#3b4261',
  modeFg: '#1a1b26',
  modeBg: '#7aa2f7',
  helpBg: '#bb9af7',
  barBg: '#1f2335',
  barMid: '#3b4261',
  barFg: '#a9b1d6',
} as const

// The header row above the list and the status bar below it.
const CHROME_ROWS = 2
const SCROLLOFF = 2
// Beside the issue shown in the sheet above the prompt.
const SHOWN = ' ◆'

type View = {
  /** The row under the cursor, by key: a redraw keeps the row. */
  cursor: string
  /** Where it last stood, for when that row is gone. */
  index: number
  /** The first row in the window. */
  top: number
  /** The first key of a two-key chord (`g`), shown in the bar as vim does. */
  pending: string
  isHelp: boolean
  /** The search being typed on the bottom line after `/`; null while none is. */
  search: string | null
}

const INITIAL: View = { cursor: '', index: 0, top: 0, pending: '', isHelp: false, search: null }

const HELP: readonly (readonly [string, string])[] = [
  ['j k', 'down / up'],
  ['gg G', 'top / bottom'],
  ['^f ^u', 'page down / half up'],
  ['l', 'open project / show issue'],
  ['<CR> o', 'toggle project / issue'],
  ['x', 'close the issue'],
  ['h', 'close project / parent'],
  ['K J', 'first / last sibling'],
  ['c', 'send to Claude'],
  ['i', 'fill the prompt'],
  ['a', 'subagent works on it'],
  ['gx', 'open in the browser'],
  ['@', 'owner/repo#n in prompt'],
  ['y Y', 'copy #n / url'],
  ['/', 'search: assignee:@me …'],
  ['s', 'open / closed / all'],
  ['m', 'only assigned to me'],
  ['W', 'collapse all'],
  ['R', 'read GitHub again'],
  ['q', 'close issue / pane'],
  ['?', 'close this help'],
]

const Issues: ClientModule<IssuesProps, View> = (props, surface) => {
  const width = surface.columns > 0 ? surface.columns : props.width
  const height = surface.rows > 0 ? surface.rows : props.height
  const bodyRows = Math.max(1, height - CHROME_ROWS)
  const view = surface.state ?? INITIAL
  const { index, top } = settle(view, props.rows, bodyRows)

  surface.onKey(key => onKey(key, props, surface, bodyRows))
  surface.onPointer(event => onPointer(event, props, surface, bodyRows))

  const { Box, Text } = surface.elements
  const guides = guidesOf(props.rows)
  const shown = refKey(props.open)
  const body: RenderElement[] = []
  if (view.isHelp) {
    body.push(...helpLines(surface, width))
  } else {
    for (let i = top; i < Math.min(props.rows.length, top + bodyRows); i++) {
      const row = props.rows[i]
      if (row === undefined) break
      body.push(rowLine(surface, row, guides[i] ?? '', i === index, keyOf(row) === shown, width))
    }
  }
  while (body.length < bodyRows) {
    body.push(<Text color={COLOR.endOfBuffer}>~</Text>)
  }

  const query = props.filter.query

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text wrap="truncate-end">
        <Text color={COLOR.root} bold>
          {clip(props.root, width)}
        </Text>
        <Text color={COLOR.number}>{query === '' ? '' : `  /${query}`}</Text>
      </Text>
      {body.slice(0, bodyRows)}
      {view.search === null
        ? statusLine(surface, props, view, index, top, bodyRows, width)
        : searchLine(surface, view.search, width)}
    </Box>
  )
}

/** The search being typed, where vim types one: `/assignee:@me█`. */
function searchLine(surface: ClientSurface<View>, search: string, width: number): RenderElement {
  const { Text } = surface.elements
  const line = `/${search}`
  // The end of a long search stays in sight, where the typing is.
  const shown = cells(line) + 1 > width ? `…${tail(line, width - 2)}` : line

  return (
    <Text wrap="truncate-end">
      <Text color={COLOR.fg} backgroundColor={COLOR.barBg}>
        {shown}
      </Text>
      <Text color={COLOR.barBg} backgroundColor={COLOR.fg}>
        {' '}
      </Text>
      <Text backgroundColor={COLOR.barBg}>{' '.repeat(Math.max(0, width - cells(shown) - 1))}</Text>
    </Text>
  )
}

/** The last letters of `text` that fit `room` cells. */
function tail(text: string, room: number): string {
  const points = [...text]
  let used = 0
  let at = points.length
  while (at > 0) {
    const size = widthOf(points[at - 1] ?? '')
    if (used + size > room) break
    used += size
    at--
  }

  return points.slice(at).join('')
}

export default Issues

function rowLine(
  surface: ClientSurface<View>,
  row: ListRow,
  guide: string,
  isCursor: boolean,
  isShown: boolean,
  width: number,
): RenderElement {
  const { Text } = surface.elements
  const bg = isCursor ? COLOR.cursorLine : undefined

  if (row.kind === 'project') {
    const isRepo = row.repo !== ''
    const arrow = isRepo ? (row.isOpen ? '▾ ' : '▸ ') : '  '
    const right = isRepo ? ` ${row.isFailed ? '!' : row.isLimited ? `${row.count}+` : row.count}` : ''
    const room = Math.max(1, width - cells(arrow) - cells(right))
    const name = clip(row.name, room)
    const aside = clip(isRepo ? `  ${row.repo}` : '  no GitHub remote', Math.max(0, room - cells(name)))
    const pad = ' '.repeat(Math.max(0, room - cells(name) - cells(aside)))

    return (
      <Text wrap="truncate-end" backgroundColor={bg}>
        <Text color={COLOR.muted} backgroundColor={bg}>
          {arrow}
        </Text>
        <Text color={isRepo ? COLOR.folder : COLOR.muted} backgroundColor={bg} bold={row.isOpen}>
          {name}
        </Text>
        <Text color={COLOR.muted} backgroundColor={bg}>
          {aside}
          {pad}
        </Text>
        <Text color={row.isFailed ? COLOR.error : COLOR.muted} backgroundColor={bg}>
          {right}
        </Text>
      </Text>
    )
  }

  if (row.kind === 'note') {
    return (
      <Text wrap="truncate-end" backgroundColor={bg}>
        <Text color={COLOR.guide} backgroundColor={bg}>
          {guide}
        </Text>
        <Text color={row.isError ? COLOR.error : COLOR.muted} backgroundColor={bg}>
          {clip(row.text, Math.max(1, width - cells(guide)))}
        </Text>
      </Text>
    )
  }

  const number = `#${row.number} `
  const age = row.age === '' ? '' : ` ${row.age}`
  const mark = isShown ? SHOWN : ''
  const room = Math.max(1, width - cells(guide) - cells(number) - cells(age) - cells(mark))
  const title = clip(row.title, room)
  const pad = ' '.repeat(Math.max(0, room - cells(title)))

  return (
    <Text wrap="truncate-end" backgroundColor={bg}>
      <Text color={COLOR.guide} backgroundColor={bg}>
        {guide}
      </Text>
      <Text color={row.isClosed ? COLOR.closed : COLOR.number} backgroundColor={bg}>
        {number}
      </Text>
      <Text color={row.isClosed ? COLOR.comment : COLOR.fg} backgroundColor={bg} bold={isShown}>
        {title}
        {pad}
      </Text>
      <Text color={COLOR.muted} backgroundColor={bg}>
        {age}
      </Text>
      <Text color={COLOR.open} backgroundColor={bg}>
        {mark}
      </Text>
    </Text>
  )
}

function statusLine(
  surface: ClientSurface<View>,
  props: IssuesProps,
  view: View,
  index: number,
  top: number,
  bodyRows: number,
  width: number,
): RenderElement {
  const { Text } = surface.elements
  const mode = view.isHelp ? ' HELP ' : ' NORMAL '
  const name = ' Issues '
  const total = props.rows.length
  const filter = `${props.filter.state}${props.filter.mine ? ' @me' : ''}`
  const right = `${view.pending} ${filter} ${whereOf(top, total, bodyRows)} ${total === 0 ? 0 : index + 1}:${total} `
  const pad = ' '.repeat(Math.max(0, width - cells(mode) - cells(name) - cells(right)))

  return (
    <Text wrap="truncate-end">
      <Text color={COLOR.modeFg} backgroundColor={view.isHelp ? COLOR.helpBg : COLOR.modeBg} bold>
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

function whereOf(top: number, total: number, bodyRows: number): string {
  if (total <= bodyRows) return 'All'
  if (top === 0) return 'Top'
  if (top + bodyRows >= total) return 'Bot'

  return `${Math.round((top / (total - bodyRows)) * 100)}%`
}

function onKey(
  key: ClientKeyEvent,
  props: IssuesProps,
  surface: ClientSurface<View>,
  bodyRows: number,
): void {
  const view = surface.state ?? INITIAL
  if (view.search !== null) return onSearchKey(key, view, surface)
  if (view.isHelp) {
    surface.setState({ ...view, isHelp: false, pending: '' })

    return
  }
  // vim's search key: the bottom line takes the search, the one in force to edit.
  if (key.key === '/' && !key.ctrl && view.pending === '') {
    surface.setState({ ...view, search: props.filter.query })

    return
  }
  const rows = props.rows
  const { index, top } = settle(view, rows, bodyRows)
  const row = rows[index]
  const half = Math.max(1, Math.floor(bodyRows / 2))
  const go = (to: number): void => {
    const at = clamp(to, 0, rows.length - 1)
    const target = rows[at]
    const next: View = { ...view, pending: '', cursor: target === undefined ? '' : keyOf(target), index: at, top }
    surface.setState({ ...next, top: settle(next, rows, bodyRows).top })
  }
  const send = (message: IssuesMessage, change: Partial<View> = {}): void => {
    surface.post(message)
    surface.setState({ ...view, pending: '', ...change })
  }
  const close = (): void => send({ op: 'back' })
  const issue = row?.kind === 'issue' ? { repo: row.repo, number: row.number } : undefined
  const hasIssue = props.open !== null

  if (key.ctrl) {
    if (key.key === 'd') go(index + half)
    if (key.key === 'u') go(index - half)
    if (key.key === 'f') go(index + bodyRows)
    if (key.key === 'b') go(index - bodyRows)

    return
  }
  if (view.pending === 'g') {
    if (key.key === 'g') go(0)
    else if (key.key === 'x' && issue !== undefined) send({ op: 'browse', ...issue })
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
    case 's':
      return send({ op: 'cycleState' })
    case 'm':
      return send({ op: 'toggleMine' })
    case 'W':
      return send({ op: 'collapseAll' })
    case 'x':
      return hasIssue ? close() : undefined
    // The sheet first, then the pane.
    case 'q':
      return hasIssue ? close() : send({ op: 'quit' })
    case '?':
      return surface.setState({ ...view, isHelp: true, pending: '' })
  }
  if (row === undefined) return

  if (row.kind === 'project') {
    if (row.repo === '') return
    switch (key.key) {
      case 'l':
      case 'right':
        if (!row.isOpen) return send({ op: 'expand', dir: row.dir })

        return go(index + 1)
      case 'h':
      case 'left':
      case 'backspace':
        if (row.isOpen) return send({ op: 'collapse', dir: row.dir })

        return
      // As nvim-tree's: Enter and o open a closed project and close an open one.
      case 'return':
      case 'o':
        return send({ op: 'toggle', dir: row.dir })
    }

    return
  }

  switch (key.key) {
    case 'h':
    case 'left':
      return go(parentOf(rows, index))
    case 'backspace': {
      const parent = rows[parentOf(rows, index)]
      if (parent?.kind !== 'project') return
      go(parentOf(rows, index))

      return void surface.post({ op: 'collapse', dir: parent.dir } satisfies IssuesMessage)
    }
  }
  if (issue === undefined) return

  switch (key.key) {
    case 'l':
    case 'right':
      return send({ op: 'open', ...issue })
    // Enter on the issue the sheet shows puts it away again.
    case 'return':
    case 'o':
      if (keyOf(row) === refKey(props.open)) return close()

      return send({ op: 'open', ...issue })
    case 'c':
      return send({ op: 'send', ...issue })
    case 'i':
      return send({ op: 'fill', ...issue })
    case 'a':
      return send({ op: 'agent', ...issue })
    case '@':
      return send({ op: 'mention', ...issue })
    case 'y':
      return send({ op: 'copy', ...issue, as: 'number' })
    case 'Y':
      return send({ op: 'copy', ...issue, as: 'url' })
  }
}

/**
 * A key while the search is typed: Enter lists by it (an empty one lists
 * everything again), Backspace on an empty line puts the line away, Ctrl-u
 * clears it, and a letter, a space or a symbol is typed. Esc never reaches a
 * Client: it hands the keyboard back, and the line waits as it was left.
 */
function onSearchKey(key: ClientKeyEvent, view: View, surface: ClientSurface<View>): void {
  const search = view.search ?? ''
  if (key.key === 'return') {
    surface.post({ op: 'query', text: search } satisfies IssuesMessage)
    surface.setState({ ...view, search: null })

    return
  }
  if (key.key === 'backspace' || key.key === 'delete') {
    surface.setState({ ...view, search: search === '' ? null : [...search].slice(0, -1).join('') })

    return
  }
  if (key.ctrl) {
    if (key.key === 'u') surface.setState({ ...view, search: '' })

    return
  }
  const typed = key.key === 'space' ? ' ' : key.key
  if (key.meta || [...typed].length !== 1) return
  surface.setState({ ...view, search: search + typed })
}

function onPointer(
  event: ClientPointerEvent,
  props: IssuesProps,
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

  // A project opens on its first click; an issue shows on a second one.
  if (row.kind === 'project' && row.repo !== '') {
    surface.post({ op: 'toggle', dir: row.dir } satisfies IssuesMessage)
  } else if (row.kind === 'issue' && at === index && keyOf(row) !== refKey(props.open)) {
    surface.post({ op: 'open', repo: row.repo, number: row.number } satisfies IssuesMessage)
  }
  surface.setState({ ...view, cursor: keyOf(row), index: at, top, pending: '' })
}

/** The guide down a project's issues: `│` past each, `└` on its last. */
function guidesOf(rows: readonly ListRow[]): string[] {
  return rows.map((row, index) =>
    row.kind === 'project' || index === 0 ? '' : row.isLast ? '└ ' : '│ ',
  )
}

function keyOf(row: ListRow): string {
  if (row.kind === 'project') return `p:${row.dir}`
  if (row.kind === 'issue') return `${row.repo}#${row.number}`

  return `n:${row.dir}`
}

function refKey(ref: IssueRef | null): string {
  return ref === null ? '' : `${ref.repo}#${ref.number}`
}

function depthOf(row: ListRow | undefined): number {
  return row === undefined || row.kind === 'project' ? 0 : 1
}

/** Where the cursor and window stand for these rows, without writing state. */
function settle(
  view: View,
  rows: readonly ListRow[],
  bodyRows: number,
): { index: number; top: number } {
  const found = rows.findIndex(row => keyOf(row) === view.cursor)
  const index = found >= 0 ? found : clamp(view.index, 0, rows.length - 1)
  const off = Math.min(SCROLLOFF, Math.floor((bodyRows - 1) / 2))
  const lastTop = Math.max(0, rows.length - bodyRows)
  let top = clamp(view.top, 0, lastTop)
  if (index < top + off) top = Math.max(0, index - off)
  if (index > top + bodyRows - 1 - off) top = Math.min(lastTop, index - bodyRows + 1 + off)

  return { index, top }
}

function parentOf(rows: readonly ListRow[], index: number): number {
  const depth = depthOf(rows[index])
  for (let i = index - 1; i >= 0; i--) {
    if (depthOf(rows[i]) < depth) return i
  }

  return index
}

/** The first (`-1`) or last (`1`) row among the cursor row's siblings. */
function siblingEdge(rows: readonly ListRow[], index: number, direction: -1 | 1): number {
  const depth = depthOf(rows[index])
  let edge = index
  for (let i = index + direction; i >= 0 && i < rows.length; i += direction) {
    const other = depthOf(rows[i])
    if (other < depth) break
    if (other === depth) edge = i
  }

  return edge
}

/** Terminal cells a string takes: wide East Asian letters and emoji take two. */
function cells(text: string): number {
  let total = 0
  for (const point of text) total += widthOf(point)

  return total
}

function widthOf(point: string): number {
  const code = point.codePointAt(0) ?? 0
  // Joiners and variation selectors take no cell of their own.
  if (code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0x0300 && code <= 0x036f)) {
    return 0
  }
  const isWide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)

  return isWide ? 2 : 1
}

/** The text cut to `room` cells, an ellipsis where it was cut. */
function clip(text: string, room: number): string {
  if (room <= 0) return ''
  if (cells(text) <= room) return text
  if (room === 1) return '…'
  let used = 0
  let head = ''
  for (const point of text) {
    const size = widthOf(point)
    if (used + size > room - 1) break
    used += size
    head += point
  }

  return `${head}…`
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(Math.max(low, high), value))
}
