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

/** Stands for the engine beneath the mod: the disk above, git, the prompt. */
function engine(on: On, gitStatus = '') {
  const listed: string[] = []
  const filled: string[] = []
  on('session.cwd', () => ({ value: 'C:\\Users\\dev\\skills-and-agents' }))
  // The engine hands this hook the path resolved under its working directory,
  // which a test runs in the plugin's own folder.
  on('fs.list', (_, e) => {
    const path = e.path.replace(/\\/g, '/').replace(/^.*\/nvim-explorer(\/|$)/, '')
    listed.push(path)

    return { value: DISK[path] ?? [] }
  })
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv[1] === 'rev-parse' ? '\n' : gitStatus,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })

  return { listed, filled }
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
  engine(on, ' M agents/relatorio-semanal.md\0?? notes.txt\0!! .env\0')
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
  engine(on, ' R notes.md\0README.md\0 M agents/relatorio-semanal.md\0')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.key({ key: 'l', in: 'tree' })

  expect(await ui.find({ type: 'Text', text: ' ✗', in: 'tree' })).toBeDefined()
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
