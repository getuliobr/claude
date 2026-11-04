import type { IssueDetail } from '../types'

/** One issue of `gh issue list --json`, as the list needs it. */
export type RawIssue = {
  number: number
  title: string
  isClosed: boolean
  updatedAt: string
}

export type RawComment = { author: string; createdAt: string; body: string }

/** One issue of `gh issue view --json`. */
export type RawDetail = {
  number: number
  title: string
  isClosed: boolean
  stateReason: string
  author: string
  createdAt: string
  labels: string[]
  assignees: string[]
  milestone: string
  url: string
  body: string
  comments: RawComment[]
}

export const LIST_FIELDS = 'number,title,state,updatedAt'
export const VIEW_FIELDS =
  'number,title,state,stateReason,author,body,labels,assignees,milestone,comments,createdAt,url'

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
 * The repository a project's issues live in, from `git remote -v`: its
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

export function parseIssueList(stdout: string): RawIssue[] | undefined {
  const items = parseJson(stdout)
  if (!Array.isArray(items)) return undefined

  return items.flatMap(item => {
    if (!isRecord(item) || !isIssueNumber(item.number)) return []

    return [
      {
        number: item.number,
        title: oneLine(stringOf(item.title)),
        isClosed: stringOf(item.state).toUpperCase() === 'CLOSED',
        updatedAt: stringOf(item.updatedAt),
      },
    ]
  })
}

export function parseIssueView(stdout: string): RawDetail | undefined {
  const item = parseJson(stdout)
  if (!isRecord(item) || !isIssueNumber(item.number)) return undefined
  const comments = Array.isArray(item.comments) ? item.comments : []

  return {
    number: item.number,
    title: oneLine(stringOf(item.title)),
    isClosed: stringOf(item.state).toUpperCase() === 'CLOSED',
    stateReason: stringOf(item.stateReason).toUpperCase(),
    author: loginOf(item.author),
    createdAt: stringOf(item.createdAt),
    labels: namesOf(item.labels, 'name'),
    assignees: namesOf(item.assignees, 'login'),
    milestone: isRecord(item.milestone) ? oneLine(stringOf(item.milestone.title)) : '',
    url: stringOf(item.url),
    body: clean(stringOf(item.body)).trim(),
    comments: comments.filter(isRecord).map(comment => ({
      author: loginOf(comment.author),
      createdAt: stringOf(comment.createdAt),
      body: clean(stringOf(comment.body)).trim(),
    })),
  }
}

/**
 * An issue as the sheet draws it: ages against `now`, and the body and
 * comments, in order, up to `room` characters (code points, so an emoji
 * counts once wherever it is), the rest left for the browser.
 */
export function detailOf(raw: RawDetail, repo: string, now: number, room: number): IssueDetail {
  const points = [...raw.body]
  const isBodyCut = points.length > room
  const body = isBodyCut ? `${points.slice(0, room).join('')}…` : raw.body
  let left = room - Math.min(points.length, room)
  const comments: IssueDetail['comments'] = []
  for (const comment of raw.comments) {
    const length = [...comment.body].length
    if (isBodyCut || length > left) break
    left -= length
    comments.push({ author: comment.author, age: ageOf(comment.createdAt, now), body: comment.body })
  }

  return {
    repo,
    number: raw.number,
    title: raw.title,
    isClosed: raw.isClosed,
    stateLabel: !raw.isClosed
      ? 'Open'
      : raw.stateReason === 'NOT_PLANNED'
        ? 'Closed as not planned'
        : 'Closed',
    author: raw.author,
    age: ageOf(raw.createdAt, now),
    labels: raw.labels,
    assignees: raw.assignees,
    milestone: raw.milestone,
    url: raw.url === '' ? issueUrl(repo, raw.number) : raw.url,
    body,
    isBodyCut,
    comments,
    omitted: raw.comments.length - comments.length,
  }
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

export function issueUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/issues/${number}`
}

/**
 * What Claude is asked to do with an issue. The issue's own text, its title
 * included, is left out: Claude reads it with `gh`, as a tool's result, never
 * as the person's own words, since anyone who can open an issue wrote it.
 */
export function promptFor(input: {
  repo: string
  number: number
  /** The project's folder under the session's root, `''` for the root. */
  dir: string
  path: string
  /** For a subagent started in the project's folder. */
  isAgent: boolean
}): string {
  const { repo, number, dir, path, isAgent } = input
  const issue = `${repo}#${number}`
  const where = isAgent
    ? `The project is the folder you are in (${path}); make the changes there.`
    : dir === ''
      ? `The project is this session's folder (${path}); make the changes there.`
      : `The project is at ${dir}/ (${path}); make the changes there.`

  return [
    `Work on GitHub issue ${issue}.`,
    where,
    `Read the issue and its comments first: gh issue view ${number} --repo ${repo} --comments`,
    issueUrl(repo, number),
  ].join('\n')
}

/** The issue as Markdown, for a surface that draws no `Client`. */
export function markdownOf(issue: IssueDetail): string {
  const meta = [
    `**${issue.stateLabel}**`,
    `@${issue.author} opened ${agoOf(issue.age)}`,
    ...(issue.labels.length > 0 ? [issue.labels.map(label => `\`${label}\``).join(' ')] : []),
  ].join(' · ')
  const parts = [
    `## ${issue.title} · ${issue.repo}#${issue.number}`,
    meta,
    issue.body === '' ? '_No description._' : issue.body,
  ]
  if (issue.isBodyCut) parts.push('_The rest of the description is left out: open the issue in the browser._')
  for (const comment of issue.comments) {
    parts.push('---', `**@${comment.author}** · ${agoOf(comment.age)}`, comment.body)
  }
  if (issue.omitted > 0) {
    parts.push(`_${countOf(issue.omitted, 'comment')} left out: open the issue in the browser._`)
  }

  return parts.join('\n\n')
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
  if (/disabled issues|issues are disabled/i.test(stderr)) return 'Issues are turned off here'
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

export function isIssueNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Text a surface draws: newlines as `\n`, tabs as spaces, no other controls. */
export function clean(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
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

function loginOf(value: unknown): string {
  return isRecord(value) ? oneLine(stringOf(value.login)) || 'ghost' : 'ghost'
}

function namesOf(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) return []

  return value.flatMap(item => {
    const name = isRecord(item) ? oneLine(stringOf(item[field])) : ''

    return name === '' ? [] : [name]
  })
}
