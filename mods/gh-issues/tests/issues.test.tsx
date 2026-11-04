import { expect, mock, test } from 'claude-code/testing'
import type { Mounted, TestBody } from 'claude-code/testing'
import type { FsEntry } from 'claude-code'

const PANE = {
  plugin: 'gh-issues',
  component: 'Pane',
  requestId: 'issues',
  props: {
    title: 'Issues',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const ROOT = 'C:\\Users\\dev\\projects-root'
const NOW = Date.parse('2026-11-03T12:00:00Z')
const CURSOR = '#292e42'

const dir = (name: string): FsEntry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
const file = (name: string): FsEntry => ({ name, kind: 'file', size: 1, mtimeMs: 1, isLink: false })

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

type Issue = { number: number; title: string; state?: string; updatedAt?: string }

const BACKEND: Issue[] = [
  { number: 42, title: 'Login breaks on Safari', updatedAt: '2026-11-01T12:00:00Z' },
  { number: 12, title: 'Typo in README', updatedAt: '2026-10-13T12:00:00Z' },
]
const FRONTEND: Issue[] = [{ number: 7, title: 'Dark mode', updatedAt: '2026-11-03T09:00:00Z' }]

const VIEW_42 = {
  number: 42,
  title: 'Login breaks on Safari',
  state: 'OPEN',
  stateReason: '',
  author: { login: 'alice' },
  createdAt: '2026-10-30T12:00:00Z',
  url: 'https://github.com/acme/backend/issues/42',
  labels: [{ name: 'bug' }],
  assignees: [{ login: 'bob' }],
  milestone: null,
  body: '## Steps\r\nOpen the login page\r\nSecond line',
  comments: [{ author: { login: 'bob' }, createdAt: '2026-11-02T12:00:00Z', body: 'I can reproduce it.' }],
}

// The engine hands the fs hooks a path resolved under its working directory,
// which a test runs in the plugin's own folder: this is the part under ROOT.
function inRoot(path: string): string {
  return path.replace(/\\/g, '/').replace(/^.*?\/projects-root(\/|$)/, '')
}

type Setup = {
  /** What the root lists. */
  disk?: readonly FsEntry[]
  /** Each repository's folder ('' for the root) and its `origin` URL. */
  remotes?: Record<string, string>
  /** `gh issue list` per repository. */
  issues?: Record<string, Issue[]>
  /** `gh issue view` per `owner/repo#n`. */
  views?: Record<string, unknown>
  /** Repositories whose `gh` fails, with what it writes to stderr. */
  failing?: Record<string, string>
}

/** Stands for the engine beneath the mod: the disk, git, gh and the prompt. */
function engine(on: On, setup: Setup = {}) {
  const {
    disk = [dir('backend'), dir('frontend'), file('notes.md')],
    remotes = {
      backend: 'git@github.com:acme/backend.git',
      frontend: 'https://github.com/acme/web.git',
    },
    issues = { 'acme/backend': BACKEND, 'acme/web': FRONTEND },
    views = { 'acme/backend#42': VIEW_42 },
    failing = {},
  } = setup
  const lists: string[][] = []
  const viewed: string[] = []
  const remoteIn: string[] = []
  const submitted: string[] = []
  const filled: string[] = []
  const spawned: { prompt: string; cwd?: string; description: string }[] = []
  const copied: string[] = []

  const clock = mock.clock(on, { now: NOW })
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.list', (_, e) => ({ value: inRoot(e.path) === '' ? [...disk] : [] }))
  on('fs.exists', (_, e) => {
    const path = inRoot(e.path)
    const folder = path === '.git' ? '' : path.replace(/\/\.git$/, '')

    return { value: path.endsWith('.git') && folder in remotes }
  })
  on('process.run', (_, e) => {
    const argv = e.argv
    const ok = (stdout: string) => ({
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (argv[0] === 'git' && argv[1] === 'remote') {
      const folder = inRoot(e.init?.cwd ?? ROOT)
      remoteIn.push(folder)
      const url = remotes[folder] ?? ''

      return ok(url === '' ? '' : `origin\t${url} (fetch)\norigin\t${url} (push)\n`)
    }
    const repo = argv[argv.indexOf('--repo') + 1] ?? ''
    const stderr = failing[repo]
    if (stderr !== undefined) {
      return {
        value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false },
      }
    }
    if (argv[0] === 'gh' && argv[2] === 'list') {
      lists.push([...argv])

      return ok(JSON.stringify((issues[repo] ?? []).map(issue => ({ state: 'OPEN', ...issue }))))
    }
    if (argv[0] === 'gh' && argv[2] === 'view') {
      viewed.push(`${repo}#${argv[3]}`)

      return ok(JSON.stringify(views[`${repo}#${argv[3]}`] ?? {}))
    }

    return { value: { exitCode: 1, stdout: '', stderr: 'unknown', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)

    return { text: e.text }
  })
  on('agent.spawn', (_, e) => {
    spawned.push({ prompt: e.prompt, cwd: e.cwd, description: e.description })

    return { model: 'test', agentId: 'a1' }
  })
  on('ui.copy', (_, e) => {
    copied.push(e.text)

    return { value: { isCopied: true } }
  })
  on('ui.toast', () => ({ value: undefined }))
  // Whether the pane is drawn, as `$.ui.panes()` says; a test may change it.
  const drawn: { pane: 'placed' | 'unplaced' | 'closed' } = { pane: 'placed' }
  on('ui.panes', () => ({
    value:
      drawn.pane === 'closed'
        ? []
        : [{ id: 'issues', title: 'Issues', isShown: true, isFocused: false, isPlaced: drawn.pane === 'placed' }],
  }))
  // The engine's own band above the prompt, drawn where the mod passes.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine band</Text>
  })

  return { clock, lists, viewed, remoteIn, submitted, filled, spawned, copied, drawn }
}

function mount<S extends 'terminal' | 'desktop' | 'vscode' | 'mobile'>($: Engine, surface: S) {
  return $.ui.mount({ ...PANE, surface })
}

const BAND = {
  plugin: 'gh-issues',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

/** The band above the prompt: the engine's own line (see engine()) where the mod passes. */
function sheet<S extends 'terminal' | 'desktop'>($: Engine, surface: S) {
  return $.ui.mount({ ...BAND, surface })
}

async function sheetText<S extends 'terminal' | 'desktop'>(
  band: Mounted<S, 'AbovePrompt'>,
): Promise<string | undefined> {
  const markdown = await band.find({ type: 'Markdown' })

  return markdown === undefined ? undefined : String(markdown.props.text)
}

test('a folder of two projects lists the issues of each', async ($, on) => {
  const { lists, remoteIn } = engine(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, surface)
    expect(await ui.find({ type: 'Text', text: /^backend$/, in: 'issues' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^frontend$/, in: 'issues' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Login breaks on Safari/, in: 'issues' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Dark mode/, in: 'issues' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' 2d', in: 'issues' })).toBeDefined()
    // The root is no repository: only its two projects were asked.
    expect(new Set(remoteIn)).toEqual(new Set(['backend', 'frontend']))
    await ui.unmount()
  }
  expect(new Set(lists.map(argv => argv[argv.indexOf('--repo') + 1]))).toEqual(
    new Set(['acme/backend', 'acme/web']),
  )
  expect(lists[0]).toEqual(expect.arrayContaining(['--state', 'open']))
})

test('a root that is a repository lists its own issues', async ($, on) => {
  engine(on, {
    disk: [dir('src'), file('README.md')],
    remotes: { '': 'https://github.com/acme/backend' },
  })
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^projects-root$/, in: 'issues' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Typo in README/, in: 'issues' })).toBeDefined()
  await ui.unmount()
})

test('a project off GitHub runs no gh, and a second clone is listed once', async ($, on) => {
  const { lists } = engine(on, {
    disk: [dir('backend'), dir('backend-copy'), dir('scripts')],
    remotes: {
      backend: 'https://github.com/acme/backend.git',
      'backend-copy': 'ssh://git@github.com/acme/backend',
      scripts: 'https://gitlab.com/acme/scripts.git',
    },
  })
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^scripts$/, in: 'issues' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /no GitHub remote/, in: 'issues' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^backend-copy$/, in: 'issues' })).toBeUndefined()
  expect(lists.map(argv => argv[argv.indexOf('--repo') + 1])).toEqual(['acme/backend'])
  await ui.unmount()
})

test('Enter shows an issue in the sheet above the prompt, x puts it away', async ($, on) => {
  const { viewed } = engine(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, surface)
    const band = await sheet($, surface)
    expect(await band.find({ type: 'Text', text: 'engine band' })).toBeDefined()

    await ui.key({ key: 'j', in: 'issues' })
    await ui.key({ key: 'return', in: 'issues' })
    const text = (await sheetText(band)) ?? ''
    expect(text).toContain('## Login breaks on Safari · acme/backend#42')
    expect(text).toContain('**Open** · @alice opened 4d ago · `bug`')
    // Windows line ends from GitHub leave no `\r` behind.
    expect(text).toContain('## Steps\nOpen the login page\nSecond line')
    expect(text).toContain('**@bob** · 1d ago\n\nI can reproduce it.')
    // A line parts the sheet from the chat; each action is its key in brackets.
    expect(await band.find({ type: 'Text', text: /^── acme\/backend#42 ─+$/ })).toBeDefined()
    expect((await band.find({ type: 'Button', key: 'sheet-send' }))?.text).toBe('c')
    expect(await band.find({ type: 'Text', text: ' Send to Claude' })).toBeDefined()
    // The pane stays the list, its cursor where it was, the issue marked.
    expect((await ui.find({ type: 'Text', text: '#42 ', in: 'issues' }))?.props.backgroundColor).toBe(CURSOR)
    expect(await ui.find({ type: 'Text', text: ' ◆', in: 'issues' })).toBeDefined()

    await ui.key({ key: 'x', in: 'issues' })
    expect(await sheetText(band)).toBeUndefined()
    expect(await band.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' ◆', in: 'issues' })).toBeUndefined()

    // Enter on the shown issue puts it away too, and q does before it closes the pane.
    await ui.key({ key: 'return', in: 'issues' })
    expect(await sheetText(band)).toBeDefined()
    await ui.key({ key: 'return', in: 'issues' })
    expect(await sheetText(band)).toBeUndefined()
    await ui.key({ key: 'return', in: 'issues' })
    await ui.key({ key: 'q', in: 'issues' })
    expect(await sheetText(band)).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /NORMAL/, in: 'issues' })).toBeDefined()
    await band.unmount()
    await ui.unmount()
  }
  expect(viewed).toContain('acme/backend#42')
})

test('the sheet’s buttons send the issue, fill the prompt, start an agent and close', async ($, on) => {
  const { submitted, filled, spawned } = engine(on)
  const ui = await mount($, 'terminal')
  const band = await sheet($, 'terminal')
  await ui.key({ key: 'j', in: 'issues' })
  await ui.key({ key: 'return', in: 'issues' })

  await band.press({ key: 'sheet-send' })
  expect(submitted.at(-1)).toContain('Work on GitHub issue acme/backend#42.')
  await band.press({ key: 'sheet-fill' })
  expect(filled.at(-1)).toContain('gh issue view 42 --repo acme/backend --comments')
  await band.press({ key: 'sheet-agent' })
  expect(spawned.at(-1)?.cwd).toBe(`${ROOT}\\backend`)

  await band.press({ key: 'sheet-close' })
  expect(await sheetText(band)).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: ' ◆', in: 'issues' })).toBeUndefined()
  // Closed from the sheet, the list says nothing more about it.
  expect(await ui.find({ type: 'Text', text: /opening/, in: 'issues' })).toBeUndefined()
  await band.unmount()
  await ui.unmount()
})

for (const pane of ['unplaced', 'closed'] as const) {
  test(`an open issue draws no sheet while the pane is ${pane}`, async ($, on) => {
    const { drawn } = engine(on)
    on('ui.open', () => {
      drawn.pane = 'placed'

      return { value: { isPlaced: true } }
    })
    const ui = await mount($, 'terminal')
    const band = await sheet($, 'terminal')
    await ui.key({ key: 'j', in: 'issues' })
    await ui.key({ key: 'return', in: 'issues' })
    expect(await sheetText(band)).toBeDefined()

    // The issue stays open, as a resumed session keeps it, but the list is gone.
    drawn.pane = pane
    await ui.key({ key: 'R', in: 'issues' })
    expect(await sheetText(band)).toBeUndefined()
    expect(await band.find({ type: 'Text', text: 'engine band' })).toBeDefined()

    // Drawn again, the pane brings its sheet back: placed as the terminal
    // widens, which draws the band again, or opened again with /issues.
    if (pane === 'unplaced') {
      drawn.pane = 'placed'
      await band.redraw({ ...BAND.props, bodyColumns: 120 })
    } else {
      await $.command.run({
        command: 'issues',
        args: '',
        origin: { kind: 'composer' },
        presentation: { isFullscreen: true, columns: 200 },
      })
    }
    expect(await sheetText(band)).toBeDefined()
    await band.unmount()
    await ui.unmount()
  })
}

test('c sends the issue to Claude, i fills the prompt, a starts a subagent', async ($, on) => {
  const { submitted, filled, spawned } = engine(on)
  const ui = await mount($, 'terminal')
  await ui.key({ key: 'j', in: 'issues' })

  await ui.key({ key: 'c', in: 'issues' })
  const sent = submitted.at(-1) ?? ''
  expect(sent).toContain('Work on GitHub issue acme/backend#42.')
  expect(sent).toContain(`The project is at backend/ (${ROOT}\\backend)`)
  expect(sent).toContain('gh issue view 42 --repo acme/backend --comments')
  // The issue's own text, title included, reaches Claude through gh, not as
  // the person's words: whoever opened the issue wrote it.
  expect(sent).not.toContain('Login breaks on Safari')
  expect(sent).not.toContain('Open the login page')

  await ui.key({ key: 'i', in: 'issues' })
  expect(filled.at(-1)).toContain('acme/backend#42')

  await ui.key({ key: 'a', in: 'issues' })
  expect(spawned.at(-1)?.cwd).toBe(`${ROOT}\\backend`)
  expect(spawned.at(-1)?.description).toBe('Issue acme/backend#42')
  expect(spawned.at(-1)?.prompt).toContain('The project is the folder you are in')
  await ui.unmount()
})

test('@ mentions the issue and y Y copy its number and address', async ($, on) => {
  const { filled, copied } = engine(on)
  const ui = await mount($, 'terminal')
  await ui.key({ key: 'j', in: 'issues' })
  await ui.key({ key: '@', in: 'issues' })
  expect(filled.at(-1)).toBe('acme/backend#42 ')
  await ui.key({ key: 'y', in: 'issues' })
  await ui.key({ key: 'Y', in: 'issues' })
  expect(copied).toEqual(['#42', 'https://github.com/acme/backend/issues/42'])
  await ui.unmount()
})

test('s cycles the state and m keeps only issues assigned to me', async ($, on) => {
  const { lists } = engine(on)
  const ui = await mount($, 'terminal')
  await ui.key({ key: 's', in: 'issues' })
  expect(lists.at(-1)).toEqual(expect.arrayContaining(['--state', 'closed']))
  expect(await ui.find({ type: 'Text', text: / closed /, in: 'issues' })).toBeDefined()

  await ui.key({ key: 'm', in: 'issues' })
  expect(lists.at(-1)).toEqual(expect.arrayContaining(['--assignee', '@me']))
  await ui.unmount()
})

test('/ types a search on the bottom line, Enter lists by it', async ($, on) => {
  const { lists } = engine(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, surface)
    await ui.key({ key: '/', in: 'issues' })
    // Every key is typed, the ones the list takes for itself (g, b, q) too.
    for (const typed of 'assignee:@me label:bug') {
      await ui.key({ key: typed === ' ' ? 'space' : typed, in: 'issues' })
    }
    expect(await ui.find({ type: 'Text', text: '/assignee:@me label:bug', in: 'issues' })).toBeDefined()
    await ui.key({ key: 'backspace', in: 'issues' })
    await ui.key({ key: 'g', in: 'issues' })
    await ui.key({ key: 'return', in: 'issues' })

    expect(lists.at(-1)).toEqual(expect.arrayContaining(['--search', 'assignee:@me label:bug']))
    expect(await ui.find({ type: 'Text', text: '  /assignee:@me label:bug', in: 'issues' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /NORMAL/, in: 'issues' })).toBeDefined()

    // Ctrl-u clears the line, and an empty search lists everything again.
    await ui.key({ key: '/', in: 'issues' })
    await ui.key({ key: 'u', ctrl: true, in: 'issues' })
    await ui.key({ key: 'return', in: 'issues' })
    expect(await ui.find({ type: 'Text', text: /^ {2}\//, in: 'issues' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Dark mode/, in: 'issues' })).toBeDefined()

    // Backspace on an empty line puts it away, searching nothing.
    const asked = lists.length
    await ui.key({ key: '/', in: 'issues' })
    await ui.key({ key: 'backspace', in: 'issues' })
    expect(await ui.find({ type: 'Text', text: /NORMAL/, in: 'issues' })).toBeDefined()
    expect(lists.length).toBe(asked)
    await ui.unmount()
  }
})

test('/issues with a search opens the pane on it', async ($, on) => {
  const { lists } = engine(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run({
    command: 'issues',
    args: '  label:bug \n is:open ',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  const ui = await mount($, 'terminal')
  expect(lists.at(-1)).toEqual(expect.arrayContaining(['--search', 'label:bug is:open']))
  expect(await ui.find({ type: 'Text', text: '  /label:bug is:open', in: 'issues' })).toBeDefined()
  await ui.unmount()
})

test('a posted search is one line, cut to what GitHub takes', async ($, on) => {
  const { lists } = engine(on)
  const ui = await mount($, 'terminal')
  await ui.post({ op: 'query', text: `label:bug\u0007\n${'x'.repeat(400)}` }, { in: 'issues' })
  const search = lists.at(-1)?.[(lists.at(-1)?.indexOf('--search') ?? -2) + 1] ?? ''
  expect(search.startsWith('label:bug x')).toBe(true)
  expect([...search].length).toBe(256)
  await ui.unmount()
})

test('a gh that fails says why under its project', async ($, on) => {
  engine(on, {
    failing: { 'acme/web': 'To get started with GitHub CLI, please run:  gh auth login\nAlternatively...' },
  })
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'Not signed in: run gh auth login', in: 'issues' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' !', in: 'issues' })).toBeDefined()
  // The other project is drawn as ever.
  expect(await ui.find({ type: 'Text', text: /^Login breaks on Safari/, in: 'issues' })).toBeDefined()
  await ui.unmount()
})

test('a gh command Claude runs reads GitHub again', async ($, on) => {
  const { lists } = engine(on)
  on('tool.call', () => ({ result: {} }))
  const ui = await mount($, 'terminal')
  const before = lists.length
  await $.tool.call({ tool: 'Bash', command: 'gh issue close 42 --repo acme/backend' })
  await ui.find({ type: 'Text', text: /^backend$/, in: 'issues' })
  expect(lists.length).toBeGreaterThan(before)

  // A read, as Claude runs for every issue the pane hands it, reads nothing again.
  const after = lists.length
  await $.tool.call({ tool: 'Bash', command: 'gh issue view 42 --repo acme/backend --comments' })
  await $.tool.call({ tool: 'PowerShell', command: 'gh issue list --repo acme/backend' })
  await ui.find({ type: 'Text', text: /^backend$/, in: 'issues' })
  expect(lists.length).toBe(after)
  await ui.unmount()
})

test('Backspace on a project closes it, Enter opens and closes it', async ($, on) => {
  engine(on)
  const ui = await mount($, 'terminal')
  // The cursor starts on backend, the first project.
  await ui.key({ key: 'backspace', in: 'issues' })
  expect(await ui.find({ type: 'Text', text: /^Login breaks on Safari/, in: 'issues' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Dark mode/, in: 'issues' })).toBeDefined()

  await ui.key({ key: 'return', in: 'issues' })
  expect(await ui.find({ type: 'Text', text: /^Login breaks on Safari/, in: 'issues' })).toBeDefined()
  await ui.key({ key: 'return', in: 'issues' })
  expect(await ui.find({ type: 'Text', text: /^Login breaks on Safari/, in: 'issues' })).toBeUndefined()
  await ui.unmount()
})

test('a post for a repository or folder not found runs nothing', async ($, on) => {
  const { viewed, spawned, submitted } = engine(on)
  const ui = await mount($, 'terminal')
  await ui.post({ op: 'agent', repo: 'evil/repo', number: 1 }, { in: 'issues' })
  await ui.post({ op: 'send', repo: 'acme/backend', number: 1.5 }, { in: 'issues' })
  await ui.post({ op: 'open', repo: '../acme', number: 42 }, { in: 'issues' })
  await ui.post({ op: 'toggle', dir: '../outside' }, { in: 'issues' })

  expect(spawned).toEqual([])
  expect(submitted).toEqual([])
  expect(viewed).toEqual([])
  expect(await ui.find({ type: 'Text', text: /^Login breaks on Safari/, in: 'issues' })).toBeDefined()
  await ui.unmount()
})

test('a long issue is cut to fit and says so', async ($, on) => {
  engine(on, {
    views: {
      'acme/backend#42': {
        ...VIEW_42,
        body: 'word '.repeat(14_000),
        comments: [VIEW_42.comments[0], VIEW_42.comments[0]],
      },
    },
  })
  const ui = await mount($, 'terminal')
  const band = await sheet($, 'terminal')
  await ui.key({ key: 'j', in: 'issues' })
  await ui.key({ key: 'return', in: 'issues' })
  const text = (await sheetText(band)) ?? ''
  expect(text.length).toBeLessThan(65_000)
  expect(text).toContain('The rest of the description is left out')
  expect(text).toContain('2 comments left out')
  await band.unmount()
  await ui.unmount()
})

test('without a Client the rows are buttons and the issue is Markdown', async ($, on) => {
  engine(on)
  for (const surface of ['vscode', 'mobile'] as const) {
    const ui = await mount($, surface)
    expect(await ui.find({ type: 'Button', key: 'acme/backend#42' })).toBeDefined()

    await ui.press({ key: 'p:backend' })
    expect(await ui.find({ type: 'Button', key: 'acme/backend#42' })).toBeUndefined()
    await ui.press({ key: 'p:backend' })

    await ui.press({ key: 'acme/backend#42' })
    const markdown = await ui.find({ type: 'Markdown' })
    expect(String(markdown?.props.text)).toContain('## Login breaks on Safari · acme/backend#42')
    expect(String(markdown?.props.text)).toContain('I can reproduce it.')

    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Button', key: 'acme/backend#42' })).toBeDefined()
    await ui.unmount()
  }
})

test('a folder with no repository says so', async ($, on) => {
  const { lists } = engine(on, { disk: [dir('docs'), file('todo.txt')], remotes: {} })
  const ui = await mount($, 'terminal')
  expect(
    await ui.find({ type: 'Text', text: 'No git repository here or just below', in: 'issues' }),
  ).toBeDefined()
  expect(lists).toEqual([])
  await ui.unmount()
})

for (const [where, setup, expected] of [
  ['a folder of projects', {}, ['issues']],
  ['a folder with none', { disk: [dir('docs')], remotes: {} }, []],
] as const) {
  test(`the pane opens by itself in ${where} only where there are issues`, async ($, on) => {
    const opened: string[] = []
    const { clock } = engine(on, setup)
    on('command.register', () => ({ value: { command: 'issues' } }))
    on('ui.open', (_, e) => {
      opened.push(e.id)

      return { value: { isPlaced: true } }
    })
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(opened).toEqual([...expected])
  })
}

test('an issue an earlier version kept open is declined', async ($, on) => {
  engine(on)
  // What the code before the `opened-1` tag stored stays through a reload.
  on('state.get', { key: 'opened' }, () => ({
    value: { value: { repo: 'acme/backend', number: 42 }, version: 1 },
  }))
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /NORMAL/, in: 'issues' })).toBeDefined()
  await ui.unmount()
})
