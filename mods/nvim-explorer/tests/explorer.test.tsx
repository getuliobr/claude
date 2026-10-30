import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { FsEntry } from 'claude-code'

const PANE = {
  plugin: 'nvim-explorer',
  component: 'Pane',
  requestId: 'explorer',
  props: {
    title: 'NvimTree',
    isFocused: false,
    bodyColumns: 32,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

const dir = (name: string): FsEntry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
const file = (name: string): FsEntry => ({ name, kind: 'file', size: 1, mtimeMs: 1, isLink: false })

// The disk the tests draw, by directory; '' is the session's own.
const DISK: Record<string, FsEntry[]> = {
  '': [file('README.md'), dir('skills'), dir('.git'), file('LICENSE'), dir('agents'), file('.env')],
  agents: [file('relatorio-semanal.md')],
  skills: [dir('editable-diagrams')],
  'skills/editable-diagrams': [],
}

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const ROOT = 'C:\\Users\\dev\\skills-and-agents'

// The engine hands the fs hooks a path resolved under its working directory,
// which a test runs in the plugin's own folder: this is the part under ROOT.
function inTree(path: string): string {
  return path.replace(/\\/g, '/').replace(/^.*\/skills-and-agents(\/|$)/, '')
}

type Setup = {
  /** `git status` output by repository folder, '' for the root's. */
  repos?: Record<string, string>
  cwd?: string
  disk?: Record<string, FsEntry[]>
}

/** Stands for the engine beneath the mod: the disk above, git, the prompt. */
function engine(on: On, { repos = { '': '' }, cwd = ROOT, disk = DISK }: Setup = {}) {
  const listed: string[] = []
  const filled: string[] = []
  const gitIn: string[] = []
  on('session.cwd', () => ({ value: cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('fs.list', (_, e) => {
    const path = inTree(e.path)
    listed.push(path)

    return { value: disk[path] ?? [] }
  })
  on('fs.exists', (_, e) => {
    const path = inTree(e.path)

    return { value: path.endsWith('/.git') && path.slice(0, -'/.git'.length) in repos }
  })
  on('process.run', (_, e) => {
    const dir = inTree(e.init?.cwd ?? ROOT)
    if (e.argv.includes('status')) gitIn.push(dir)
    const status = repos[dir]

    return {
      value: {
        exitCode: status === undefined ? 128 : 0,
        stdout: status === undefined ? '' : e.argv[1] === 'rev-parse' ? '\n' : status,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })

  return { listed, filled, gitIn }
}

async function mountTexts($: Engine, surface: 'terminal' | 'desktop') {
  const ui = await $.ui.mount({ ...PANE, surface })
  const texts = await ui.findAll({ type: 'Text', in: 'tree' })

  return { ui, texts: texts.map(text => text.text) }
}

test('folders come first, .git never shows, the cursor starts on top', async ($, on) => {
  engine(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const { ui, texts } = await mountTexts($, surface)
    const names = texts.filter(text =>
      ['agents', 'skills', '.env', 'LICENSE', 'README.md', '.git'].includes(text),
    )
    expect(names).toEqual(['agents', 'skills', '.env', 'LICENSE', 'README.md'])
    expect((await ui.find({ type: 'Text', text: /^agents$/, in: 'tree' }))?.props.backgroundColor).toBe(
      '#292e42',
    )
    expect(await ui.find({ type: 'Text', text: /^skills-and-agents$/, in: 'tree' })).toBeDefined()
    await ui.unmount()
  }
})

test('l opens a folder, j walks into it, Enter @mentions a file', async ($, on) => {
  const { filled } = engine(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'relatorio-semanal.md', in: 'tree' })).toBeUndefined()

    await ui.key({ key: 'l', in: 'tree' })
    expect(await ui.find({ type: 'Text', text: 'relatorio-semanal.md', in: 'tree' })).toBeDefined()

    await ui.key({ key: 'j', in: 'tree' })
    await ui.key({ key: 'return', in: 'tree' })
    expect(filled.at(-1)).toBe('@agents/relatorio-semanal.md ')

    // h on a file goes to its folder, h again closes it.
    await ui.key({ key: 'h', in: 'tree' })
    await ui.key({ key: 'h', in: 'tree' })
    expect(await ui.find({ type: 'Text', text: 'relatorio-semanal.md', in: 'tree' })).toBeUndefined()
    await ui.unmount()
  }
})

test('G goes to the bottom and the bar says where', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.key({ key: 'G', in: 'tree' })
  expect((await ui.find({ type: 'Text', text: 'README.md', in: 'tree' }))?.props.backgroundColor).toBe(
    '#292e42',
  )
  expect(await ui.find({ type: 'Text', text: /All 5:5 $/, in: 'tree' })).toBeDefined()
  await ui.unmount()
})

test('H hides dotfiles and ? shows the keys', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.key({ key: 'H', in: 'tree' })
  expect(await ui.find({ type: 'Text', text: '.env', in: 'tree' })).toBeUndefined()

  await ui.key({ key: '?', in: 'tree' })
  expect(await ui.find({ type: 'Text', text: 'down / up', in: 'tree' })).toBeDefined()
  await ui.key({ key: 'x', in: 'tree' })
  expect(await ui.find({ type: 'Text', text: 'down / up', in: 'tree' })).toBeUndefined()
  await ui.unmount()
})

test('git marks a changed file and the folders above it', async ($, on) => {
  engine(on, { repos: { '': ' M agents/relatorio-semanal.md\0?? notes.txt\0!! .env\0' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.key({ key: 'l', in: 'tree' })

  expect(await ui.find({ type: 'Text', text: ' ✗', in: 'tree' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' ●', in: 'tree' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^\.env$/, in: 'tree' }))?.props.color).toBe('#545c7e')

  await ui.key({ key: 'I', in: 'tree' })
  expect(await ui.find({ type: 'Text', text: '.env', in: 'tree' })).toBeUndefined()
  await ui.unmount()
})

test('an unstaged rename skips the path it came from', async ($, on) => {
  // Read as an entry of its own, `README.md` would swallow the change after it.
  engine(on, { repos: { '': ' R notes.md\0README.md\0 M agents/relatorio-semanal.md\0' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.key({ key: 'l', in: 'tree' })

  expect(await ui.find({ type: 'Text', text: ' ✗', in: 'tree' })).toBeDefined()
  await ui.unmount()
})

test('the tree stays at the root after a cd, and mentions spell the path whole', async ($, on) => {
  const { filled } = engine(on, { cwd: `${ROOT}\\agents` })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^skills-and-agents$/, in: 'tree' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^skills$/, in: 'tree' })).toBeDefined()

  await ui.key({ key: 'l', in: 'tree' })
  await ui.key({ key: 'j', in: 'tree' })
  await ui.key({ key: 'return', in: 'tree' })
  expect(filled.at(-1)).toBe(`@${ROOT}\\agents\\relatorio-semanal.md `)
  await ui.unmount()
})

test('a folder of projects reads git in each project, not above them', async ($, on) => {
  const { gitIn } = engine(on, {
    repos: { agents: ' M relatorio-semanal.md\0', skills: '' },
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The root is no repository: agents holds a change, skills none.
  expect(await ui.find({ type: 'Text', text: ' ●', in: 'tree' })).toBeDefined()
  await ui.key({ key: 'l', in: 'tree' })
  expect(await ui.find({ type: 'Text', text: ' ✗', in: 'tree' })).toBeDefined()
  expect(new Set(gitIn)).toEqual(new Set(['agents', 'skills']))
  await ui.unmount()
})

test('past eight projects the rest go unread', async ($, on) => {
  const names = Array.from({ length: 20 }, (_, i) => `p${String(i).padStart(2, '0')}`)
  const { gitIn } = engine(on, {
    repos: Object.fromEntries(names.map(name => [name, ' M a.ts\0'])),
    // Listed backwards: the projects drawn on top are still the ones read.
    disk: { '': [...names].reverse().map(dir) },
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^p00$/, in: 'tree' })).toBeDefined()
  // Asking whether the root is a repository took the eighth.
  expect(new Set(gitIn)).toEqual(new Set(names.slice(0, 7)))
  await ui.unmount()
})

test('a path that climbs out of the session is not listed', async ($, on) => {
  const { listed } = engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.post({ op: 'toggle', path: '../outside' }, { in: 'tree' })
  await ui.post({ op: 'toggle', path: 'C:/Windows' }, { in: 'tree' })

  // Anything listed outside the plugin's folder keeps its absolute spelling.
  expect(listed.length).toBeGreaterThan(0)
  expect(listed.some(path => /^([A-Za-z]:|\/)/.test(path))).toBe(false)
  await ui.unmount()
})

test('without a Client the rows are buttons that open folders', async ($, on) => {
  engine(on)
  for (const surface of ['vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Button', key: 'agents/relatorio-semanal.md' })).toBeUndefined()

    await ui.press({ key: 'agents' })
    expect(await ui.find({ type: 'Button', key: 'agents/relatorio-semanal.md' })).toBeDefined()
    await ui.press({ key: 'agents' })
    await ui.unmount()
  }
})

test('icons are plain arrows unless nerd is chosen', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '▸ ', in: 'tree' })).toBeDefined()
  await ui.unmount()
})

test('nerd draws nvim-tree folder glyphs', { options: { icons: 'nerd' } }, async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const closedFolder = `${String.fromCodePoint(0xe5ff)} `
  expect(await ui.find({ type: 'Text', text: closedFolder, in: 'tree' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▸ ', in: 'tree' })).toBeUndefined()
  await ui.unmount()
})

test('nerd marks agent instructions apart from markdown', { options: { icons: 'nerd' } }, async ($, on) => {
  engine(on, { disk: { ...DISK, '': [file('CLAUDE.md'), file('AGENTS.md'), file('README.md')] } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const glyph = (code: number): string => `${String.fromCodePoint(code)} `
  expect(await ui.find({ type: 'Text', text: glyph(0xec82), in: 'tree' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: glyph(0xf06a9), in: 'tree' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: glyph(0xe609), in: 'tree' })).toBeDefined()
  await ui.unmount()
})

test('folders an earlier version kept open are declined', async ($, on) => {
  engine(on)
  // What the code before the `expanded-1` tag stored stays through a reload.
  on('state.get', { key: 'expanded' }, () => ({
    value: { value: ['agents'], version: 1 },
  }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'relatorio-semanal.md', in: 'tree' })).toBeUndefined()
  await ui.unmount()
})
