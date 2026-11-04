import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type {
  IssueDetail,
  IssueFilter,
  IssueRef,
  IssuesMessage,
  IssuesProps,
  ListRow,
} from '../types'
import {
  LIST_FIELDS,
  VIEW_FIELDS,
  ageOf,
  detailOf,
  firstLine,
  isIssueNumber,
  issueUrl,
  markdownOf,
  parseIssueList,
  parseIssueView,
  promptFor,
  reasonOf,
  remoteRepo,
} from './github'
import type { RawDetail, RawIssue } from './github'
import { ifDropped, isAbandoned, messageOf, otherwise, shared } from './shared'

const PANE = 'issues'
const TITLE = 'Issues'
// Room for `#123`, a title and an age beside the chat.
const WIDTH = 44
// Projects read per refresh: each costs a `git remote` and a `gh issue list`.
const MAX_PROJECTS = 8
const LIMIT = 50
// Issues live on the network: read them again every five minutes, not seconds.
const REFRESH_MS = 300_000
const GH_TIMEOUT_MS = 20_000
// How much of an issue's description and comments the sheet draws, in
// characters: past it, the rest is left to the browser.
const DETAIL_ROOM = 60_000
// A command Claude runs that can change an issue: the pane reads GitHub again.
// A read changes nothing, and Claude runs `gh issue view` for every issue the
// pane hands it, so `view`, `list` and `status` read nothing again.
const GH_WRITES =
  /\bgh(?:\.exe)?\s+(?:issue\s+(?:create|new|edit|close|reopen|comment|delete|transfer|pin|unpin|lock|unlock|develop)|pr\s+(?:create|new|merge|close|reopen|edit))\b/
const ROOT_COLOR = '#bb9af7'
// The line between the chat and the sheet: the list's guide color.
const RULE_COLOR = '#565f89'

const collapsed = atom({ plugin: 'gh-issues', key: 'collapsed' } as const, [], {
  shape: 'collapsed-1',
})
// `filter-2` added the query: a filter stored before it reads as the default.
const filter = atom(
  { plugin: 'gh-issues', key: 'filter' } as const,
  { state: 'open', mine: false, query: '' },
  { shape: 'filter-2' },
)
// GitHub cuts a search at 256 characters.
const MAX_QUERY = 256
const opened = atom({ plugin: 'gh-issues', key: 'opened' } as const, null, {
  shape: 'opened-1',
})
const rev = atom({ plugin: 'gh-issues', key: 'rev' } as const, 0)
const isDismissed = atom({ plugin: 'gh-issues', key: 'isDismissed' } as const, false)

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

type Listing = { issues: RawIssue[] } | { error: string }
type Viewing = { detail: RawDetail } | { error: string }

// What GitHub said, per revision, shared by every draw and every key that
// asks: the projects under a root, each repository's listing per filter, and
// each issue opened. A new revision starts them over.
let readAt:
  | {
      revision: number
      root: string
      /** One entry, under the root. */
      projects: Map<string, Promise<Project[]>>
      listings: Map<string, Promise<Listing>>
      views: Map<string, Promise<Viewing>>
    }
  | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'issues',
      description:
        "Toggle the pane of GitHub issues of this folder's projects, or open it on a search (assignee:@me label:bug)",
      argumentHint: '[search]',
    })
    // Unasked, the pane opens only where there are issues to show; the
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
    $.clock.every(REFRESH_MS, () => void refreshIfShown($).catch(() => {}))

    return next(e)
  })

  on('command.run', { command: 'issues' }, async ($, e) => {
    // `/issues assignee:@me` opens the pane on that search, shown or not.
    const query = queryOf(e.args)
    if (query !== '') {
      await update($, filter, now => ({ ...now, query }))
      await update($, isDismissed, () => false)
      await $.ui.open({ id: PANE, title: TITLE, columns: WIDTH, focus: true })

      return { text: `Issues pane opened on the search ${query}. / in the pane changes it.` }
    }
    const isShown = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
    if (isShown) {
      await $.ui.close({ id: PANE })

      return { text: 'Issues pane closed.' }
    }
    await update($, isDismissed, () => false)
    await $.ui.open({ id: PANE, title: TITLE, columns: WIDTH, focus: true })

    return { text: 'Issues pane opened. Click it for hjkl keys, ? for help.' }
  })

  // The sheet draws only beside a drawn pane, which is no state a draw can
  // read: opened, the pane has the band drawn again, its issue's sheet too.
  on('ui.open', { id: PANE }, async ($, e, next) => {
    const result = await next(e)
    $.ui.invalidate('ui.render')

    return result
  }).catch(($, e, next) => next(e))

  // Neither hook judges anything: a failure lets the close or the call go on.
  // Closed, the pane takes the sheet of its open issue with it.
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

  // The open issue, wide, in the band above the prompt: a sheet over the
  // bottom of the chat with the issue's Markdown and what to do with it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const open = await read($, opened)
    if (open === null || e.props.hasSurvey) return next(e)
    // The sheet goes with the list: a pane closed, or waiting undrawn on a
    // narrow terminal, leaves the chat without an issue over it.
    // A draw the engine dropped for a newer one passes, saying nothing.
    const panes = await $.ui.panes().catch(ifDropped)
    if (!panes?.some(pane => pane.id === PANE && pane.isPlaced)) return next(e)
    const projects = await projectsOf($).catch(ifDropped)
    if (projects === undefined || !projects.some(one => one.repo === open.repo)) return next(e)
    const [viewing, now] = await Promise.all([viewOf($, open).catch(ifDropped), $.clock.now()])
    if (viewing === undefined) return next(e)
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const press = (message: IssuesMessage) => () => pressed($, message, projects, e.surface)
    // Each action is its key in brackets, `[ c ]`, and its name beside it:
    // the terminal draws a Button's label in brackets, never its hotkey.
    const actions: { key: string; hotkey: string; name: string; message: IssuesMessage }[] = [
      { key: 'sheet-send', hotkey: 'c', name: 'Send to Claude', message: { op: 'send', ...open } },
      { key: 'sheet-fill', hotkey: 'i', name: 'Fill prompt', message: { op: 'fill', ...open } },
      { key: 'sheet-agent', hotkey: 'a', name: 'Agent', message: { op: 'agent', ...open } },
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
        <Box marginTop={1}>
          {'detail' in viewing ? (
            <Markdown text={markdownOf(detailOf(viewing.detail, open.repo, now, DETAIL_ROOM))} />
          ) : (
            <Text color="error">{`Could not read ${open.repo}#${open.number}: ${viewing.error}`}</Text>
          )}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // The band above the prompt is drawn where a Client is: there the sheet
    // shows the open issue, and elsewhere the pane does.
    const withSheet = e.surface === 'terminal' || e.surface === 'desktop'
    const props = await propsOf($, e.props.bodyColumns, e.props.scroll.bodyRows, withSheet).catch(
      ifDropped,
    )
    // Dropped for a newer draw: what this one returns is never drawn.
    if (props === undefined) {
      const { Box } = $.ui.resolve(e)

      return <Box />
    }

    if (withSheet) {
      const { Client } = $.ui.resolve(e)

      return (
        <Client
          key="issues"
          module="./issues.tsx"
          props={props}
          width={props.width}
          height={props.height}
        />
      )
    }

    // No Client on this surface: rows to press, and the issue as Markdown.
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const projects = await projectsOf($).catch(ifDropped)
    if (projects === undefined) return <Box />
    const press = (message: IssuesMessage) => () => pressed($, message, projects, e.surface)
    const { ref, issue } = props

    if (props.mode === 'issue' && ref !== null) {
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1}>
            <Button key="back" onPress={press({ op: 'back' })}>
              Back
            </Button>
            <Button key="send" variant="primary" onPress={press({ op: 'send', ...ref })}>
              Send to Claude
            </Button>
            <Button key="fill" onPress={press({ op: 'fill', ...ref })}>
              Fill prompt
            </Button>
            <Button key="agent" onPress={press({ op: 'agent', ...ref })}>
              Agent
            </Button>
            <Button key="browse" onPress={press({ op: 'browse', ...ref })}>
              Browser
            </Button>
          </Box>
          {issue === null ? (
            <Text color="error">{props.error}</Text>
          ) : (
            <Markdown text={markdownOf(issue)} />
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text color={ROOT_COLOR} bold>
          {props.root}
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
              <Text dimColor>{row.age}</Text>
            </Button>
          )
        })}
      </Box>
    )
  })
}

/**
 * What the pane draws. `withSheet`: the open issue shows in the sheet above
 * the prompt and the pane stays the list, marking it; else the pane shows it.
 */
async function propsOf(
  $: EngineInterface,
  width: number,
  height: number,
  withSheet: boolean,
): Promise<IssuesProps> {
  const [shut, shown, open, root, now] = await Promise.all([
    read($, collapsed),
    read($, filter),
    read($, opened),
    $.session.root(),
    $.clock.now(),
  ])
  const projects = await projectsOf($)
  const project = open === null ? undefined : projects.find(one => one.repo === open.repo)
  const shownOpen = project === undefined ? null : open
  const base = { root: rootLabel(root), filter: shown, open: shownOpen, width, height }

  if (!withSheet && open !== null && project !== undefined) {
    const viewing = await viewOf($, open)
    const issue: IssueDetail | null =
      'detail' in viewing ? detailOf(viewing.detail, open.repo, now, DETAIL_ROOM) : null

    return {
      ...base,
      mode: 'issue',
      rows: [],
      ref: open,
      issue,
      error: 'error' in viewing ? viewing.error : '',
    }
  }

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
    const issues = 'issues' in listing ? listing.issues : []
    const isOpen = !shut.includes(one.dir)
    rows.push({
      kind: 'project',
      dir: one.dir,
      name: one.name,
      repo: one.repo,
      isOpen,
      count: issues.length,
      isLimited: issues.length >= LIMIT,
      isFailed: 'error' in listing,
    })
    if (!isOpen) continue
    if ('error' in listing) {
      rows.push({ kind: 'note', dir: one.dir, text: listing.error, isError: true, isLast: true })
    } else if (issues.length === 0) {
      rows.push({ kind: 'note', dir: one.dir, text: noneText(shown), isError: false, isLast: true })
    }
    for (const [at, issue] of issues.entries()) {
      rows.push({
        kind: 'issue',
        dir: one.dir,
        repo: one.repo,
        number: issue.number,
        title: issue.title,
        isClosed: issue.isClosed,
        age: ageOf(issue.updatedAt, now),
        isLast: at === issues.length - 1,
      })
    }
  }

  if (rows.length === 0) {
    rows.push({
      kind: 'note',
      dir: '',
      text: 'No git repository here or just below',
      isError: false,
      isLast: true,
    })
  }

  return { ...base, mode: 'list', rows, ref: null, issue: null, error: '' }
}

async function act(
  $: EngineInterface,
  message: IssuesMessage,
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
    case 'toggleMine':
      await update($, filter, now => ({ ...now, mine: !now.mine }))
      break
    case 'query':
      await update($, filter, now => ({ ...now, query: message.text }))
      break
    case 'refresh':
      await bump($)
      break
    case 'back':
      await update($, opened, () => null)
      break
    case 'quit':
      await $.ui.close({ id: PANE })
      break
    case 'open':
      await update($, opened, () => ({ repo: message.repo, number: message.number }))
      break
    case 'mention':
      await $.prompt.fill({ text: `${message.repo}#${message.number} `, mode: 'insert' })
      break
    case 'copy': {
      const text = message.as === 'url' ? issueUrl(message.repo, message.number) : `#${message.number}`
      const copied = await $.ui.copy({ text, surface })
      $.ui.toast(copied.isCopied ? `Copied ${text}` : `Could not copy: ${copied.reason}`)
      break
    }
    case 'browse': {
      const ran = await run($, ['gh', 'issue', 'view', String(message.number), '--repo', message.repo, '--web'])
      if ('error' in ran) $.ui.toast(`Could not open ${message.repo}#${message.number}: ${ran.error}`)
      break
    }
    case 'send':
    case 'fill':
    case 'agent': {
      const project = projects.find(one => one.repo === message.repo)
      if (project === undefined) break
      const issue = `${message.repo}#${message.number}`
      const text = promptFor({
        repo: message.repo,
        number: message.number,
        dir: project.dir,
        path: project.path,
        isAgent: message.op === 'agent',
      })
      if (message.op === 'send') {
        const sent = await $.prompt.submit({ text, asUser: true })
        $.ui.toast(sent.drop === undefined ? `Sent ${issue} to Claude` : `Not sent: ${sent.drop}`)
      } else if (message.op === 'fill') {
        const filled = await $.prompt.fill({ text: `${text}\n`, mode: 'insert' })
        if (!filled.isFilled) $.ui.toast('The prompt box could not take the text')
      } else {
        const spawned = await $.agent.spawn({
          prompt: text,
          description: `Issue ${issue}`,
          subagentType: 'general-purpose',
          cwd: project.path,
        })
        $.ui.toast(
          spawned.deny === undefined
            ? `A subagent is working on ${issue} in ${project.name}`
            : `No subagent started: ${spawned.deny}`,
        )
      }
      break
    }
  }
}

/** A Button's press: what failed says why in a toast, as a key's does. */
async function pressed(
  $: EngineInterface,
  message: IssuesMessage,
  projects: readonly Project[],
  surface: RenderSurface,
): Promise<void> {
  await act($, message, projects, surface).catch(error => sayFailed($, messageOf(error)))
}

function sayFailed($: EngineInterface, reason: string | undefined): void {
  const line = firstLine(reason ?? '')
  $.ui.toast(line === '' ? 'Issues: that did not work' : `Issues: ${line}`)
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

/** This revision's reads: started over when the revision or the root moves. */
async function readsOf($: EngineInterface): Promise<NonNullable<typeof readAt>> {
  const [revision, root] = await Promise.all([read($, rev), $.session.root()])
  if (readAt?.revision !== revision || readAt.root !== root) {
    readAt = { revision, root, projects: new Map(), listings: new Map(), views: new Map() }
  }

  return readAt
}

async function projectsOf($: EngineInterface): Promise<Project[]> {
  const { root, projects } = await readsOf($)

  return shared(projects, root, () => discover($, root))
}

async function listingOf(
  $: EngineInterface,
  repo: string,
  shown: IssueFilter,
): Promise<Listing> {
  const { listings } = await readsOf($)

  return shared(listings, `${repo}|${shown.state}|${shown.mine}|${shown.query}`, () =>
    readListing($, repo, shown),
  )
}

async function viewOf($: EngineInterface, ref: IssueRef): Promise<Viewing> {
  const { views } = await readsOf($)

  return shared(views, `${ref.repo}#${ref.number}`, () => readView($, ref))
}

/**
 * The root, when it is a repository, then each folder just under it that is
 * one, in the order a file tree draws them; one row per GitHub repository.
 */
async function discover($: EngineInterface, root: string): Promise<Project[]> {
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
  const repoDirs = candidates.filter((_, index) => isRepo[index]).slice(0, MAX_PROJECTS)
  const repos = await Promise.all(
    repoDirs.map(async dir => {
      const remotes = await $.process
        .run(['git', 'remote', '-v'], { cwd: absoluteOf(root, dir) })
        .catch(otherwise(undefined))

      return remotes?.exitCode === 0 ? (remoteRepo(remotes.stdout) ?? '') : ''
    }),
  )

  const seen = new Set<string>()
  const projects: Project[] = []
  for (const [index, dir] of repoDirs.entries()) {
    const repo = repos[index] ?? ''
    // Two clones of one repository list its issues once.
    if (repo !== '' && seen.has(repo.toLowerCase())) continue
    seen.add(repo.toLowerCase())
    projects.push({ dir, name: dir === '' ? rootLabel(root) : dir, path: absoluteOf(root, dir), repo })
  }

  return projects
}

async function readListing(
  $: EngineInterface,
  repo: string,
  shown: IssueFilter,
): Promise<Listing> {
  const argv = [
    'gh', 'issue', 'list',
    '--repo', repo,
    '--state', shown.state,
    '--limit', String(LIMIT),
    '--json', LIST_FIELDS,
    ...(shown.mine ? ['--assignee', '@me'] : []),
    // GitHub's search syntax; an `is:open` or `is:closed` in it outranks --state.
    ...(shown.query !== '' ? ['--search', shown.query] : []),
  ]
  const ran = await run($, argv)
  if ('error' in ran) return ran
  const issues = parseIssueList(ran.stdout)
  if (issues === undefined) return { error: 'gh answered something that is not a list of issues' }

  return { issues }
}

async function readView($: EngineInterface, ref: IssueRef): Promise<Viewing> {
  const ran = await run($, [
    'gh', 'issue', 'view', String(ref.number),
    '--repo', ref.repo,
    '--json', VIEW_FIELDS,
  ])
  if ('error' in ran) return ran
  const detail = parseIssueView(ran.stdout)
  if (detail === undefined) return { error: 'gh answered something that is not an issue' }

  return { detail }
}

/** Runs `gh`, saying why in one line when it did not answer. */
async function run(
  $: EngineInterface,
  argv: string[],
): Promise<{ stdout: string } | { error: string }> {
  try {
    const ran = await $.process.run(argv, { timeoutMs: GH_TIMEOUT_MS })
    if (ran.exitCode === 0) return { stdout: ran.stdout }

    return { error: reasonOf(ran.stderr) || firstLine(ran.stdout) || `gh exited with ${ran.exitCode}` }
  } catch (error) {
    // Cut short with the draw that made it: `shared` reads it again.
    if (isAbandoned(error)) throw error
    const reason = firstLine(messageOf(error))

    return { error: `Could not run gh${reason === '' ? '' : `: ${reason}`}. Is the GitHub CLI installed?` }
  }
}

// What the Client posts is input: only shapes it sends, and only issues of
// the projects found, so a post never reads another repository or starts an
// agent in a folder of its choosing.
function parseMessage(data: unknown, projects: readonly Project[]): IssuesMessage | undefined {
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
    case 'toggleMine':
    case 'collapseAll':
    case 'quit':
      return { op }
    case 'toggle':
    case 'expand':
    case 'collapse':
      return isProject(dir) ? { op, dir } : undefined
    case 'open':
    case 'send':
    case 'fill':
    case 'agent':
    case 'browse':
    case 'mention':
      return isRepo(repo) && isIssueNumber(number) ? { op, repo, number } : undefined
    case 'copy':
      return isRepo(repo) && isIssueNumber(number) && (as === 'number' || as === 'url')
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

function nextState(state: IssueFilter['state']): IssueFilter['state'] {
  return state === 'open' ? 'closed' : state === 'closed' ? 'all' : 'open'
}

function noneText(shown: IssueFilter): string {
  if (shown.query !== '') return 'No issues match the search'
  const which = shown.state === 'all' ? 'No issues' : `No ${shown.state} issues`

  return shown.mine ? `${which} assigned to you` : which
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
