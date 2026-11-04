import { atom, read, update } from 'claude-code'
import type {
  BoxProps,
  CodeProps,
  Color,
  ElementConstructor,
  EngineInterface,
  MarkdownProps,
  Register,
  RenderElement,
  RenderSurface,
  TextProps,
} from 'claude-code'

import type { Checks, ListRow, PrFilter, PrRef, PrsMessage, PrsProps, SheetTab } from '../types'
import {
  LIST_FIELDS,
  VIEW_FIELDS,
  ageOf,
  countOf,
  diffViewOf,
  firstLine,
  isPrNumber,
  markdownOf,
  parseDiff,
  parsePrList,
  parsePrView,
  prUrl,
  promptFor,
  reasonOf,
  remoteRepo,
} from './github'
import type { DiffFile, DiffView, RawDetail, RawPr } from './github'
import { ifDropped, isAbandoned, messageOf, otherwise, shared } from './shared'

const PANE = 'prs'
const TITLE = 'PRs'
// Room for `#123`, a title, a check mark and an age beside the chat.
const WIDTH = 44
// Repositories looked at under the root, each a `git remote`, and of them the
// GitHub projects listed, each a `gh pr list` per refresh.
const MAX_SCANNED = 24
const MAX_PROJECTS = 8
// Pull requests listed per project; one more is asked for, to tell `50` from `50+`.
const LIMIT = 50
// Pull requests live on the network: read them again every five minutes,
// or every two while a listed one's checks still run, since those settle in
// minutes. The clock looks once a minute.
const TICK_MS = 60_000
const REFRESH_MS = 300_000
const PENDING_REFRESH_MS = 120_000
const GH_TIMEOUT_MS = 20_000
// How much of a pull request's description and conversation the sheet
// draws, and of its diff's hunks, in characters: past it, the browser.
const DETAIL_ROOM = 60_000
const DIFF_ROOM = 60_000
// A command Claude runs that can change a pull request: the pane reads GitHub
// again. A push changes one too, and starts its checks. A read changes
// nothing, and Claude runs `gh pr view` and `gh pr diff` for every pull
// request the pane hands it, so those read nothing again.
// `gh api` writes when it names a method other than GET or sends fields (a
// reply to a review comment); `git push` may carry options before `push`.
const GH_WRITES = new RegExp(
  [
    /\bgh(?:\.exe)?\s+pr\s+(?:create|new|merge|close|reopen|edit|ready|review|comment|lock|unlock|update-branch)\b/.source,
    /\bgh(?:\.exe)?\s+api\b[^\n|;&]*?(?:\s(?:-X|--method)[\s=]*(?:POST|PATCH|PUT|DELETE)\b|\s(?:-f|-F|--field|--raw-field|--input)[\s=])/.source,
    /\bgit(?:\.exe)?\s[^\n|;&]*?\bpush\b/.source,
  ].join('|'),
  'i',
)
const ROOT_COLOR = '#bb9af7'
// The line between the chat and the sheet: the list's guide color.
const RULE_COLOR = '#565f89'
// GitHub cuts a search at 256 characters.
const MAX_QUERY = 256

const collapsed = atom({ plugin: 'gh-prs', key: 'collapsed' } as const, [], {
  shape: 'collapsed-1',
})
const filter = atom(
  { plugin: 'gh-prs', key: 'filter' } as const,
  { state: 'open', who: 'all', query: '' },
  { shape: 'filter-1' },
)
const opened = atom({ plugin: 'gh-prs', key: 'opened' } as const, null, {
  shape: 'opened-1',
})
const tab = atom({ plugin: 'gh-prs', key: 'tab' } as const, 'conversation', { shape: 'tab-1' })
const rev = atom({ plugin: 'gh-prs', key: 'rev' } as const, 0)
const isDismissed = atom({ plugin: 'gh-prs', key: 'isDismissed' } as const, false)

/** A git repository at the root or in a folder just under it. */
type Project = {
  /** Its folder under the root, `''` for the root itself. */
  dir: string
  name: string
  /** Its folder, whole. */
  path: string
  /** `owner/repo` on GitHub, `''` when no remote is there. */
  repo: string
}

type Listing = { prs: RawPr[] } | { error: string }
type Viewing = { detail: RawDetail } | { error: string }
type Diffing = { files: DiffFile[]; isCut: boolean } | { error: string }

/** What the sheet, or a pane without one, shows of the open pull request. */
type Content =
  | { kind: 'conversation'; markdown: string }
  | { kind: 'files'; view: DiffView }
  | { kind: 'error'; text: string }

/** The elements a pull request's content is drawn with: every surface has them. */
type Drawing = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Code: ElementConstructor<CodeProps>
  Markdown: ElementConstructor<MarkdownProps>
}

/** The projects under a root, and whether more repositories are there than were read. */
type Discovery = { projects: Project[]; isCapped: boolean }

// The projects under each root, found once and kept across revisions: only
// R looks at the folders again, since a refresh is for what GitHub says.
let discovered = new Map<string, Promise<Discovery>>()
// What GitHub said, per revision, shared by every draw and every key that
// asks: each repository's listing per filter, and each pull request opened
// and its diff. A new revision starts them over.
let readAt:
  | {
      revision: number
      root: string
      listings: Map<string, Promise<Listing>>
      views: Map<string, Promise<Viewing>>
      diffs: Map<string, Promise<Diffing>>
    }
  | undefined
// When GitHub was last read again, and whether a pull request the list last
// drew has checks still running: the clock reads sooner while one has.
let lastRead = 0
let hasPending = false

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prs',
      description:
        "Toggle the pane of GitHub pull requests of this folder's projects, or open it on a search (label:bug draft:false)",
      argumentHint: '[search]',
    })
    // Unasked, the pane opens only where there are pull requests to show; the
    // projects are found after the session starts, so it never waits on git.
    if (!(await read($, isDismissed))) {
      void projectsOf($)
        .then(projects =>
          projects.some(one => one.repo !== '')
            ? $.ui.open({ id: PANE, title: TITLE, columns: WIDTH })
            : undefined,
        )
        .catch(() => {})
    }
    lastRead = await $.clock.now()
    $.clock.every(TICK_MS, () => void refreshIfDue($).catch(() => {}))

    return next(e)
  })

  on('command.run', { command: 'prs' }, async ($, e) => {
    // `/prs label:bug` opens the pane on that search, shown or not.
    const query = queryOf(e.args)
    if (query !== '') {
      await update($, filter, now => ({ ...now, query }))
      await update($, isDismissed, () => false)
      await $.ui.open({ id: PANE, title: TITLE, columns: WIDTH, focus: true })

      return { text: `PRs pane opened on the search ${query}. / in the pane changes it.` }
    }
    const isShown = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
    if (isShown) {
      await $.ui.close({ id: PANE })

      return { text: 'PRs pane closed.' }
    }
    await update($, isDismissed, () => false)
    await $.ui.open({ id: PANE, title: TITLE, columns: WIDTH, focus: true })

    return { text: 'PRs pane opened. Click it for hjkl keys, ? for help.' }
  })

  // The sheet draws only beside a drawn pane, which is no state a draw can
  // read: opened, the pane has the band drawn again, its sheet too.
  on('ui.open', { id: PANE }, async ($, e, next) => {
    const result = await next(e)
    $.ui.invalidate('ui.render')

    return result
  }).catch(($, e, next) => next(e))

  // Neither hook judges anything: a failure lets the close or the call go on.
  // Closed, the pane takes the sheet of its open pull request with it.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'unload') {
      await update($, isDismissed, () => true)
      await update($, opened, () => null)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (GH_WRITES.test(commandOf(e))) await bump($).catch(() => {})

    return result
  }).catch(($, e, next) => next(e))

  on('ui.message', { requestId: PANE }, async ($, e, next) => {
    const projects = await projectsOf($)
    const message = parseMessage(e.data, projects)
    if (message !== undefined) await act($, message, projects, e.surface)

    return next(e)
  }).catch(($, e, next) => {
    // A key that failed says why in a toast, not as a hook error.
    sayFailed($, next.error.message)

    return next(e)
  })

  // The open pull request, wide, in the band above the prompt: a sheet over
  // the bottom of the chat with its conversation or its diff, and what to do.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const open = await read($, opened)
    if (open === null || e.props.hasSurvey) return next(e)
    // The sheet goes with the list: a pane closed, waiting undrawn on a
    // narrow terminal, or a tab behind another (gh-issues', whose sheet is
    // then drawn beneath) leaves the chat without a pull request over it.
    // A draw the engine dropped for a newer one passes, saying nothing.
    const panes = await $.ui.panes().catch(ifDropped)
    if (!panes?.some(pane => pane.id === PANE && pane.isShown && pane.isPlaced)) return next(e)
    const projects = await projectsOf($).catch(ifDropped)
    if (projects === undefined || !projects.some(one => one.repo === open.repo)) return next(e)
    const shownTab = await read($, tab)
    const content = await contentOf($, open, shownTab).catch(ifDropped)
    if (content === undefined) return next(e)
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const press = (message: PrsMessage) => () => pressed($, message, projects, e.surface)
    // Each action is its key in brackets, `[ c ]`, and its name beside it:
    // the terminal draws a Button's label in brackets, never its hotkey.
    const actions: { key: string; hotkey: string; name: string; message: PrsMessage }[] = [
      { key: 'sheet-review', hotkey: 'c', name: 'Review', message: { op: 'review', ...open } },
      { key: 'sheet-fix', hotkey: 'f', name: 'Fix', message: { op: 'fix', ...open } },
      { key: 'sheet-fill', hotkey: 'i', name: 'Fill prompt', message: { op: 'fill', ...open } },
      { key: 'sheet-agent', hotkey: 'a', name: 'Agent', message: { op: 'agent', ...open } },
      {
        key: 'sheet-diff',
        hotkey: 'd',
        name: shownTab === 'files' ? 'Conversation' : 'Diff',
        message: { op: 'diff', ...open },
      },
      { key: 'sheet-browse', hotkey: 'b', name: 'Browser', message: { op: 'browse', ...open } },
      { key: 'sheet-close', hotkey: 'x', name: 'Close', message: { op: 'back' } },
    ]
    const label = ` ${open.repo}#${open.number} `
    const rule = `──${label}${'─'.repeat(Math.max(0, e.props.bodyColumns - label.length - 2))}`

    return (
      <Box flexDirection="column">
        <Text color={RULE_COLOR}>{rule}</Text>
        <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
          {actions.map(action => (
            <Box flexDirection="row">
              <Button
                key={action.key}
                hotkey={action.hotkey}
                variant={action.hotkey === 'c' ? 'primary' : undefined}
                role={action.hotkey === 'x' ? 'dismiss' : undefined}
                onPress={press(action.message)}
              >
                {action.hotkey}
              </Button>
              <Text>{` ${action.name}`}</Text>
            </Box>
          ))}
        </Box>
        <Box marginTop={1}>{contentTree(elements, content)}</Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // The band above the prompt is drawn where a Client is: there the sheet
    // shows the open pull request, and elsewhere the pane does.
    if (e.surface === 'terminal' || e.surface === 'desktop') {
      const props = await propsOf($, e.props.bodyColumns, e.props.scroll.bodyRows).catch(ifDropped)
      const { Box, Client } = $.ui.resolve(e)
      // Dropped for a newer draw: what this one returns is never drawn.
      if (props === undefined) return <Box />

      return (
        <Client
          key="prs"
          module="./prs.tsx"
          props={props}
          width={props.width}
          height={props.height}
        />
      )
    }

    // No Client on this surface: rows to press, and the pull request itself.
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const [projects, open] = await Promise.all([projectsOf($).catch(ifDropped), read($, opened)])
    if (projects === undefined) return <Box />
    const press = (message: PrsMessage) => () => pressed($, message, projects, e.surface)

    if (open !== null && projects.some(one => one.repo === open.repo)) {
      const shownTab = await read($, tab)
      const content = await contentOf($, open, shownTab).catch(ifDropped)
      if (content === undefined) return <Box />

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            <Button key="back" onPress={press({ op: 'back' })}>
              Back
            </Button>
            <Button key="review" variant="primary" onPress={press({ op: 'review', ...open })}>
              Review
            </Button>
            <Button key="fix" onPress={press({ op: 'fix', ...open })}>
              Fix
            </Button>
            <Button key="fill" onPress={press({ op: 'fill', ...open })}>
              Fill prompt
            </Button>
            <Button key="agent" onPress={press({ op: 'agent', ...open })}>
              Agent
            </Button>
            <Button key="diff" onPress={press({ op: 'diff', ...open })}>
              {shownTab === 'files' ? 'Conversation' : 'Diff'}
            </Button>
            <Button key="browse" onPress={press({ op: 'browse', ...open })}>
              Browser
            </Button>
          </Box>
          {contentTree(elements, content)}
        </Box>
      )
    }

    const props = await propsOf($, e.props.bodyColumns, e.props.scroll.bodyRows).catch(ifDropped)
    if (props === undefined) return <Box />

    return (
      <Box flexDirection="column">
        <Text color={ROOT_COLOR} bold>
          {props.root}
          <Text dimColor>{props.cap > 0 ? `  first ${props.cap} projects` : ''}</Text>
        </Text>
        {props.rows.map(row => {
          if (row.kind === 'project') {
            if (row.repo === '') {
              return <Text dimColor>{`  ${row.name}  no GitHub remote`}</Text>
            }

            return (
              <Button key={`p:${row.dir}`} plain onPress={press({ op: 'toggle', dir: row.dir })}>
                {row.isOpen ? '▾ ' : '▸ '}
                {row.name} <Text dimColor>{`${row.repo} ${countText(row)}`}</Text>
              </Button>
            )
          }
          if (row.kind === 'note') {
            return <Text color={row.isError ? 'error' : undefined} dimColor={!row.isError}>{`  ${row.text}`}</Text>
          }

          return (
            <Button
              key={`${row.repo}#${row.number}`}
              plain
              onPress={press({ op: 'open', repo: row.repo, number: row.number })}
            >
              {`  #${row.number} ${row.title} `}
              <Text color={CHECK_COLOR[row.checks]}>{CHECK_GLYPH[row.checks]}</Text>
              <Text dimColor>{row.age}</Text>
            </Button>
          )
        })}
      </Box>
    )
  })
}

// A pull request's checks on a surface without a Client, in theme colors.
const CHECK_GLYPH: Record<Checks, string> = { pass: '✓ ', fail: '✗ ', pending: '● ', '': '' }
const CHECK_COLOR: Record<Checks, Color | undefined> = {
  pass: 'success',
  fail: 'error',
  pending: 'warning',
  '': undefined,
}

/** The list the pane's Client draws. */
async function propsOf($: EngineInterface, width: number, height: number): Promise<PrsProps> {
  const [shut, shown, open, root, now] = await Promise.all([
    read($, collapsed),
    read($, filter),
    read($, opened),
    $.session.root(),
    $.clock.now(),
  ])
  const { projects, isCapped } = await discoveryOf($)
  const shownOpen = open !== null && projects.some(one => one.repo === open.repo) ? open : null
  const listings = await Promise.all(
    projects.map(one => (one.repo === '' ? undefined : listingOf($, one.repo, shown))),
  )
  const rows: ListRow[] = []
  for (const [index, one] of projects.entries()) {
    const listing = listings[index]
    if (listing === undefined) {
      rows.push({ kind: 'project', dir: one.dir, name: one.name, repo: '', isOpen: false, count: 0, isLimited: false, isFailed: false })
      continue
    }
    const listed = 'prs' in listing ? listing.prs : []
    const prs = listed.slice(0, LIMIT)
    const isOpen = !shut.includes(one.dir)
    rows.push({
      kind: 'project',
      dir: one.dir,
      name: one.name,
      repo: one.repo,
      isOpen,
      count: prs.length,
      isLimited: listed.length > LIMIT,
      isFailed: 'error' in listing,
    })
    if (!isOpen) continue
    if ('error' in listing) {
      rows.push({ kind: 'note', dir: one.dir, text: listing.error, isError: true, isLast: true })
    } else if (prs.length === 0) {
      rows.push({ kind: 'note', dir: one.dir, text: noneText(shown), isError: false, isLast: true })
    }
    for (const [at, pr] of prs.entries()) {
      rows.push({
        kind: 'pr',
        dir: one.dir,
        repo: one.repo,
        number: pr.number,
        title: pr.title,
        status: pr.status,
        checks: pr.checks,
        age: ageOf(pr.updatedAt, now),
        isLast: at === prs.length - 1,
      })
    }
  }
  // Read off what was listed, closed projects too, for the clock's next look.
  hasPending = listings.some(listing => listing !== undefined && 'prs' in listing && listing.prs.some(pr => pr.checks === 'pending'))

  if (rows.length === 0) {
    rows.push({
      kind: 'note',
      dir: '',
      text: 'No git repository here or just below',
      isError: false,
      isLast: true,
    })
  }

  return {
    root: rootLabel(root),
    cap: isCapped ? MAX_PROJECTS : 0,
    filter: shown,
    open: shownOpen,
    rows,
    width,
    height,
  }
}

/** The open pull request's conversation, or its diff, as the tab says. */
async function contentOf($: EngineInterface, ref: PrRef, shownTab: SheetTab): Promise<Content> {
  const name = `${ref.repo}#${ref.number}`
  if (shownTab === 'files') {
    const diffing = await diffOf($, ref)
    if ('error' in diffing) return { kind: 'error', text: `Could not read the changes of ${name}: ${diffing.error}` }

    return { kind: 'files', view: diffViewOf(diffing.files, DIFF_ROOM, diffing.isCut) }
  }
  const [viewing, now] = await Promise.all([viewOf($, ref), $.clock.now()])
  if ('error' in viewing) return { kind: 'error', text: `Could not read ${name}: ${viewing.error}` }

  return { kind: 'conversation', markdown: markdownOf(viewing.detail, ref.repo, now, DETAIL_ROOM) }
}

function contentTree(elements: Drawing, content: Content): RenderElement {
  const { Box, Text, Code, Markdown } = elements
  if (content.kind === 'error') return <Text color="error">{content.text}</Text>
  if (content.kind === 'conversation') return <Markdown text={content.markdown} />
  const { view } = content

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{`${countOf(view.files.length, 'file')} changed`}</Text>
        <Text color="success">{`  +${view.added}`}</Text>
        <Text color="error">{` −${view.removed}`}</Text>
      </Text>
      {view.files.map(file => (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text bold>{file.path}</Text>
            <Text dimColor>{file.from === '' ? '' : ` ← ${file.from}`}</Text>
            <Text color="success">{`  +${file.added}`}</Text>
            <Text color="error">{` −${file.removed}`}</Text>
            <Text dimColor>{file.note === '' ? '' : `  ${file.note}`}</Text>
          </Text>
          {file.isLeftOut ? (
            <Text dimColor>Too long to show here: open the pull request in the browser.</Text>
          ) : file.hunks === '' ? null : (
            <Code format="diff" path={file.path} source={file.hunks} />
          )}
        </Box>
      ))}
      {view.isCut ? (
        <Box marginTop={1}>
          <Text dimColor>The diff is cut short here: open the pull request in the browser for the rest.</Text>
        </Box>
      ) : null}
    </Box>
  )
}

async function act(
  $: EngineInterface,
  message: PrsMessage,
  projects: readonly Project[],
  surface: RenderSurface,
): Promise<void> {
  switch (message.op) {
    case 'toggle':
      await update($, collapsed, list =>
        list.includes(message.dir)
          ? list.filter(dir => dir !== message.dir)
          : [...list, message.dir],
      )
      break
    case 'expand':
      await update($, collapsed, list => list.filter(dir => dir !== message.dir))
      break
    case 'collapse':
      await update($, collapsed, list =>
        list.includes(message.dir) ? list : [...list, message.dir],
      )
      break
    case 'collapseAll':
      await update($, collapsed, () => projects.map(one => one.dir))
      break
    case 'cycleState':
      await update($, filter, now => ({ ...now, state: nextState(now.state) }))
      break
    case 'cycleWho':
      await update($, filter, now => ({ ...now, who: nextWho(now.who) }))
      break
    case 'query':
      await update($, filter, now => ({ ...now, query: message.text }))
      break
    // R alone looks at the folders again, for a repository cloned since.
    case 'refresh':
      discovered = new Map()
      await bump($)
      break
    case 'browseAll': {
      const project = projects.find(one => one.dir === message.dir && one.repo !== '')
      if (project === undefined) break
      const shown = await read($, filter)
      const ran = await run($, ['gh', 'pr', 'list', '--repo', project.repo, ...filterArgs(shown), '--web'])
      if ('error' in ran) $.ui.toast(`Could not open the pull requests of ${project.repo}: ${ran.error}`)
      break
    }
    case 'back':
      await update($, opened, () => null)
      break
    case 'quit':
      await $.ui.close({ id: PANE })
      break
    case 'open':
      await update($, tab, () => 'conversation')
      await update($, opened, () => ({ repo: message.repo, number: message.number }))
      break
    // On the pull request the sheet shows, d turns between its conversation
    // and its files; on another, it shows that one's files.
    case 'diff': {
      const now = await read($, opened)
      const isShown = now?.repo === message.repo && now.number === message.number
      await update($, tab, shown => (isShown && shown === 'files' ? 'conversation' : 'files'))
      if (!isShown) await update($, opened, () => ({ repo: message.repo, number: message.number }))
      break
    }
    case 'mention':
      await $.prompt.fill({ text: `${message.repo}#${message.number} `, mode: 'insert' })
      break
    case 'copy': {
      const text = message.as === 'url' ? prUrl(message.repo, message.number) : `#${message.number}`
      const copied = await $.ui.copy({ text, surface })
      $.ui.toast(copied.isCopied ? `Copied ${text}` : `Could not copy: ${copied.reason}`)
      break
    }
    case 'browse': {
      const ran = await run($, ['gh', 'pr', 'view', String(message.number), '--repo', message.repo, '--web'])
      if ('error' in ran) $.ui.toast(`Could not open ${message.repo}#${message.number}: ${ran.error}`)
      break
    }
    case 'review':
    case 'fix':
    case 'fill':
    case 'agent': {
      const project = projects.find(one => one.repo === message.repo)
      if (project === undefined) break
      const pr = `${message.repo}#${message.number}`
      const text = promptFor({
        kind: message.op === 'agent' ? 'review' : message.op,
        repo: message.repo,
        number: message.number,
        dir: project.dir,
        path: project.path,
        isAgent: message.op === 'agent',
      })
      if (message.op === 'fill') {
        const filled = await $.prompt.fill({ text: `${text}\n`, mode: 'insert' })
        if (!filled.isFilled) $.ui.toast('The prompt box could not take the text')
      } else if (message.op === 'agent') {
        const spawned = await $.agent.spawn({
          prompt: text,
          description: `Review ${pr}`,
          subagentType: 'general-purpose',
          cwd: project.path,
        })
        $.ui.toast(
          spawned.deny === undefined
            ? `A subagent is reviewing ${pr} in ${project.name}`
            : `No subagent started: ${spawned.deny}`,
        )
      } else {
        const sent = await $.prompt.submit({ text, asUser: true })
        const what = message.op === 'fix' ? 'to fix' : 'to review'
        $.ui.toast(sent.drop === undefined ? `Sent ${pr} to Claude ${what}` : `Not sent: ${sent.drop}`)
      }
      break
    }
  }
}

/** A Button's press: what failed says why in a toast, as a key's does. */
async function pressed(
  $: EngineInterface,
  message: PrsMessage,
  projects: readonly Project[],
  surface: RenderSurface,
): Promise<void> {
  await act($, message, projects, surface).catch(error => sayFailed($, messageOf(error)))
}

function sayFailed($: EngineInterface, reason: string | undefined): void {
  const line = firstLine(reason ?? '')
  $.ui.toast(line === '' ? 'PRs: that did not work' : `PRs: ${line}`)
}

async function bump($: EngineInterface): Promise<void> {
  lastRead = await $.clock.now()
  await update($, rev, n => n + 1)
}

/** The clock's look: GitHub read again when due, while the pane is drawn. */
async function refreshIfDue($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (now - lastRead < (hasPending ? PENDING_REFRESH_MS : REFRESH_MS)) return
  const panes = await $.ui.panes()
  if (panes.some(pane => pane.id === PANE && pane.isShown && pane.isPlaced)) {
    await bump($)
  }
}

/** This revision's reads: started over when the revision or the root moves. */
async function readsOf($: EngineInterface): Promise<NonNullable<typeof readAt>> {
  const [revision, root] = await Promise.all([read($, rev), $.session.root()])
  if (readAt?.revision !== revision || readAt.root !== root) {
    readAt = { revision, root, listings: new Map(), views: new Map(), diffs: new Map() }
  }

  return readAt
}

async function discoveryOf($: EngineInterface): Promise<Discovery> {
  const root = await $.session.root()

  return shared(discovered, root, () => discover($, root))
}

async function projectsOf($: EngineInterface): Promise<Project[]> {
  return (await discoveryOf($)).projects
}

async function listingOf($: EngineInterface, repo: string, shown: PrFilter): Promise<Listing> {
  const { listings } = await readsOf($)

  return shared(listings, `${repo}|${shown.state}|${shown.who}|${shown.query}`, () =>
    readListing($, repo, shown),
  )
}

async function viewOf($: EngineInterface, ref: PrRef): Promise<Viewing> {
  const { views } = await readsOf($)

  return shared(views, `${ref.repo}#${ref.number}`, () => readView($, ref))
}

async function diffOf($: EngineInterface, ref: PrRef): Promise<Diffing> {
  const { diffs } = await readsOf($)

  return shared(diffs, `${ref.repo}#${ref.number}`, () => readDiff($, ref))
}

/**
 * The root, when it is a repository, then each folder just under it that is
 * one, in the order a file tree draws them; one row per GitHub repository,
 * up to MAX_PROJECTS of them, which a folder off GitHub or a second clone
 * never counts against.
 */
async function discover($: EngineInterface, root: string): Promise<Discovery> {
  const entries = await $.fs.list(root).catch(otherwise([]))
  const dirs = entries
    .filter(entry => entry.kind === 'dir' && entry.name !== '.git')
    .map(entry => entry.name)
    .sort(compareNames)
  const candidates = ['', ...dirs]
  // A worktree's `.git` is a file: `exists` takes either.
  const isRepo = await Promise.all(
    candidates.map(dir =>
      $.fs.exists(absoluteOf(root, dir === '' ? '.git' : `${dir}/.git`)).catch(otherwise(false)),
    ),
  )
  const repoDirs = candidates.filter((_, index) => isRepo[index])
  const scanned = repoDirs.slice(0, MAX_SCANNED)
  const repos = await Promise.all(
    scanned.map(async dir => {
      const remotes = await $.process
        .run(['git', 'remote', '-v'], { cwd: absoluteOf(root, dir) })
        .catch(otherwise(undefined))

      return remotes?.exitCode === 0 ? (remoteRepo(remotes.stdout) ?? '') : ''
    }),
  )

  const seen = new Set<string>()
  const projects: Project[] = []
  let isCapped = repoDirs.length > scanned.length
  for (const [index, dir] of scanned.entries()) {
    const repo = repos[index] ?? ''
    if (repo !== '') {
      // Two clones of one repository list its pull requests once.
      if (seen.has(repo.toLowerCase())) continue
      if (seen.size === MAX_PROJECTS) {
        isCapped = true
        continue
      }
      seen.add(repo.toLowerCase())
    }
    projects.push({ dir, name: dir === '' ? rootLabel(root) : dir, path: absoluteOf(root, dir), repo })
  }

  return { projects, isCapped }
}

/** The flags of `gh pr list` that pick what the filter lists. */
function filterArgs(shown: PrFilter): string[] {
  // Waiting on your review is a search of its own, beside the one typed.
  const search = [shown.who === 'review' ? 'review-requested:@me' : '', shown.query]
    .filter(part => part !== '')
    .join(' ')

  return [
    '--state', shown.state,
    ...(shown.who === 'mine' ? ['--author', '@me'] : []),
    // GitHub's search syntax; an `is:` in it outranks --state.
    ...(search !== '' ? ['--search', search] : []),
  ]
}

async function readListing($: EngineInterface, repo: string, shown: PrFilter): Promise<Listing> {
  const argv = [
    'gh', 'pr', 'list',
    '--repo', repo,
    '--limit', String(LIMIT + 1),
    '--json', LIST_FIELDS,
    ...filterArgs(shown),
  ]
  const ran = await run($, argv)
  if ('error' in ran) return ran
  const prs = parsePrList(ran.stdout)
  if (prs === undefined) return { error: 'gh answered something that is not a list of pull requests' }

  return { prs }
}

async function readView($: EngineInterface, ref: PrRef): Promise<Viewing> {
  const ran = await run($, [
    'gh', 'pr', 'view', String(ref.number),
    '--repo', ref.repo,
    '--json', VIEW_FIELDS,
  ])
  if ('error' in ran) return ran
  const detail = parsePrView(ran.stdout)
  if (detail === undefined) return { error: 'gh answered something that is not a pull request' }

  return { detail }
}

async function readDiff($: EngineInterface, ref: PrRef): Promise<Diffing> {
  const ran = await run($, ['gh', 'pr', 'diff', String(ref.number), '--repo', ref.repo, '--color', 'never'])
  if ('error' in ran) return ran

  return { files: parseDiff(ran.stdout), isCut: ran.isCut }
}

/** Runs `gh`, saying why in one line when it did not answer. */
async function run(
  $: EngineInterface,
  argv: string[],
): Promise<{ stdout: string; isCut: boolean } | { error: string }> {
  try {
    const ran = await $.process.run(argv, { timeoutMs: GH_TIMEOUT_MS })
    if (ran.exitCode === 0) return { stdout: ran.stdout, isCut: ran.isStdoutTruncated }

    return { error: reasonOf(ran.stderr) || firstLine(ran.stdout) || `gh exited with ${ran.exitCode}` }
  } catch (error) {
    const message = messageOf(error)
    // Killed past its time, the call rejects: GitHub was slow, gh is there.
    // Asked first, so a timeout's words are never taken for a dropped draw.
    if (/\btime(?:d)? ?out\b|\btimeout\b/i.test(message) && !/abandon/i.test(message)) {
      return { error: 'GitHub took too long to answer: try R later' }
    }
    // Cut short with the draw that made it: `shared` reads it again.
    if (isAbandoned(error)) throw error
    const reason = firstLine(message)

    return { error: `Could not run gh${reason === '' ? '' : `: ${reason}`}. Is the GitHub CLI installed?` }
  }
}

// What the Client and the buttons post is input: only shapes they send, and
// only pull requests of the projects found, so a post never reads another
// repository or starts an agent in a folder of its choosing.
function parseMessage(data: unknown, projects: readonly Project[]): PrsMessage | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const { op, dir, repo, number, as, text } = data as Record<string, unknown>
  const isProject = (value: unknown): value is string =>
    typeof value === 'string' && projects.some(one => one.repo !== '' && one.dir === value)
  const isRepo = (value: unknown): value is string =>
    typeof value === 'string' && value !== '' && projects.some(one => one.repo === value)

  switch (op) {
    case 'back':
    case 'refresh':
    case 'cycleState':
    case 'cycleWho':
    case 'collapseAll':
    case 'quit':
      return { op }
    case 'toggle':
    case 'expand':
    case 'collapse':
    case 'browseAll':
      return isProject(dir) ? { op, dir } : undefined
    case 'open':
    case 'diff':
    case 'review':
    case 'fix':
    case 'fill':
    case 'agent':
    case 'browse':
    case 'mention':
      return isRepo(repo) && isPrNumber(number) ? { op, repo, number } : undefined
    case 'copy':
      return isRepo(repo) && isPrNumber(number) && (as === 'number' || as === 'url')
        ? { op, repo, number, as }
        : undefined
    // Any text: it reaches gh as one argument of its own, never a shell.
    case 'query':
      return typeof text === 'string' ? { op, text: queryOf(text) } : undefined
    default:
      return undefined
  }
}

/** A search as typed, on one line, without control characters, cut to GitHub's length. */
function queryOf(text: string): string {
  const line = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim()

  return [...line].slice(0, MAX_QUERY).join('')
}

function commandOf(e: { tool: string }): string {
  if (e.tool !== 'Bash' && e.tool !== 'PowerShell') return ''
  const { command } = e as { command?: unknown }

  return typeof command === 'string' ? command : ''
}

function nextState(state: PrFilter['state']): PrFilter['state'] {
  return state === 'open' ? 'merged' : state === 'merged' ? 'closed' : state === 'closed' ? 'all' : 'open'
}

function nextWho(who: PrFilter['who']): PrFilter['who'] {
  return who === 'all' ? 'mine' : who === 'mine' ? 'review' : 'all'
}

function noneText(shown: PrFilter): string {
  if (shown.query !== '') return 'No pull requests match the search'
  const which = shown.state === 'all' ? 'No pull requests' : `No ${shown.state} pull requests`
  if (shown.who === 'mine') return `${which} of yours`
  if (shown.who === 'review') return `${which} waiting on your review`

  return which
}

function countText(row: Extract<ListRow, { kind: 'project' }>): string {
  if (row.isFailed) return '!'

  return row.isLimited ? `${row.count}+` : String(row.count)
}

// Case-insensitive, with case breaking ties so the order never depends on
// what the disk listed first.
function compareNames(a: string, b: string): number {
  return compareStrings(a.toLowerCase(), b.toLowerCase()) || compareStrings(a, b)
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** A `/`-separated path under the root, whole, in the root's own separators. */
function absoluteOf(root: string, path: string): string {
  if (path === '') return root
  const separator = root.includes('\\') ? '\\' : '/'

  return `${root.replace(/[\\/]$/, '')}${separator}${path.split('/').join(separator)}`
}

function rootLabel(root: string): string {
  const trimmed = root.replace(/\\/g, '/').replace(/\/+$/, '')

  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || '/'
}
