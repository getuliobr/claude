import type { GitMark } from '../types'

export type GitStatus = {
  /** Each path git names, relative to the folder git was read from. */
  marks: Map<string, GitMark>
  /** Folders git reports whole as ignored or untracked: so is all beneath. */
  ignoredDirs: string[]
  untrackedDirs: string[]
  /** Every folder above a changed path. */
  dirtyDirs: Set<string>
}

/**
 * Reads `git status --porcelain=v1 -z --ignored`, whose paths are relative
 * to the repository's top, into marks relative to `base`, the folder git
 * was read from under that top (`git rev-parse --show-prefix`).
 */
export function parseGitStatus(output: string, base: string): GitStatus {
  const status: GitStatus = {
    marks: new Map(),
    ignoredDirs: [],
    untrackedDirs: [],
    dirtyDirs: new Set(),
  }
  const entries = output.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? ''
    if (entry.length < 4) continue
    const x = entry[0] ?? ' '
    const y = entry[1] ?? ' '
    // A rename or a copy, staged or not, is followed by the path it came from.
    if (isMove(x) || isMove(y)) i++
    const full = entry.slice(3)
    if (!full.startsWith(base)) continue
    const isDir = full.endsWith('/')
    const path = full.slice(base.length).replace(/\/$/, '')
    if (path === '') continue

    const mark = markFor(x, y)
    status.marks.set(path, mark)
    if (isDir && mark === 'ignored') status.ignoredDirs.push(path)
    if (isDir && mark === 'untracked') status.untrackedDirs.push(path)
    if (mark === 'ignored') continue
    for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) {
      status.dirtyDirs.add(path.slice(0, cut))
    }
  }

  return status
}

/** A row's mark: its own, then a whole folder's above it, then `contains`. */
export function markOf(
  status: GitStatus | undefined,
  path: string,
  isDir: boolean,
): GitMark {
  if (status === undefined) return ''
  const own = status.marks.get(path)
  if (own !== undefined) return own
  if (status.ignoredDirs.some(dir => path.startsWith(`${dir}/`))) return 'ignored'
  if (status.untrackedDirs.some(dir => path.startsWith(`${dir}/`))) return 'untracked'

  return isDir && status.dirtyDirs.has(path) ? 'contains' : ''
}

/** Whether anything in the repository changed: ignored paths aside. */
export function hasChanges(status: GitStatus): boolean {
  for (const mark of status.marks.values()) if (mark !== 'ignored') return true

  return false
}

function isMove(code: string): boolean {
  return code === 'R' || code === 'C'
}

function markFor(x: string, y: string): GitMark {
  if (x === '!') return 'ignored'
  if (x === '?') return 'untracked'
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
    return 'conflict'
  }
  if (y !== ' ') return 'dirty'

  return x === 'R' ? 'renamed' : 'staged'
}
