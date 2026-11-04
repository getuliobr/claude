import { expect, test } from 'claude-code/testing'

import {
  checksOf,
  diffViewOf,
  markdownOf,
  parseDiff,
  parsePrView,
  reasonOf,
  statusOf,
  summaryOf,
} from '../hooks/github'
import type { RawDetail } from '../hooks/github'

const NOW = Date.parse('2026-11-03T12:00:00Z')

test('a pull request’s state reads as GitHub’s icon draws it', () => {
  expect(statusOf('OPEN', false)).toBe('open')
  expect(statusOf('OPEN', true)).toBe('draft')
  expect(statusOf('MERGED', false)).toBe('merged')
  expect(statusOf('CLOSED', true)).toBe('closed')
})

test('checks sum up as any failed, else any running, else passed', () => {
  const checks = checksOf([
    { __typename: 'CheckRun', name: 'build', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'docs', workflowName: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { __typename: 'StatusContext', context: 'ci/circleci', state: 'PENDING' },
  ])
  expect(checks).toEqual([
    { name: 'CI / build', state: 'pass' },
    { name: 'docs', state: 'skipped' },
    { name: 'ci/circleci', state: 'pending' },
  ])
  expect(summaryOf(checks)).toBe('pending')
  expect(
    summaryOf(checksOf([...[{ status: 'COMPLETED', conclusion: 'CANCELLED', name: 'e2e' }], { state: 'PENDING' }])),
  ).toBe('fail')
  expect(summaryOf(checksOf([{ state: 'ERROR', context: 'deploy' }]))).toBe('fail')
  expect(summaryOf(checksOf([{ status: 'COMPLETED', conclusion: 'NEUTRAL', name: 'x' }]))).toBe('pass')
  expect(summaryOf(checksOf(null))).toBe('')
})

test('a diff splits into files, new, deleted, binary and renamed ones named', () => {
  const files = parseDiff(
    [
      'diff --git a/src/a b.ts b/src/a b.ts',
      'index 1..2 100644',
      '--- a/src/a b.ts',
      '+++ b/src/a b.ts',
      '@@ -1,2 +1,2 @@\r',
      '-old\r',
      '+new\u001b[0m\r',
      ' same',
      '--- a removed line that looks like a header',
      'diff --git a/new.md b/new.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.md',
      '@@ -0,0 +1 @@',
      '+hello',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
      'diff --git a/old name.md b/new name.md',
      'similarity index 100%',
      'rename from old name.md',
      'rename to new name.md',
      '',
    ].join('\n'),
  )
  expect(files.map(file => [file.path, file.note, file.added, file.removed])).toEqual([
    ['src/a b.ts', '', 1, 2],
    ['new.md', 'new', 1, 0],
    ['gone.txt', 'deleted', 0, 1],
    ['logo.png', 'binary', 0, 0],
    ['new name.md', 'renamed', 0, 0],
  ])
  // No `\r` and no escape reach the drawing; the hunk is whole.
  expect(files[0]?.hunks).toBe('@@ -1,2 +1,2 @@\n-old\n+new[0m\n same\n--- a removed line that looks like a header')
  expect(files[4]?.from).toBe('old name.md')
  expect(files[3]?.hunks).toBe('')
})

test('the diff view keeps whole files within its room, and drops a cut last one', () => {
  const file = (path: string, size: number) => ({
    path,
    from: '',
    added: 1,
    removed: 0,
    hunks: `@@ -0,0 +1 @@\n+${'x'.repeat(size)}`,
    note: '',
  })
  const view = diffViewOf([file('a', 50), file('b', 500), file('c', 10), file('d', 10)], 100, true)
  expect(view.files.map(one => [one.path, one.isLeftOut])).toEqual([
    ['a', false],
    ['b', true],
    ['c', false],
  ])
  expect(view.added).toBe(3)
  expect(view.isCut).toBe(true)
})

const DETAIL: RawDetail = {
  number: 9,
  title: 'Add `retry`',
  status: 'merged',
  author: 'alice',
  createdAt: '2026-11-01T12:00:00Z',
  labels: [],
  assignees: ['bob'],
  reviewers: [],
  url: 'https://github.com/acme/web/pull/9',
  body: 'word '.repeat(30),
  base: 'main',
  head: 'feat/`retry`',
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  mergeable: 'CONFLICTING',
  reviewDecision: 'APPROVED',
  checks: [],
  timeline: [
    { author: 'carol', at: '2026-11-02T12:00:00Z', body: 'short', verdict: 'APPROVED' },
    { author: 'dave', at: '2026-11-02T13:00:00Z', body: 'x'.repeat(200), verdict: '' },
  ],
}

test('a merged pull request says nothing of reviews or conflicts, and its room cuts the conversation', () => {
  const text = markdownOf(DETAIL, 'acme/web', NOW, 160)
  expect(text).toContain('**Merged** · @alice opened 2d ago · `feat/\'retry\'` → `main`')
  expect(text).toContain('+1 −0 in 1 file')
  expect(text).not.toContain('Approved**')
  expect(text).not.toContain('Conflicts')
  expect(text).toContain('assigned to @bob')
  expect(text).not.toContain('**Checks**')
  expect(text).toContain('**@carol** approved · 1d ago\n\nshort')
  expect(text).not.toContain('@dave')
  expect(text).toContain('_1 comment or review left out: open the pull request in the browser._')
})

test('an open one with conflicts says so, and a body past the room is cut', () => {
  const text = markdownOf({ ...DETAIL, status: 'open', body: 'word '.repeat(100) }, 'acme/web', NOW, 100)
  expect(text).toContain('**Approved** · **Conflicts with the base branch**')
  expect(text).toContain('_The rest of the description is left out')
  expect(text).toContain('_2 comments and reviews left out')
})

test('gh pr view’s JSON reads into the detail, a team asked to review by its slug', () => {
  const detail = parsePrView(
    JSON.stringify({
      number: 3,
      title: 'Line\none',
      state: 'OPEN',
      isDraft: true,
      author: null,
      reviewRequests: [{ __typename: 'Team', slug: 'core', name: 'Core team' }, { login: 'eve' }],
      reviews: [],
      comments: [],
      additions: 'many',
    }),
  )
  expect(detail?.title).toBe('Line one')
  expect(detail?.status).toBe('draft')
  expect(detail?.author).toBe('ghost')
  expect(detail?.reviewers).toEqual(['core', 'eve'])
  expect(detail?.additions).toBe(0)
  expect(parsePrView('[]')).toBeUndefined()
  expect(parsePrView('{"number": 0}')).toBeUndefined()
})

test('gh’s known complaints are said in a few words', () => {
  expect(reasonOf('HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)')).toBe(
    'GitHub will not send a diff this large: open it in the browser',
  )
  expect(reasonOf('GraphQL: Could not resolve to a Repository with the name x/y')).toBe(
    'Repository not found, or no access',
  )
  expect(reasonOf('\n  something odd\nmore')).toBe('something odd')
})
