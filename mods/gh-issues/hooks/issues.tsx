import type {
  ClientKeyEvent,
  ClientModule,
  ClientPointerEvent,
  ClientSurface,
  RenderElement,
} from 'claude-code'

import type { IssueDetail, IssueRef, IssuesMessage, IssuesProps, ListRow } from '../types'

// tokyonight (night), the palette nvim-explorer draws in.
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
  heading: '#7aa2f7',
  code: '#9ece6a',
  bullet: '#e0af68',
  cursorLine: '#292e42',
  endOfBuffer: '#3b4261',
  modeFg: '#1a1b26',
  modeBg: '#7aa2f7',
  issueBg: '#9ece6a',
  helpBg: '#bb9af7',
  barBg: '#1f2335',
  barMid: '#3b4261',
  barFg: '#a9b1d6',
} as const

// The header row above the body and the status bar below it.
const CHROME_ROWS = 2
const SCROLLOFF = 2

type View = {
  /** The row under the cursor, by key: a redraw keeps the row. */
  cursor: string
  /** Where it last stood, for when that row is gone. */
  index: number
  /** The first list row in the window. */
  top: number
  /** The first key of a two-key chord (`g`), shown in the bar as vim does. */
  pending: string
  isHelp: boolean
  /** The open issue's first line in the window, and which issue it is for. */
  scroll: number
  scrollFor: string
  /** The issue asked for, until it opens: the bar says so. */
  opening: string
}

const INITIAL: View = {
  cursor: '',
  index: 0,
  top: 0,
  pending: '',
  isHelp: false,
  scroll: 0,
  scrollFor: '',
  opening: '',
}

const HELP_SHARED: readonly (readonly [string, string])[] = [
  ['c', 'send to Claude'],
  ['i', 'fill the prompt'],
  ['a', 'subagent works on it'],
  ['gx', 'open in the browser'],
  ['@', 'owner/repo#n in prompt'],
  ['y Y', 'copy #n / url'],
  ['R', 'read GitHub again'],
]

const HELP_LIST: readonly (readonly [string, string])[] = [
  ['j k', 'down / up'],
  ['gg G', 'top / bottom'],
  ['^f ^u', 'page down / half up'],
  ['l <CR>', 'open project / issue'],
  ['h', 'close project / parent'],
  ['K J', 'first / last sibling'],
  ...HELP_SHARED,
  ['s', 'open / closed / all'],
  ['m', 'only assigned to me'],
  ['W', 'collapse all'],
  ['q', 'close the pane'],
  ['?', 'close this help'],
]

const HELP_ISSUE: readonly (readonly [string, string])[] = [
  ['j k', 'scroll a line'],
  ['^f <Sp>', 'page down'],
  ['^u', 'half page up'],
  ['gg G', 'top / bottom'],
  ['h q', 'back to the list'],
  ...HELP_SHARED,
  ['?', 'close this help'],
]

const Issues: ClientModule<IssuesProps, View> = (props, surface) => {
  const width = surface.columns > 0 ? surface.columns : props.width
  const height = surface.rows > 0 ? surface.rows : props.height
  const bodyRows = Math.max(1, height - CHROME_ROWS)
  const view = surface.state ?? INITIAL

  surface.onKey(key => onKey(key, props, surface, width, bodyRows))
  surface.onPointer(event => onPointer(event, props, surface, bodyRows))

  const { Box, Text } = surface.elements
  const body: RenderElement[] = []
  let header = props.root
  let bar: RenderElement

  if (props.mode === 'issue') {
    const lines = linesOf(props, width)
    const scroll = scrollOf(view, props, lines.length, bodyRows)
    header = props.ref === null ? props.root : `${props.ref.repo}#${props.ref.number}`
    if (view.isHelp) body.push(...helpLines(surface, HELP_ISSUE, width))
    else body.push(...lines.slice(scroll, scroll + bodyRows).map(line => lineOf(surface, line)))
    bar = statusLine(surface, width, {
      mode: view.isHelp ? 'help' : 'issue',
      name: ' Issue ',
      right: `${view.pending} ${whereOf(scroll, lines.length, bodyRows)} ${Math.min(scroll + 1, lines.length)}:${lines.length} `,
    })
  } else {
    const { index, top } = settle(view, props.rows, bodyRows)
    const guides = guidesOf(props.rows)
    if (view.isHelp) {
      body.push(...helpLines(surface, HELP_LIST, width))
    } else {
      for (let i = top; i < Math.min(props.rows.length, top + bodyRows); i++) {
        const row = props.rows[i]
        if (row === undefined) break
        body.push(rowLine(surface, row, guides[i] ?? '', i === index, width))
      }
    }
    const total = props.rows.length
    const filter = `${props.filter.state}${props.filter.mine ? ' @me' : ''}`
    const opening = view.opening !== '' && view.opening === view.cursor ? ' opening…' : ''
    bar = statusLine(surface, width, {
      mode: view.isHelp ? 'help' : 'normal',
      name: ' Issues ',
      right: `${view.pending}${opening} ${filter} ${whereOf(top, total, bodyRows)} ${total === 0 ? 0 : index + 1}:${total} `,
    })
  }
  while (body.length < bodyRows) {
    body.push(<Text color={COLOR.endOfBuffer}>~</Text>)
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text color={COLOR.root} bold wrap="truncate-start">
        {header}
      </Text>
      {body.slice(0, bodyRows)}
      {bar}
    </Box>
  )
}

export default Issues

// ---------------------------------------------------------------- the list

function rowLine(
  surface: ClientSurface<View>,
  row: ListRow,
  guide: string,
  isCursor: boolean,
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
  const right = row.age === '' ? '' : ` ${row.age}`
  const room = Math.max(1, width - cells(guide) - cells(number) - cells(right))
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
      <Text color={row.isClosed ? COLOR.comment : COLOR.fg} backgroundColor={bg}>
        {title}
        {pad}
      </Text>
      <Text color={COLOR.muted} backgroundColor={bg}>
        {right}
      </Text>
    </Text>
  )
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

// --------------------------------------------------------------- the issue

/** One row of the issue's buffer, wrapped to the width already. */
type Line = {
  lead: string
  leadColor: string
  text: string
  color: string
  bold?: boolean
  italic?: boolean
}

function linesOf(props: IssuesProps, width: number): Line[] {
  const issue = props.issue
  if (issue === null) {
    const name = props.ref === null ? 'the issue' : `${props.ref.repo}#${props.ref.number}`

    return [
      ...plain(`Could not read ${name}.`, COLOR.error, width),
      ...plain(props.error, COLOR.comment, width),
      blank(),
      ...plain('h goes back, R tries again, gx opens it in the browser.', COLOR.muted, width),
    ]
  }

  const lines: Line[] = [
    ...plain(issue.title, COLOR.fg, width, { bold: true }),
    ...meta(issue, width),
    rule(width, ''),
  ]
  if (issue.body === '') lines.push(...plain('No description.', COLOR.muted, width, { italic: true }))
  else lines.push(...markdownLines(issue.body, width))
  if (issue.isBodyCut) lines.push(blank(), ...plain('… the rest is left out: gx opens the issue', COLOR.muted, width))

  for (const comment of issue.comments) {
    lines.push(blank(), rule(width, ` @${comment.author}${comment.age === '' ? '' : ` · ${comment.age}`} `))
    lines.push(...(comment.body === '' ? plain('No text.', COLOR.muted, width, { italic: true }) : markdownLines(comment.body, width)))
  }
  if (issue.omitted > 0) {
    lines.push(
      blank(),
      ...plain(
        `… ${issue.omitted} comment${issue.omitted === 1 ? '' : 's'} left out: gx opens the issue`,
        COLOR.muted,
        width,
      ),
    )
  }

  return lines
}

function meta(issue: IssueDetail, width: number): Line[] {
  const lines: Line[] = []
  const opened = `@${issue.author}${issue.age === '' ? '' : ` opened ${issue.age === 'now' ? 'just now' : `${issue.age} ago`}`}`
  const state = `${issue.stateLabel} `
  for (const [at, text] of wrap(opened, width - cells(state)).entries()) {
    lines.push({
      lead: at === 0 ? state : ' '.repeat(cells(state)),
      leadColor: issue.isClosed ? COLOR.closed : COLOR.open,
      text,
      color: COLOR.comment,
    })
  }
  const fields: [string, string][] = [
    ['labels', issue.labels.join(', ')],
    ['assignees', issue.assignees.map(login => `@${login}`).join(', ')],
    ['milestone', issue.milestone],
  ]
  for (const [name, value] of fields) {
    if (value === '') continue
    const lead = `${name}: `
    for (const [at, text] of wrap(value, width - cells(lead)).entries()) {
      lines.push({ lead: at === 0 ? lead : ' '.repeat(cells(lead)), leadColor: COLOR.muted, text, color: COLOR.bullet })
    }
  }

  return lines
}

/**
 * Markdown as written, wrapped, each line tinted by what it is: headings,
 * quotes, fenced code, list items, and HTML comments (issue templates).
 */
function markdownLines(text: string, width: number): Line[] {
  const lines: Line[] = []
  let fence = ''
  let isComment = false

  for (const source of text.split('\n')) {
    const trimmed = source.trimStart()
    if (fence !== '') {
      if (trimmed.startsWith(fence)) fence = ''
      lines.push(...plain(source, COLOR.code, width))
      continue
    }
    const opens = /^(```|~~~)/.exec(trimmed)
    if (opens !== null) {
      fence = opens[1] ?? '```'
      lines.push(...plain(source, COLOR.code, width))
      continue
    }
    if (isComment || trimmed.startsWith('<!--')) {
      isComment = !source.includes('-->')
      lines.push(...plain(source, COLOR.muted, width))
      continue
    }
    if (/^#{1,6}\s/.test(trimmed)) {
      lines.push(...plain(source, COLOR.heading, width, { bold: true }))
      continue
    }
    if (trimmed.startsWith('>')) {
      lines.push(...plain(source, COLOR.comment, width, { italic: true }))
      continue
    }
    const item = /^(\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)(.*)$/.exec(source)
    if (item !== null) {
      const lead = item[1] ?? ''
      for (const [at, part] of wrap(item[2] ?? '', width - cells(lead)).entries()) {
        lines.push({
          lead: at === 0 ? lead : ' '.repeat(cells(lead)),
          leadColor: COLOR.bullet,
          text: part,
          color: COLOR.fg,
        })
      }
      continue
    }
    lines.push(...plain(source, COLOR.fg, width))
  }

  return lines
}

function plain(
  text: string,
  color: string,
  width: number,
  style: { bold?: boolean; italic?: boolean } = {},
): Line[] {
  return wrap(text, width).map(part => ({ lead: '', leadColor: color, text: part, color, ...style }))
}

function blank(): Line {
  return { lead: '', leadColor: COLOR.fg, text: '', color: COLOR.fg }
}

/** A rule across the width, a label set in it: `── @bob · 1d ─────`. */
function rule(width: number, label: string): Line {
  const head = label === '' ? '' : `──${clip(label, Math.max(0, width - 2))}`

  return {
    lead: head,
    leadColor: COLOR.folder,
    text: '─'.repeat(Math.max(0, width - cells(head))),
    color: COLOR.guide,
  }
}

function lineOf(surface: ClientSurface<View>, line: Line): RenderElement {
  const { Text } = surface.elements
  // An empty Text takes no row: a blank line is a space, or it vanishes and
  // the rows below it, the status bar too, move up.
  const text = line.lead === '' && line.text === '' ? ' ' : line.text

  return (
    <Text wrap="truncate-end">
      <Text color={line.leadColor}>{line.lead}</Text>
      <Text color={line.color} bold={line.bold} italic={line.italic}>
        {text}
      </Text>
    </Text>
  )
}

/** The open issue's first line in the window: back at the top for a new one. */
function scrollOf(view: View, props: IssuesProps, total: number, bodyRows: number): number {
  const scroll = view.scrollFor === refKey(props.ref) ? view.scroll : 0

  return clamp(scroll, 0, Math.max(0, total - bodyRows))
}

function refKey(ref: IssueRef | null): string {
  return ref === null ? '' : `${ref.repo}#${ref.number}`
}

// ------------------------------------------------------------------ chrome

function statusLine(
  surface: ClientSurface<View>,
  width: number,
  parts: { mode: 'normal' | 'issue' | 'help'; name: string; right: string },
): RenderElement {
  const { Text } = surface.elements
  const mode = ` ${parts.mode.toUpperCase()} `
  const background =
    parts.mode === 'help' ? COLOR.helpBg : parts.mode === 'issue' ? COLOR.issueBg : COLOR.modeBg
  const pad = ' '.repeat(Math.max(0, width - cells(mode) - cells(parts.name) - cells(parts.right)))

  return (
    <Text wrap="truncate-end">
      <Text color={COLOR.modeFg} backgroundColor={background} bold>
        {mode}
      </Text>
      <Text color={COLOR.folder} backgroundColor={COLOR.barMid}>
        {parts.name}
      </Text>
      <Text color={COLOR.barFg} backgroundColor={COLOR.barBg}>
        {pad}
        {parts.right}
      </Text>
    </Text>
  )
}

function helpLines(
  surface: ClientSurface<View>,
  help: readonly (readonly [string, string])[],
  width: number,
): RenderElement[] {
  const { Text } = surface.elements
  const keyWidth = 8

  return help.map(([keys, what]) => (
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

// -------------------------------------------------------------------- keys

function onKey(
  key: ClientKeyEvent,
  props: IssuesProps,
  surface: ClientSurface<View>,
  width: number,
  bodyRows: number,
): void {
  const view = surface.state ?? INITIAL
  if (view.isHelp) {
    surface.setState({ ...view, isHelp: false, pending: '' })

    return
  }
  if (props.mode === 'issue') onIssueKey(key, props, surface, view, width, bodyRows)
  else onListKey(key, props, surface, view, bodyRows)
}

function onListKey(
  key: ClientKeyEvent,
  props: IssuesProps,
  surface: ClientSurface<View>,
  view: View,
  bodyRows: number,
): void {
  const rows = props.rows
  const { index, top } = settle(view, rows, bodyRows)
  const row = rows[index]
  const half = Math.max(1, Math.floor(bodyRows / 2))
  const go = (to: number): void => {
    const at = clamp(to, 0, rows.length - 1)
    const target = rows[at]
    const next: View = { ...view, pending: '', opening: '', cursor: target === undefined ? '' : keyOf(target), index: at, top }
    surface.setState({ ...next, top: settle(next, rows, bodyRows).top })
  }
  const send = (message: IssuesMessage, change: Partial<View> = {}): void => {
    surface.post(message)
    surface.setState({ ...view, pending: '', ...change })
  }
  const issue = row?.kind === 'issue' ? { repo: row.repo, number: row.number } : undefined

  // An issue asked for is still being read: going back calls it off, or it
  // would open later, after the person had moved on.
  if (view.opening !== '' && ['h', 'left', 'backspace'].includes(key.key)) {
    surface.post({ op: 'back' } satisfies IssuesMessage)
    surface.setState({ ...view, pending: '', opening: '' })

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
    case 'q':
      return send({ op: 'quit' })
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
        if (row.isOpen) return send({ op: 'collapse', dir: row.dir })

        return
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
    case 'return':
    case 'o':
      return send({ op: 'open', ...issue }, { cursor: keyOf(row), index, opening: keyOf(row) })
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

function onIssueKey(
  key: ClientKeyEvent,
  props: IssuesProps,
  surface: ClientSurface<View>,
  view: View,
  width: number,
  bodyRows: number,
): void {
  const total = linesOf(props, width).length
  const scroll = scrollOf(view, props, total, bodyRows)
  const half = Math.max(1, Math.floor(bodyRows / 2))
  const ref = props.ref
  const to = (line: number): void =>
    surface.setState({
      ...view,
      pending: '',
      scroll: clamp(line, 0, Math.max(0, total - bodyRows)),
      scrollFor: refKey(ref),
    })
  const send = (message: IssuesMessage): void => {
    surface.post(message)
    if (view.pending !== '') surface.setState({ ...view, pending: '' })
  }
  const back = (): void => {
    surface.post({ op: 'back' } satisfies IssuesMessage)
    surface.setState({ ...view, pending: '', opening: '' })
  }

  if (key.ctrl) {
    if (key.key === 'd') to(scroll + half)
    if (key.key === 'u') to(scroll - half)
    if (key.key === 'f') to(scroll + bodyRows)
    if (key.key === 'b') to(scroll - bodyRows)

    return
  }
  if (view.pending === 'g') {
    if (key.key === 'g') to(0)
    else if (key.key === 'x' && ref !== null) send({ op: 'browse', ...ref })
    else surface.setState({ ...view, pending: '' })

    return
  }

  switch (key.key) {
    case 'j':
    case 'down':
      return to(scroll + 1)
    case 'k':
    case 'up':
      return to(scroll - 1)
    case 'G':
    case 'end':
      return to(total)
    case 'home':
      return to(0)
    case 'pagedown':
    case ' ':
    case 'space':
      return to(scroll + bodyRows)
    case 'pageup':
      return to(scroll - bodyRows)
    case 'g':
      return surface.setState({ ...view, pending: 'g' })
    case 'h':
    case 'left':
    case 'q':
    case 'backspace':
      return back()
    case 'R':
      return send({ op: 'refresh' })
    case '?':
      return surface.setState({ ...view, isHelp: true, pending: '' })
  }
  if (ref === null) return

  switch (key.key) {
    case 'c':
      return send({ op: 'send', ...ref })
    case 'i':
      return send({ op: 'fill', ...ref })
    case 'a':
      return send({ op: 'agent', ...ref })
    case '@':
      return send({ op: 'mention', ...ref })
    case 'y':
      return send({ op: 'copy', ...ref, as: 'number' })
    case 'Y':
      return send({ op: 'copy', ...ref, as: 'url' })
  }
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
  if (props.mode !== 'list') return
  const { index, top } = settle(view, props.rows, bodyRows)
  // Row 0 is the header.
  const at = top + event.y - 1
  const row = props.rows[at]
  if (event.y < 1 || event.y > bodyRows || row === undefined) return

  // A project opens on its first click; an issue on a second one.
  let opening = ''
  if (row.kind === 'project' && row.repo !== '') {
    surface.post({ op: 'toggle', dir: row.dir } satisfies IssuesMessage)
  } else if (row.kind === 'issue' && at === index) {
    surface.post({ op: 'open', repo: row.repo, number: row.number } satisfies IssuesMessage)
    opening = keyOf(row)
  }
  surface.setState({ ...view, cursor: keyOf(row), index: at, top, pending: '', opening })
}

// ------------------------------------------------------------------- text

/**
 * A line broken at spaces to fit `room` cells, a word longer than that
 * broken where it runs out; an empty line stays one empty row.
 */
function wrap(text: string, room: number): string[] {
  const width = Math.max(1, room)
  if (cells(text) <= width) return [text]
  const rows: string[] = []
  let line = ''
  for (const piece of text.split(/(\s+)/)) {
    if (piece === '') continue
    if (cells(line) + cells(piece) <= width) {
      line += piece
      continue
    }
    if (/^\s+$/.test(piece)) {
      rows.push(line)
      line = ''
      continue
    }
    if (line.trim() !== '') rows.push(line.trimEnd())
    line = ''
    let rest = piece
    while (cells(rest) > width) {
      const [head, tail] = splitAt(rest, width)
      rows.push(head)
      rest = tail
    }
    line = rest
  }
  if (line.trim() !== '' || rows.length === 0) rows.push(line.trimEnd())

  return rows
}

/**
 * The longest head of `text` that fits `room` cells, and the rest; with
 * `isForced`, at least one letter, so a wrap always moves on.
 */
function splitAt(text: string, room: number, isForced = true): [string, string] {
  let used = 0
  let head = ''
  const points = [...text]
  for (const [at, point] of points.entries()) {
    const size = widthOf(point)
    if (used + size > room && (head !== '' || !isForced)) return [head, points.slice(at).join('')]
    used += size
    head += point
  }

  return [head, '']
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

function clip(text: string, room: number): string {
  if (room <= 0) return ''
  if (cells(text) <= room) return text
  if (room === 1) return '…'
  const [head] = splitAt(text, room - 1, false)

  return `${head}…`
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(Math.max(low, high), value))
}
