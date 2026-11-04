import type { Checks, PrStatus } from '../types'

/** One pull request of `gh pr list --json`, as the list needs it. */
export type RawPr = {
  number: number
  title: string
  status: PrStatus
  checks: Checks
  updatedAt: string
}

/** How one check of a pull request stands. */
export type CheckState = 'pass' | 'fail' | 'pending' | 'skipped'

export type RawCheck = { name: string; state: CheckState }

/** A comment or a review on the pull request's conversation. */
export type RawEntry = {
  author: string
  at: string
  body: string
  /** `''` for a comment, a review's verdict otherwise. */
  verdict: '' | 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'
}

/** One pull request of `gh pr view --json`. */
export type RawDetail = {
  number: number
  title: string
  status: PrStatus
  author: string
  createdAt: string
  labels: string[]
  assignees: string[]
  /** People and teams asked to review it who have not yet. */
  reviewers: string[]
  url: string
  body: string
  base: string
  head: string
  additions: number
  deletions: number
  changedFiles: number
  /** `MERGEABLE`, `CONFLICTING` or `UNKNOWN`. */
  mergeable: string
  /** `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED` or `''`. */
  reviewDecision: string
  checks: RawCheck[]
  /** Comments and reviews, oldest first. */
  timeline: RawEntry[]
}

/** One file of a pull request's diff. */
export type DiffFile = {
  path: string
  /** The path it had before a rename, `''` when it kept its name. */
  from: string
  added: number
  removed: number
  /** Its hunks from the first `@@`; `''` for a file with none (binary, a rename alone). */
  hunks: string
  /** What the file list says beside it: `new`, `deleted`, `binary`, `renamed`. */
  note: string
}

/** The diff as the sheet draws it: whole files, up to the room it has. */
export type DiffView = {
  files: (DiffFile & { isLeftOut: boolean })[]
  added: number
  removed: number
  /** gh's answer was longer than a command's output can be: files are missing. */
  isCut: boolean
}

export const LIST_FIELDS = 'number,title,state,isDraft,updatedAt,statusCheckRollup'
export const VIEW_FIELDS = [
  'number', 'title', 'state', 'isDraft', 'author', 'body', 'labels', 'assignees',
  'reviewRequests', 'reviews', 'comments', 'createdAt', 'url', 'baseRefName',
  'headRefName', 'additions', 'deletions', 'changedFiles', 'mergeable',
  'reviewDecision', 'statusCheckRollup',
].join(',')

// The failing and running checks the sheet names one by one; past them it counts.
const MAX_CHECKS = 20

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const NAME = /^[A-Za-z0-9._-]{1,100}$/

/**
 * `owner/repo` of a GitHub remote's URL, in any of the forms git keeps one:
 * `https://github.com/o/r.git`, `git@github.com:o/r.git`, `ssh://git@github.com/o/r`.
 */
export function parseGitHubRemote(url: string): string | undefined {
  const match =
    /^(?:https?|git|ssh):\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    ) ?? /^(?:[^@/\s]+@)?github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim())
  if (match === null) return undefined
  const [, owner = '', name = ''] = match

  return isRepoName(`${owner}/${name}`) ? `${owner}/${name}` : undefined
}

/** Whether a string is an `owner/repo` GitHub could hold. */
export function isRepoName(repo: string): boolean {
  const [owner = '', name = '', ...rest] = repo.split('/')

  return rest.length === 0 && OWNER.test(owner) && NAME.test(name) && name !== '.' && name !== '..'
}

/**
 * The repository a project's pull requests live in, from `git remote -v`: its
 * `upstream` when that is on GitHub, as a fork's is, then `origin`, then any.
 */
export function remoteRepo(remotes: string): string | undefined {
  const byName = new Map<string, string>()
  for (const line of remotes.split('\n')) {
    const [name, url] = line.trim().split(/\s+/)
    if (name === undefined || url === undefined || byName.has(name)) continue
    const repo = parseGitHubRemote(url)
    if (repo !== undefined) byName.set(name, repo)
  }

  return byName.get('upstream') ?? byName.get('origin') ?? byName.values().next().value
}

export function parsePrList(stdout: string): RawPr[] | undefined {
  const items = parseJson(stdout)
  if (!Array.isArray(items)) return undefined

  return items.flatMap(item => {
    if (!isRecord(item) || !isPrNumber(item.number)) return []

    return [
      {
        number: item.number,
        title: oneLine(stringOf(item.title)),
        status: statusOf(item.state, item.isDraft),
        checks: summaryOf(checksOf(item.statusCheckRollup)),
        updatedAt: stringOf(item.updatedAt),
      },
    ]
  })
}

export function parsePrView(stdout: string): RawDetail | undefined {
  const item = parseJson(stdout)
  if (!isRecord(item) || !isPrNumber(item.number)) return undefined
  const comments = (Array.isArray(item.comments) ? item.comments : []).filter(isRecord)
  const reviews = (Array.isArray(item.reviews) ? item.reviews : []).filter(isRecord)
  const timeline: RawEntry[] = [
    ...comments.map(comment => ({
      author: loginOf(comment.author),
      at: stringOf(comment.createdAt),
      body: clean(stringOf(comment.body)).trim(),
      verdict: '' as const,
    })),
    // A review still pending is its author's draft, which nobody else sees.
    ...reviews.flatMap(review => {
      const verdict = verdictOf(review.state)
      if (verdict === undefined) return []

      return [
        {
          author: loginOf(review.author),
          at: stringOf(review.submittedAt),
          body: clean(stringOf(review.body)).trim(),
          verdict,
        },
      ]
    }),
  ]

  return {
    number: item.number,
    title: oneLine(stringOf(item.title)),
    status: statusOf(item.state, item.isDraft),
    author: loginOf(item.author),
    createdAt: stringOf(item.createdAt),
    labels: namesOf(item.labels, ['name']),
    assignees: namesOf(item.assignees, ['login']),
    reviewers: namesOf(item.reviewRequests, ['login', 'slug', 'name']),
    url: stringOf(item.url),
    body: clean(stringOf(item.body)).trim(),
    base: oneLine(stringOf(item.baseRefName)),
    head: oneLine(stringOf(item.headRefName)),
    additions: countIn(item.additions),
    deletions: countIn(item.deletions),
    changedFiles: countIn(item.changedFiles),
    mergeable: stringOf(item.mergeable).toUpperCase(),
    reviewDecision: stringOf(item.reviewDecision).toUpperCase(),
    checks: checksOf(item.statusCheckRollup),
    timeline: sortedByTime(timeline),
  }
}

/** A pull request's state as its icon draws it: a draft is open, but drawn apart. */
export function statusOf(state: unknown, isDraft: unknown): PrStatus {
  const upper = stringOf(state).toUpperCase()
  if (upper === 'MERGED') return 'merged'
  if (upper === 'CLOSED') return 'closed'

  return isDraft === true ? 'draft' : 'open'
}

/**
 * Each check of `statusCheckRollup`: a CheckRun by its status and conclusion,
 * a commit status (StatusContext) by its state.
 */
export function checksOf(rollup: unknown): RawCheck[] {
  if (!Array.isArray(rollup)) return []

  return rollup.filter(isRecord).map(check => {
    const isStatus = stringOf(check.__typename) === 'StatusContext' || (!('status' in check) && 'state' in check)
    if (isStatus) {
      const state = stringOf(check.state).toUpperCase()

      return {
        name: oneLine(stringOf(check.context)) || 'status',
        state: state === 'SUCCESS' ? 'pass' : state === 'FAILURE' || state === 'ERROR' ? 'fail' : 'pending',
      }
    }
    const workflow = oneLine(stringOf(check.workflowName))
    const name = oneLine(stringOf(check.name)) || 'check'

    return { name: workflow === '' || workflow === name ? name : `${workflow} / ${name}`, state: runStateOf(check) }
  })
}

function runStateOf(check: Record<string, unknown>): CheckState {
  if (stringOf(check.status).toUpperCase() !== 'COMPLETED') return 'pending'
  const conclusion = stringOf(check.conclusion).toUpperCase()
  if (conclusion === 'SUCCESS') return 'pass'
  if (conclusion === 'NEUTRAL' || conclusion === 'SKIPPED' || conclusion === 'STALE') return 'skipped'

  // FAILURE, TIMED_OUT, CANCELLED, ACTION_REQUIRED, STARTUP_FAILURE: each blocks a merge.
  return 'fail'
}

/** Any failed, else any running, else passed; nothing for no checks. */
export function summaryOf(checks: readonly RawCheck[]): Checks {
  if (checks.length === 0) return ''
  if (checks.some(check => check.state === 'fail')) return 'fail'
  if (checks.some(check => check.state === 'pending')) return 'pending'

  return 'pass'
}

/**
 * The files of `gh pr diff`'s unified diff, each with its hunks as a
 * `Code format="diff"` reads them: from the first `@@`, with no `\r` and no
 * control character but the tab.
 */
export function parseDiff(text: string): DiffFile[] {
  type Open = DiffFile & { lines: string[]; isInHunks: boolean }
  const files: Open[] = []
  let file: Open | undefined
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    if (line.startsWith('diff --git ')) {
      file = { path: pathOfGitLine(line), from: '', added: 0, removed: 0, hunks: '', note: '', lines: [], isInHunks: false }
      files.push(file)
      continue
    }
    if (file === undefined) continue
    if (file.isInHunks || line.startsWith('@@')) {
      file.isInHunks = true
      file.lines.push(line)
      if (line.startsWith('+')) file.added++
      else if (line.startsWith('-')) file.removed++
      continue
    }
    if (line.startsWith('rename from ')) file.from = line.slice('rename from '.length)
    else if (line.startsWith('rename to ')) file.path = line.slice('rename to '.length)
    else if (line.startsWith('new file mode')) file.note = 'new'
    else if (line.startsWith('deleted file mode')) file.note = 'deleted'
    else if (line.startsWith('Binary files') || line === 'GIT binary patch') file.note = 'binary'
    else if (line.startsWith('+++ b/')) file.path = line.slice('+++ b/'.length)
  }

  return files.map(file => {
    const lines = [...file.lines]
    while (lines.length > 0 && lines.at(-1) === '') lines.pop()

    return {
      path: file.path,
      from: file.from,
      added: file.added,
      removed: file.removed,
      hunks: lines.join('\n'),
      note: file.note !== '' ? file.note : file.from !== '' ? 'renamed' : '',
    }
  })
}

/**
 * Whole files, in order, as long as their hunks fit `room` characters: a file
 * past the room is listed without them, and a smaller one after it may fit.
 * `isCut`: gh's answer was cut short, so its last file may end mid-hunk and
 * is dropped.
 */
export function diffViewOf(files: readonly DiffFile[], room: number, isCut: boolean): DiffView {
  const kept = isCut ? files.slice(0, -1) : files
  let left = room
  const shown = kept.map(file => {
    const length = file.hunks.length
    const isLeftOut = length > left
    if (!isLeftOut) left -= length

    return { ...file, isLeftOut }
  })

  return {
    files: shown,
    added: kept.reduce((sum, file) => sum + file.added, 0),
    removed: kept.reduce((sum, file) => sum + file.removed, 0),
    isCut,
  }
}

/** `a/<p> b/<p>`: the path, when both halves name the same one; else the part after ` b/`. */
function pathOfGitLine(line: string): string {
  const rest = line.slice('diff --git '.length)
  if (rest.startsWith('a/') && rest.length % 2 === 1) {
    const half = (rest.length - 1) / 2
    const left = rest.slice(2, half)
    const right = rest.slice(half + 1)
    if (right === `b/${left}`) return left
  }
  const at = rest.lastIndexOf(' b/')

  return at >= 0 ? rest.slice(at + 3) : rest
}

const STATUS_LABEL: Record<PrStatus, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
}

const CHECK_GLYPH: Record<CheckState, string> = { fail: '✗', pending: '●', pass: '✓', skipped: '–' }
const CHECK_WORD: Record<CheckState, string> = {
  fail: 'failing',
  pending: 'running',
  pass: 'passed',
  skipped: 'skipped',
}

/**
 * The pull request as Markdown: who opened it from where, its changes and
 * reviews, its checks, then its description and conversation, in order, up
 * to `room` characters (code points, so an emoji counts once wherever it is),
 * the rest left for the browser.
 */
export function markdownOf(raw: RawDetail, repo: string, now: number, room: number): string {
  const isOpen = raw.status === 'open' || raw.status === 'draft'
  const branches = raw.head !== '' && raw.base !== '' ? [`${code(raw.head)} → ${code(raw.base)}`] : []
  const meta = [
    `**${STATUS_LABEL[raw.status]}**`,
    `@${raw.author} opened ${agoOf(ageOf(raw.createdAt, now))}`,
    ...branches,
  ].join(' · ')
  const review = REVIEW_LABEL[raw.reviewDecision]
  const changes = [
    `+${raw.additions} −${raw.deletions} in ${countOf(raw.changedFiles, 'file')}`,
    ...(isOpen && review !== undefined ? [review] : []),
    ...(isOpen && raw.mergeable === 'CONFLICTING' ? ['**Conflicts with the base branch**'] : []),
  ].join(' · ')
  const people = [
    ...(raw.labels.length > 0 ? [raw.labels.map(code).join(' ')] : []),
    ...(raw.reviewers.length > 0 ? [`review asked of ${raw.reviewers.map(name => `@${name}`).join(', ')}`] : []),
    ...(raw.assignees.length > 0 ? [`assigned to ${raw.assignees.map(name => `@${name}`).join(', ')}`] : []),
  ].join(' · ')

  const parts = [`## ${raw.title} · ${repo}#${raw.number}`, meta, changes]
  if (people !== '') parts.push(people)
  const checks = checksMarkdown(raw.checks)
  if (checks !== undefined) parts.push(checks)

  const points = [...raw.body]
  const isBodyCut = points.length > room
  parts.push(raw.body === '' ? '_No description._' : isBodyCut ? `${points.slice(0, room).join('')}…` : raw.body)
  if (isBodyCut) parts.push('_The rest of the description is left out: open the pull request in the browser._')
  let left = room - Math.min(points.length, room)
  let shown = 0
  for (const entry of raw.timeline) {
    const length = [...entry.body].length
    if (isBodyCut || length > left) break
    left -= length
    shown++
    const verb = VERDICT_VERB[entry.verdict]
    parts.push('---', `**@${entry.author}**${verb} · ${agoOf(ageOf(entry.at, now))}`)
    if (entry.body !== '') parts.push(entry.body)
  }
  const omitted = raw.timeline.length - shown
  if (omitted > 0) {
    const what = omitted === 1 ? '1 comment or review' : `${omitted} comments and reviews`
    parts.push(`_${what} left out: open the pull request in the browser._`)
  }

  return parts.join('\n\n')
}

const REVIEW_LABEL: Record<string, string> = {
  APPROVED: '**Approved**',
  CHANGES_REQUESTED: '**Changes requested**',
  REVIEW_REQUIRED: 'Review required',
}

const VERDICT_VERB: Record<RawEntry['verdict'], string> = {
  '': '',
  APPROVED: ' approved',
  CHANGES_REQUESTED: ' requested changes',
  COMMENTED: ' reviewed',
  DISMISSED: ' reviewed (dismissed)',
}

/** The checks in a line of counts, then each failing or running one by name. */
function checksMarkdown(checks: readonly RawCheck[]): string | undefined {
  if (checks.length === 0) return undefined
  const order: CheckState[] = ['fail', 'pending', 'pass', 'skipped']
  const counts = order.flatMap(state => {
    const n = checks.filter(check => check.state === state).length

    return n === 0 ? [] : [`${CHECK_GLYPH[state]} ${n} ${CHECK_WORD[state]}`]
  })
  const named = checks.filter(check => check.state === 'fail' || check.state === 'pending')
  const lines = [`**Checks** · ${counts.join(' · ')}`]
  if (named.length > 0) lines.push('')
  for (const check of named.slice(0, MAX_CHECKS)) {
    lines.push(`- ${CHECK_GLYPH[check.state]} ${code(check.name)}`)
  }
  if (named.length > MAX_CHECKS) lines.push(`- and ${named.length - MAX_CHECKS} more`)

  return lines.join('\n')
}

/** How long ago an ISO time was, short: `now`, `5m`, `3h`, `2d`, `3w`, `4mo`, `2y`. */
export function ageOf(iso: string, now: number): string {
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  if (days < 30) return `${Math.floor(days / 7)}w`
  if (days < 365) return `${Math.floor(days / 30)}mo`

  return `${Math.floor(days / 365)}y`
}

/** An age as a phrase: `2d ago`, `just now`. */
export function agoOf(age: string): string {
  return age === '' ? '' : age === 'now' ? 'just now' : `${age} ago`
}

export function prUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/pull/${number}`
}

/**
 * What Claude is asked to do with a pull request: review it, fix what its
 * reviews and checks found, or, to fill the prompt, read it before the
 * person says what for. Its own text, the title and branch names included,
 * is left out: Claude reads it with `gh`, as a tool's result, never as the
 * person's own words, since anyone who can open a pull request wrote it.
 */
export function promptFor(input: {
  kind: 'review' | 'fix' | 'fill'
  repo: string
  number: number
  /** The project's folder under the session's root, `''` for the root. */
  dir: string
  path: string
  /** For a subagent started in the project's folder. */
  isAgent: boolean
}): string {
  const { kind, repo, number, dir, path, isAgent } = input
  const pr = `${repo}#${number}`
  const view = `gh pr view ${number} --repo ${repo} --comments`
  const diff = `gh pr diff ${number} --repo ${repo}`
  const checks = `gh pr checks ${number} --repo ${repo}`
  const folder = isAgent
    ? `the folder you are in (${path})`
    : dir === ''
      ? `this session's folder (${path})`
      : `${dir}/ (${path})`

  if (kind === 'fill') {
    return [
      `GitHub pull request ${pr}, in the project at ${folder}.`,
      `Read it first: ${view}, and its changes: ${diff}`,
      prUrl(repo, number),
    ].join('\n')
  }
  if (kind === 'fix') {
    return [
      `Address the review feedback and the failing checks on GitHub pull request ${pr}.`,
      `The project is at ${folder}: check out the pull request's branch there with gh pr checkout ${number} --repo ${repo}, and stop to ask me first if the working tree has changes of its own.`,
      `Read the pull request and its comments: ${view}`,
      `Then the comments on its code, gh api repos/${repo}/pulls/${number}/comments, and its checks, ${checks}`,
      'Commit the fixes on that branch, but do not push or reply on GitHub until I say so.',
      prUrl(repo, number),
    ].join('\n')
  }

  return [
    `Review GitHub pull request ${pr}.`,
    `The project's code is at ${folder}, to read around the changes.`,
    `Read the pull request and its comments: ${view}`,
    `Then its changes, ${diff}, and its checks, ${checks}`,
    isAgent
      ? 'Report back what you find, the most serious first. Do not comment on, approve or change the pull request on GitHub, and do not check out its branch or edit files.'
      : 'Report what you find, the most serious first. Do not comment on, approve or change the pull request on GitHub, and do not check out its branch, unless I ask.',
    prUrl(repo, number),
  ].join('\n')
}

export function countOf(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/**
 * Why `gh` failed, short enough for a row: its known complaints in a few
 * words, any other as the first line it wrote.
 */
export function reasonOf(stderr: string): string {
  if (/gh auth login|not logged in|authentication required/i.test(stderr)) {
    return 'Not signed in: run gh auth login'
  }
  if (/could not resolve to a repository/i.test(stderr)) return 'Repository not found, or no access'
  if (/diff exceeded|diff is too large|too_large/i.test(stderr)) {
    return 'GitHub will not send a diff this large: open it in the browser'
  }
  if (/rate limit/i.test(stderr)) return 'GitHub rate limit: try R later'
  if (/could not resolve host|network|timed? ?out/i.test(stderr)) return 'GitHub unreachable: try R later'

  return firstLine(stderr)
}

/** The first line of a failed command's output, to say why. */
export function firstLine(text: string): string {
  return clean(text)
    .split('\n')
    .map(line => line.trim())
    .find(line => line !== '') ?? ''
}

export function isPrNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Text a surface draws: newlines as `\n`, tabs as spaces, no other controls. */
export function clean(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
}

/** A code span: a backtick inside one, which would end it, is drawn as a quote. */
function code(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``
}

function verdictOf(state: unknown): RawEntry['verdict'] | undefined {
  const upper = stringOf(state).toUpperCase()

  return upper === 'APPROVED' || upper === 'CHANGES_REQUESTED' || upper === 'COMMENTED' || upper === 'DISMISSED'
    ? upper
    : undefined
}

/** Oldest first; an entry without a readable time keeps its place at the end. */
function sortedByTime(entries: readonly RawEntry[]): RawEntry[] {
  const at = (entry: RawEntry): number => {
    const ms = Date.parse(entry.at)

    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
  }

  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => at(a.entry) - at(b.entry) || a.index - b.index)
    .map(({ entry }) => entry)
}

function oneLine(text: string): string {
  return clean(text).replace(/\s*\n\s*/g, ' ').trim()
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function countIn(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function loginOf(value: unknown): string {
  return isRecord(value) ? oneLine(stringOf(value.login)) || 'ghost' : 'ghost'
}

/** The first of `fields` each item holds: a user's login, a team's slug or name. */
function namesOf(value: unknown, fields: readonly string[]): string[] {
  if (!Array.isArray(value)) return []

  return value.flatMap(item => {
    if (!isRecord(item)) return []
    const name = fields.map(field => oneLine(stringOf(item[field]))).find(one => one !== '') ?? ''

    return name === '' ? [] : [name]
  })
}
