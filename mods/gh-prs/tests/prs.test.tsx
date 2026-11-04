import { expect, mock, test } from 'claude-code/testing'
import type { Mounted, TestBody } from 'claude-code/testing'
import type { FsEntry } from 'claude-code'

const PANE = {
  plugin: 'gh-prs',
  component: 'Pane',
  requestId: 'prs',
  props: {
    title: 'PRs',
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

type Pr = {
  number: number
  title: string
  state?: string
  isDraft?: boolean
  updatedAt?: string
  statusCheckRollup?: unknown[]
}

const run = (name: string, conclusion: string, status = 'COMPLETED') => ({
  __typename: 'CheckRun',
  name,
  workflowName: 'CI',
  status,
  conclusion: status === 'COMPLETED' ? conclusion : '',
})

const BACKEND: Pr[] = [
  {
    number: 42,
    title: 'Fix login on Safari',
    updatedAt: '2026-11-01T12:00:00Z',
    statusCheckRollup: [run('build', 'FAILURE'), run('lint', 'SUCCESS')],
  },
  { number: 12, title: 'Bump deps', isDraft: true, updatedAt: '2026-10-13T12:00:00Z', statusCheckRollup: [] },
]
const FRONTEND: Pr[] = [
  { number: 7, title: 'Dark mode', updatedAt: '2026-11-03T09:00:00Z', statusCheckRollup: [run('test', 'SUCCESS')] },
]
const RUNNING: Pr = {
  number: 50,
  title: 'Cache sessions',
  updatedAt: '2026-11-03T11:00:00Z',
  statusCheckRollup: [run('build', '', 'IN_PROGRESS')],
}

const VIEW_42 = {
  number: 42,
  title: 'Fix login on Safari',
  state: 'OPEN',
  isDraft: false,
  author: { login: 'alice' },
  createdAt: '2026-10-30T12:00:00Z',
  url: 'https://github.com/acme/backend/pull/42',
  labels: [{ name: 'bug' }],
  assignees: [],
  reviewRequests: [{ __typename: 'User', login: 'carol' }],
  reviews: [
    { author: { login: 'bob' }, state: 'CHANGES_REQUESTED', body: 'Please add a test.', submittedAt: '2026-11-02T12:00:00Z' },
    { author: { login: 'erin' }, state: 'PENDING', body: 'draft', submittedAt: '' },
  ],
  comments: [{ author: { login: 'dave' }, createdAt: '2026-11-01T12:00:00Z', body: 'Works for me.' }],
  baseRefName: 'main',
  headRefName: 'fix/safari-login',
  additions: 12,
  deletions: 3,
  changedFiles: 2,
  mergeable: 'MERGEABLE',
  reviewDecision: 'CHANGES_REQUESTED',
  statusCheckRollup: [run('build', 'FAILURE'), run('lint', 'SUCCESS')],
  body: '## Why\r\nSafari drops the cookie',
}

const DIFF_42 = [
  'diff --git a/src/login.ts b/src/login.ts',
  'index 1111111..2222222 100644',
  '--- a/src/login.ts',
  '+++ b/src/login.ts',
  '@@ -1,3 +1,4 @@',
  " import { cookie } from './cookie'",
  "-const sameSite = 'none'",
  "+const sameSite = 'lax'",
  '+const secure = true',
  ' export { sameSite }',
  'diff --git a/docs/old.md b/docs/new.md',
  'similarity index 100%',
  'rename from docs/old.md',
  'rename to docs/new.md',
  '',
].join('\n')

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
  /** `gh pr list` per repository. */
  prs?: Record<string, Pr[]>
  /** `gh pr view` per `owner/repo#n`. */
  views?: Record<string, unknown>
  /** `gh pr diff` per `owner/repo#n`, and whether its output was cut. */
  diffs?: Record<string, { text: string; isCut?: boolean }>
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
    prs = { 'acme/backend': BACKEND, 'acme/web': FRONTEND },
    views = { 'acme/backend#42': VIEW_42 },
    diffs = { 'acme/backend#42': { text: DIFF_42 } },
    failing = {},
  } = setup
  const lists: string[][] = []
  const viewed: string[] = []
  const diffed: string[] = []
  const browsed: string[] = []
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
    const ok = (stdout: string, isStdoutTruncated = false) => ({
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated, isStderrTruncated: false },
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

      return ok(JSON.stringify((prs[repo] ?? []).map(pr => ({ state: 'OPEN', isDraft: false, ...pr }))))
    }
    if (argv[0] === 'gh' && argv[2] === 'view' && argv.includes('--web')) {
      browsed.push(`${repo}#${argv[3]}`)

      return ok('')
    }
    if (argv[0] === 'gh' && argv[2] === 'view') {
      viewed.push(`${repo}#${argv[3]}`)

      return ok(JSON.stringify(views[`${repo}#${argv[3]}`] ?? {}))
    }
    if (argv[0] === 'gh' && argv[2] === 'diff') {
      diffed.push(`${repo}#${argv[3]}`)
      const diff = diffs[`${repo}#${argv[3]}`]

      return ok(diff?.text ?? '', diff?.isCut ?? false)
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
        : [{ id: 'prs', title: 'PRs', isShown: true, isFocused: false, isPlaced: drawn.pane === 'placed' }],
  }))
  // The engine's own band above the prompt, drawn where the mod passes.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine band</Text>
  })

  return { clock, lists, viewed, diffed, browsed, remoteIn, submitted, filled, spawned, copied, drawn }
}

function mount<S extends 'terminal' | 'desktop' | 'vscode' | 'mobile'>($: Engine, surface: S) {
  return $.ui.mount({ ...PANE, surface })
}

const BAND = {
  plugin: 'gh-prs',
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

/** Starts the session as the engine does, so its clock and command are set. */
async function start($: Engine, on: On): Promise<string[]> {
  const opened: string[] = []
  on('command.register', () => ({ value: { command: 'prs' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  return opened
}

test('a folder of two projects lists the pull requests of each, with their checks', async ($, on) => {
  const { lists, remoteIn } = engine(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, surface)
    expect(await ui.find({ type: 'Text', text: /^backend$/, in: 'prs' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^frontend$/, in: 'prs' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Fix login on Safari/, in: 'prs' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Dark mode/, in: 'prs' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' ✗', in: 'prs' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' ✓', in: 'prs' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' 2d', in: 'prs' })).toBeDefined()
    // A draft's number is drawn quiet, an open one's green.
    expect((await ui.find({ type: 'Text', text: /^#12 $/, in: 'prs' }))?.props.color).toBe('#737aa2')
    expect((await ui.find({ type: 'Text', text: /^#7 $/, in: 'prs' }))?.props.color).toBe('#9ece6a')
    // The root is no repository: only its two projects were asked.
    expect(new Set(remoteIn)).toEqual(new Set(['backend', 'frontend']))
    await ui.unmount()
  }
  expect(new Set(lists.map(argv => argv[argv.indexOf('--repo') + 1]))).toEqual(
    new Set(['acme/backend', 'acme/web']),
  )
  expect(lists[0]).toEqual(expect.arrayContaining(['--state', 'open']))
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
  expect(await ui.find({ type: 'Text', text: /^scripts$/, in: 'prs' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /no GitHub remote/, in: 'prs' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^backend-copy$/, in: 'prs' })).toBeUndefined()
  expect(lists.map(argv => argv[argv.indexOf('--repo') + 1])).toEqual(['acme/backend'])
  await ui.unmount()
})

test('Enter shows a pull request in the sheet above the prompt, x puts it away', async ($, on) => {
  const { viewed } = engine(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, surface)
    const band = await sheet($, surface)
    expect(await band.find({ type: 'Text', text: 'engine band' })).toBeDefined()

    await ui.key({ key: 'j', in: 'prs' })
    await ui.key({ key: 'return', in: 'prs' })
    const text = (await sheetText(band)) ?? ''
    expect(text).toContain('## Fix login on Safari · acme/backend#42')
    expect(text).toContain('**Open** · @alice opened 4d ago · `fix/safari-login` → `main`')
    expect(text).toContain('+12 −3 in 2 files · **Changes requested**')
    expect(text).toContain('`bug` · review asked of @carol')
    expect(text).toContain('**Checks** · ✗ 1 failing · ✓ 1 passed\n\n- ✗ `CI / build`')
    // Windows line ends from GitHub leave no `\r` behind.
    expect(text).toContain('## Why\nSafari drops the cookie')
    // The comment and the review in the order they came; a pending review is
    // its author's draft and stays out.
    expect(text.indexOf('**@dave** · 2d ago\n\nWorks for me.')).toBeGreaterThan(0)
    expect(text.indexOf('**@bob** requested changes · 1d ago\n\nPlease add a test.')).toBeGreaterThan(
      text.indexOf('**@dave**'),
    )
    expect(text).not.toContain('erin')
    // A line parts the sheet from the chat; each action is its key in brackets.
    expect(await band.find({ type: 'Text', text: /^── acme\/backend#42 ─+$/ })).toBeDefined()
    expect((await band.find({ type: 'Button', key: 'sheet-review' }))?.text).toBe('c')
    expect(await band.find({ type: 'Text', text: ' Review' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: ' Diff' })).toBeDefined()
    // The pane stays the list, its cursor where it was, the pull request marked.
    expect((await ui.find({ type: 'Text', text: '#42 ', in: 'prs' }))?.props.backgroundColor).toBe(CURSOR)
    expect(await ui.find({ type: 'Text', text: ' ◆', in: 'prs' })).toBeDefined()

    await ui.key({ key: 'x', in: 'prs' })
    expect(await sheetText(band)).toBeUndefined()
    expect(await band.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' ◆', in: 'prs' })).toBeUndefined()

    // Enter on the shown pull request puts it away too, and q does before it closes the pane.
    await ui.key({ key: 'return', in: 'prs' })
    expect(await sheetText(band)).toBeDefined()
    await ui.key({ key: 'return', in: 'prs' })
    expect(await sheetText(band)).toBeUndefined()
    await ui.key({ key: 'return', in: 'prs' })
    await ui.key({ key: 'q', in: 'prs' })
    expect(await sheetText(band)).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /NORMAL/, in: 'prs' })).toBeDefined()
    await band.unmount()
    await ui.unmount()
  }
  expect(viewed).toContain('acme/backend#42')
})

test('d shows the changed files as diffs, and turns back to the conversation', async ($, on) => {
  const { diffed } = engine(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, surface)
    const band = await sheet($, surface)
    await ui.key({ key: 'j', in: 'prs' })

    // From the list, d opens the pull request on its files.
    await ui.key({ key: 'd', in: 'prs' })
    expect(await sheetText(band)).toBeUndefined()
    expect(await band.find({ type: 'Text', text: '2 files changed' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '  +2' })).toBeDefined()
    const code = await band.find({ type: 'Code' })
    expect(code?.props.format).toBe('diff')
    expect(code?.props.path).toBe('src/login.ts')
    expect(String(code?.props.source)).toBe(
      "@@ -1,3 +1,4 @@\n import { cookie } from './cookie'\n-const sameSite = 'none'\n+const sameSite = 'lax'\n+const secure = true\n export { sameSite }",
    )
    // A rename alone has no hunks: its name says what became of it.
    expect(await band.find({ type: 'Text', text: 'docs/new.md' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: ' ← docs/old.md' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '  renamed' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: ' Conversation' })).toBeDefined()

    // d again, from the list or the sheet, turns between the two.
    await ui.key({ key: 'd', in: 'prs' })
    expect(await sheetText(band)).toContain('## Fix login on Safari')
    await band.press({ key: 'sheet-diff' })
    expect(await band.find({ type: 'Code' })).toBeDefined()
    // Opening a pull request shows its conversation first.
    await ui.key({ key: 'return', in: 'prs' })
    await ui.key({ key: 'l', in: 'prs' })
    expect(await sheetText(band)).toContain('## Fix login on Safari')
    await ui.key({ key: 'x', in: 'prs' })
    await band.unmount()
    await ui.unmount()
  }
  expect(diffed).toContain('acme/backend#42')
})

test('a long diff leaves out what does not fit, and a cut one says so', async ($, on) => {
  const big = [
    'diff --git a/big.txt b/big.txt',
    '--- a/big.txt',
    '+++ b/big.txt',
    '@@ -0,0 +1,7000 @@',
    ...Array.from({ length: 7000 }, (_, i) => `+line ${i} of a file that is far too long to show here`),
  ].join('\n')
  const small = DIFF_42.split('diff --git a/docs')[0] ?? ''
  const partial = 'diff --git a/last.ts b/last.ts\n--- a/last.ts\n+++ b/last.ts\n@@ -1,9 +1,9 @@\n-a'
  engine(on, {
    diffs: { 'acme/backend#42': { text: `${big}\n${small}${partial}`, isCut: true } },
  })
  const ui = await mount($, 'terminal')
  const band = await sheet($, 'terminal')
  await ui.key({ key: 'j', in: 'prs' })
  await ui.key({ key: 'd', in: 'prs' })
  expect(await band.find({ type: 'Text', text: 'big.txt' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^Too long to show here/ })).toBeDefined()
  // The smaller file after it still fits; the one gh's cut answer ends in is dropped.
  expect((await band.find({ type: 'Code' }))?.props.path).toBe('src/login.ts')
  expect(await band.find({ type: 'Text', text: 'last.ts' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /^The diff is cut short here/ })).toBeDefined()
  await band.unmount()
  await ui.unmount()
})

test('the sheet’s buttons ask for a review or a fix, fill the prompt, start an agent and close', async ($, on) => {
  const { submitted, filled, spawned, browsed } = engine(on)
  const ui = await mount($, 'terminal')
  const band = await sheet($, 'terminal')
  await ui.key({ key: 'j', in: 'prs' })
  await ui.key({ key: 'return', in: 'prs' })

  await band.press({ key: 'sheet-review' })
  expect(submitted.at(-1)).toContain('Review GitHub pull request acme/backend#42.')
  await band.press({ key: 'sheet-fix' })
  expect(submitted.at(-1)).toContain('Address the review feedback and the failing checks on GitHub pull request acme/backend#42.')
  await band.press({ key: 'sheet-fill' })
  expect(filled.at(-1)).toContain('gh pr view 42 --repo acme/backend --comments')
  await band.press({ key: 'sheet-agent' })
  expect(spawned.at(-1)?.cwd).toBe(`${ROOT}\\backend`)
  await band.press({ key: 'sheet-browse' })
  expect(browsed).toEqual(['acme/backend#42'])

  await band.press({ key: 'sheet-close' })
  expect(await sheetText(band)).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: ' ◆', in: 'prs' })).toBeUndefined()
  await band.unmount()
  await ui.unmount()
})

for (const pane of ['unplaced', 'closed'] as const) {
  test(`an open pull request draws no sheet while the pane is ${pane}`, async ($, on) => {
    const { drawn } = engine(on)
    on('ui.open', () => {
      drawn.pane = 'placed'

      return { value: { isPlaced: true } }
    })
    const ui = await mount($, 'terminal')
    const band = await sheet($, 'terminal')
    await ui.key({ key: 'j', in: 'prs' })
    await ui.key({ key: 'return', in: 'prs' })
    expect(await sheetText(band)).toBeDefined()

    // The pull request stays open, as a resumed session keeps it, but the list is gone.
    drawn.pane = pane
    await ui.key({ key: 'R', in: 'prs' })
    expect(await sheetText(band)).toBeUndefined()
    expect(await band.find({ type: 'Text', text: 'engine band' })).toBeDefined()

    // Drawn again, the pane brings its sheet back: placed as the terminal
    // widens, which draws the band again, or opened again with /prs.
    if (pane === 'unplaced') {
      drawn.pane = 'placed'
      await band.redraw({ ...BAND.props, bodyColumns: 120 })
    } else {
      await $.command.run({
        command: 'prs',
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

test('c asks Claude for a review, f for a fix, i fills the prompt, a starts a reviewing subagent', async ($, on) => {
  const { submitted, filled, spawned } = engine(on)
  const ui = await mount($, 'terminal')
  await ui.key({ key: 'j', in: 'prs' })

  await ui.key({ key: 'c', in: 'prs' })
  const review = submitted.at(-1) ?? ''
  expect(review).toContain('Review GitHub pull request acme/backend#42.')
  expect(review).toContain(`The project's code is at backend/ (${ROOT}\\backend)`)
  expect(review).toContain('gh pr view 42 --repo acme/backend --comments')
  expect(review).toContain('gh pr diff 42 --repo acme/backend')
  expect(review).toContain('gh pr checks 42 --repo acme/backend')
  expect(review).toContain('do not check out its branch')

  await ui.key({ key: 'f', in: 'prs' })
  const fix = submitted.at(-1) ?? ''
  expect(fix).toContain('gh pr checkout 42 --repo acme/backend')
  expect(fix).toContain('gh api repos/acme/backend/pulls/42/comments')
  expect(fix).toContain('do not push or reply on GitHub until I say so')

  // The pull request's own text, title and branch included, reaches Claude
  // through gh, not as the person's words: whoever opened it wrote it.
  for (const sent of [review, fix]) {
    expect(sent).not.toContain('Fix login on Safari')
    expect(sent).not.toContain('Safari drops the cookie')
    expect(sent).not.toContain('fix/safari-login')
  }

  await ui.key({ key: 'i', in: 'prs' })
  expect(filled.at(-1)).toContain('GitHub pull request acme/backend#42, in the project at backend/')
  expect(filled.at(-1)?.endsWith('\n')).toBe(true)

  await ui.key({ key: 'a', in: 'prs' })
  expect(spawned.at(-1)?.cwd).toBe(`${ROOT}\\backend`)
  expect(spawned.at(-1)?.description).toBe('Review acme/backend#42')
  expect(spawned.at(-1)?.prompt).toContain('the folder you are in')
  expect(spawned.at(-1)?.prompt).toContain('do not check out its branch or edit files')
  await ui.unmount()
})

test('@ mentions the pull request and y Y copy its number and address', async ($, on) => {
  const { filled, copied } = engine(on)
  const ui = await mount($, 'terminal')
  await ui.key({ key: 'j', in: 'prs' })
  await ui.key({ key: '@', in: 'prs' })
  expect(filled.at(-1)).toBe('acme/backend#42 ')
  await ui.key({ key: 'y', in: 'prs' })
  await ui.key({ key: 'Y', in: 'prs' })
  expect(copied).toEqual(['#42', 'https://github.com/acme/backend/pull/42'])
  await ui.unmount()
})

test('s cycles the state and m lists all, mine, then those waiting on my review', async ($, on) => {
  const { lists } = engine(on)
  const ui = await mount($, 'terminal')
  await ui.key({ key: 's', in: 'prs' })
  expect(lists.at(-1)).toEqual(expect.arrayContaining(['--state', 'merged']))
  expect(await ui.find({ type: 'Text', text: / merged /, in: 'prs' })).toBeDefined()

  await ui.key({ key: 'm', in: 'prs' })
  expect(lists.at(-1)).toEqual(expect.arrayContaining(['--author', '@me']))
  expect(await ui.find({ type: 'Text', text: / merged @me /, in: 'prs' })).toBeDefined()
  await ui.key({ key: 'm', in: 'prs' })
  expect(lists.at(-1)).toEqual(expect.arrayContaining(['--search', 'review-requested:@me']))
  expect(lists.at(-1)).not.toContain('--author')
  expect(await ui.find({ type: 'Text', text: / merged review /, in: 'prs' })).toBeDefined()
  // Back to everyone's, read from what the first s already asked.
  const asked = lists.length
  await ui.key({ key: 'm', in: 'prs' })
  expect(await ui.find({ type: 'Text', text: / merged All /, in: 'prs' })).toBeDefined()
  expect(lists.length).toBe(asked)
  await ui.unmount()
})

test('/ types a search on the bottom line, Enter lists by it', async ($, on) => {
  const { lists } = engine(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, surface)
    await ui.key({ key: '/', in: 'prs' })
    // Every key is typed, the ones the list takes for itself (g, d, q) too.
    for (const typed of 'label:bug draft:false') {
      await ui.key({ key: typed === ' ' ? 'space' : typed, in: 'prs' })
    }
    expect(await ui.find({ type: 'Text', text: '/label:bug draft:false', in: 'prs' })).toBeDefined()
    await ui.key({ key: 'backspace', in: 'prs' })
    await ui.key({ key: 'e', in: 'prs' })
    await ui.key({ key: 'return', in: 'prs' })

    expect(lists.at(-1)).toEqual(expect.arrayContaining(['--search', 'label:bug draft:false']))
    expect(await ui.find({ type: 'Text', text: '  /label:bug draft:false', in: 'prs' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /NORMAL/, in: 'prs' })).toBeDefined()

    // Ctrl-u clears the line, and an empty search lists everything again.
    await ui.key({ key: '/', in: 'prs' })
    await ui.key({ key: 'u', ctrl: true, in: 'prs' })
    await ui.key({ key: 'return', in: 'prs' })
    expect(await ui.find({ type: 'Text', text: /^ {2}\//, in: 'prs' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Dark mode/, in: 'prs' })).toBeDefined()

    // Backspace on an empty line puts it away, searching nothing.
    const asked = lists.length
    await ui.key({ key: '/', in: 'prs' })
    await ui.key({ key: 'backspace', in: 'prs' })
    expect(await ui.find({ type: 'Text', text: /NORMAL/, in: 'prs' })).toBeDefined()
    expect(lists.length).toBe(asked)
    await ui.unmount()
  }
})

test('a search waiting on my review keeps the search typed', async ($, on) => {
  const { lists } = engine(on)
  const ui = await mount($, 'terminal')
  await ui.post({ op: 'query', text: 'label:bug' }, { in: 'prs' })
  await ui.key({ key: 'm', in: 'prs' })
  await ui.key({ key: 'm', in: 'prs' })
  expect(lists.at(-1)).toEqual(expect.arrayContaining(['--search', 'review-requested:@me label:bug']))
  await ui.unmount()
})

test('/prs with a search opens the pane on it', async ($, on) => {
  const { lists } = engine(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run({
    command: 'prs',
    args: '  label:bug \n is:open ',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  const ui = await mount($, 'terminal')
  expect(lists.at(-1)).toEqual(expect.arrayContaining(['--search', 'label:bug is:open']))
  expect(await ui.find({ type: 'Text', text: '  /label:bug is:open', in: 'prs' })).toBeDefined()
  await ui.unmount()
})

test('a posted search is one line, cut to what GitHub takes', async ($, on) => {
  const { lists } = engine(on)
  const ui = await mount($, 'terminal')
  await ui.post({ op: 'query', text: `label:bug\u0007\n${'x'.repeat(400)}` }, { in: 'prs' })
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
  expect(await ui.find({ type: 'Text', text: 'Not signed in: run gh auth login', in: 'prs' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' !', in: 'prs' })).toBeDefined()
  // The other project is drawn as ever.
  expect(await ui.find({ type: 'Text', text: /^Fix login on Safari/, in: 'prs' })).toBeDefined()
  await ui.unmount()
})

test('a pull request command or a push Claude runs reads GitHub again', async ($, on) => {
  const { lists } = engine(on)
  on('tool.call', () => ({ result: {} }))
  const ui = await mount($, 'terminal')
  for (const command of ['gh pr merge 42 --repo acme/backend --squash', 'git -C backend push origin fix']) {
    const before = lists.length
    await $.tool.call({ tool: 'Bash', command })
    await ui.find({ type: 'Text', text: /^backend$/, in: 'prs' })
    expect(lists.length).toBeGreaterThan(before)
  }

  // A read, as Claude runs for every pull request the pane hands it, reads nothing again.
  const after = lists.length
  await $.tool.call({ tool: 'Bash', command: 'gh pr view 42 --repo acme/backend --comments' })
  await $.tool.call({ tool: 'PowerShell', command: 'gh pr diff 42 --repo acme/backend' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr checkout 42 --repo acme/backend' })
  await ui.find({ type: 'Text', text: /^backend$/, in: 'prs' })
  expect(lists.length).toBe(after)
  await ui.unmount()
})

test('the clock reads GitHub again sooner while a listed pull request’s checks run', async ($, on) => {
  const { lists, clock } = engine(on, {
    prs: { 'acme/backend': [...BACKEND, RUNNING], 'acme/web': FRONTEND },
  })
  await start($, on)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: ' ●', in: 'prs' })).toBeDefined()
  const before = lists.length
  await clock.advance(60_000)
  await ui.find({ type: 'Text', text: /^backend$/, in: 'prs' })
  expect(lists.length).toBe(before)
  await clock.advance(60_000)
  await ui.find({ type: 'Text', text: /^backend$/, in: 'prs' })
  expect(lists.length).toBeGreaterThan(before)
  await ui.unmount()
})

test('with no checks running, the clock waits five minutes', async ($, on) => {
  const { lists, clock } = engine(on)
  await start($, on)
  const ui = await mount($, 'terminal')
  await ui.find({ type: 'Text', text: /^backend$/, in: 'prs' })
  const before = lists.length
  await clock.advance(240_000)
  await ui.find({ type: 'Text', text: /^backend$/, in: 'prs' })
  expect(lists.length).toBe(before)
  await clock.advance(60_000)
  await ui.find({ type: 'Text', text: /^backend$/, in: 'prs' })
  expect(lists.length).toBeGreaterThan(before)
  await ui.unmount()
})

test('Backspace on a project closes it, Enter opens and closes it', async ($, on) => {
  engine(on)
  const ui = await mount($, 'terminal')
  // The cursor starts on backend, the first project.
  await ui.key({ key: 'backspace', in: 'prs' })
  expect(await ui.find({ type: 'Text', text: /^Fix login on Safari/, in: 'prs' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Dark mode/, in: 'prs' })).toBeDefined()

  await ui.key({ key: 'return', in: 'prs' })
  expect(await ui.find({ type: 'Text', text: /^Fix login on Safari/, in: 'prs' })).toBeDefined()
  await ui.key({ key: 'return', in: 'prs' })
  expect(await ui.find({ type: 'Text', text: /^Fix login on Safari/, in: 'prs' })).toBeUndefined()
  await ui.unmount()
})

test('a post for a repository or folder not found runs nothing', async ($, on) => {
  const { viewed, diffed, spawned, submitted } = engine(on)
  const ui = await mount($, 'terminal')
  await ui.post({ op: 'agent', repo: 'evil/repo', number: 1 }, { in: 'prs' })
  await ui.post({ op: 'fix', repo: 'acme/backend', number: 1.5 }, { in: 'prs' })
  await ui.post({ op: 'open', repo: '../acme', number: 42 }, { in: 'prs' })
  await ui.post({ op: 'diff', repo: 'acme/backend', number: -1 }, { in: 'prs' })
  await ui.post({ op: 'toggle', dir: '../outside' }, { in: 'prs' })

  expect(spawned).toEqual([])
  expect(submitted).toEqual([])
  expect(viewed).toEqual([])
  expect(diffed).toEqual([])
  expect(await ui.find({ type: 'Text', text: /^Fix login on Safari/, in: 'prs' })).toBeDefined()
  await ui.unmount()
})

test('without a Client the rows are buttons and the pull request is Markdown and diffs', async ($, on) => {
  engine(on)
  for (const surface of ['vscode', 'mobile'] as const) {
    const ui = await mount($, surface)
    expect(await ui.find({ type: 'Button', key: 'acme/backend#42' })).toBeDefined()

    await ui.press({ key: 'p:backend' })
    expect(await ui.find({ type: 'Button', key: 'acme/backend#42' })).toBeUndefined()
    await ui.press({ key: 'p:backend' })

    await ui.press({ key: 'acme/backend#42' })
    const markdown = await ui.find({ type: 'Markdown' })
    expect(String(markdown?.props.text)).toContain('## Fix login on Safari · acme/backend#42')
    expect(String(markdown?.props.text)).toContain('Please add a test.')

    await ui.press({ key: 'diff' })
    expect((await ui.find({ type: 'Code' }))?.props.path).toBe('src/login.ts')
    await ui.press({ key: 'diff' })
    expect(await ui.find({ type: 'Markdown' })).toBeDefined()

    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Button', key: 'acme/backend#42' })).toBeDefined()
    await ui.unmount()
  }
})

test('a folder with no repository says so', async ($, on) => {
  const { lists } = engine(on, { disk: [dir('docs'), file('todo.txt')], remotes: {} })
  const ui = await mount($, 'terminal')
  expect(
    await ui.find({ type: 'Text', text: 'No git repository here or just below', in: 'prs' }),
  ).toBeDefined()
  expect(lists).toEqual([])
  await ui.unmount()
})

for (const [where, setup, expected] of [
  ['a folder of projects', {}, ['prs']],
  ['a folder with none', { disk: [dir('docs')], remotes: {} }, []],
] as const) {
  test(`the pane opens by itself in ${where} only where there are pull requests`, async ($, on) => {
    const { clock } = engine(on, setup)
    const opened = await start($, on)
    await clock.settle()
    expect(opened).toEqual([...expected])
  })
}

test('a pull request an earlier version kept open is declined', async ($, on) => {
  engine(on)
  // What the code before the `opened-1` tag stored stays through a reload.
  on('state.get', { key: 'opened' }, () => ({
    value: { value: { repo: 'acme/backend', number: 42 }, version: 1 },
  }))
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /NORMAL/, in: 'prs' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' ◆', in: 'prs' })).toBeUndefined()
  await ui.unmount()
})
