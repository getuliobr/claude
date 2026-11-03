import { expect, test } from 'claude-code/testing'

import { isAbandoned, otherwise, shared } from '../hooks/shared'

// What the engine rejects a `$` call with when a newer draw took its draw's place.
const ABANDONED = 'gh-issues: $.process.run(gh) aborted: the dispatch was abandoned'

/** A call that settles when the test says so. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })

  return { promise, resolve, reject }
}

test('a draw waiting on a dropped draw’s read reads again, with its own start', async () => {
  const cache = new Map<string, Promise<string>>()
  const first = deferred<string>()
  const starts: string[] = []
  // The older draw starts the read; the newer one finds it and waits on it.
  // Once dropped, every call the older draw makes is cut short at once.
  const older = shared(cache, 'acme/web', () => {
    starts.push('older')

    return starts.length === 1 ? first.promise : Promise.reject(new Error(ABANDONED))
  }).catch(() => 'dropped')
  const newer = shared(cache, 'acme/web', () => {
    starts.push('newer')

    return Promise.resolve('issues')
  })
  // The engine drops the older draw: its call is cut short.
  first.reject(new Error(ABANDONED))

  expect(await newer).toBe('issues')
  expect(starts.filter(start => start === 'newer')).toEqual(['newer'])
  // Nobody draws what the dropped draw ends with; it only has to settle.
  await older
  // What the newer draw read stands for the next draw: no read again.
  expect(await shared(cache, 'acme/web', () => Promise.resolve('again'))).toBe('issues')
})

test('a read that settles is kept, and a failure that is not a cut is not read again', async () => {
  const cache = new Map<string, Promise<string>>()
  let starts = 0
  const start = () => {
    starts++

    return Promise.reject(new Error('no implementation for process.run'))
  }
  await expect(shared(cache, 'k', start)).rejects.toThrow('no implementation')
  expect(starts).toBe(1)
})

test('a caller whose own read is cut short too stops, and leaves nothing behind', async () => {
  const cache = new Map<string, Promise<string>>()
  let starts = 0
  const start = () => {
    starts++

    return Promise.reject(new Error(ABANDONED))
  }
  await expect(shared(cache, 'k', start)).rejects.toThrow('aborted')
  expect(starts).toBe(2)
  expect(cache.size).toBe(0)
})

test('a cut is told apart from any other failure, Error or not', () => {
  expect(isAbandoned(new Error(ABANDONED))).toBe(true)
  expect(isAbandoned({ name: 'AbortError', message: 'The operation was aborted' })).toBe(true)
  expect(isAbandoned({ message: ABANDONED })).toBe(true)
  expect(isAbandoned(new Error('spawn gh ENOENT'))).toBe(false)
  expect(isAbandoned(undefined)).toBe(false)

  expect(otherwise([])(new Error('spawn gh ENOENT'))).toEqual([])
  expect(() => otherwise([])(new Error(ABANDONED))).toThrow('aborted')
})
