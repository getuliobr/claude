/**
 * A read every caller shares while it runs, and keeps once it settles.
 *
 * Each draw of the pane reads with its own `$`, and a newer draw makes the
 * engine abandon the one before it, cutting short the calls it made. Such a
 * read is dropped from the cache, and each caller that waited on it reads
 * once more through its own `start`, which holds its own `$`. Cut short
 * again, the caller's own draw is the one dropped, and it stops: it never
 * takes a read from the cache again, so a dropped draw's calls, each cut
 * short at once, cannot stand in the way of a live one.
 */
export async function shared<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  start: () => Promise<T>,
): Promise<T> {
  let pending = cache.get(key)
  if (pending === undefined) {
    pending = start()
    cache.set(key, pending)
  }
  try {
    return await pending
  } catch (error) {
    if (cache.get(key) === pending) cache.delete(key)
    if (!isAbandoned(error)) throw error
  }

  const own = start()
  if (!cache.has(key)) cache.set(key, own)
  try {
    const value = await own
    // A read that settled stands for every later caller, whoever started it.
    cache.set(key, own)

    return value
  } catch (error) {
    if (cache.get(key) === own) cache.delete(key)
    throw error
  }
}

/** A `$` call cut short because the dispatch that made it was abandoned. */
export function isAbandoned(error: unknown): boolean {
  return nameOf(error) === 'AbortError' || /\babort(ed)?\b/i.test(messageOf(error))
}

/** A failed call's stand-in, unless the call was cut short: that is thrown on. */
export function otherwise<T>(fallback: T): (error: unknown) => T {
  return error => {
    if (isAbandoned(error)) throw error

    return fallback
  }
}

// An error from beyond the module may be no `Error` of its own environment:
// its fields are read off whatever it is.
export function messageOf(error: unknown): string {
  if (typeof error === 'string') return error
  const message =
    typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined

  return typeof message === 'string' ? message : ''
}

function nameOf(error: unknown): string {
  const name =
    typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined

  return typeof name === 'string' ? name : ''
}
