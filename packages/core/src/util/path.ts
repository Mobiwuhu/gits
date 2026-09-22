import { realpath } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path'

import { hasErrorCode } from './error'

export function normalizeRelativePath(path: string): string {
  return path.split(sep).join('/')
}

export function isPathInside(parent: string, candidate: string): boolean {
  const fromParent = relative(resolve(parent), resolve(candidate))
  return (
    fromParent.length === 0 ||
    (fromParent !== '..' &&
      !fromParent.startsWith(`..${sep}`) &&
      !isAbsolute(fromParent))
  )
}

/** Resolve symlinks in the nearest existing ancestor without requiring the leaf to exist. */
export async function canonicalizePath(path: string): Promise<string> {
  let current = resolve(path)
  const missingSegments: string[] = []
  while (true) {
    try {
      return resolve(await realpath(current), ...missingSegments)
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error
      }
    }

    const parent = dirname(current)
    if (parent === current) {
      return resolve(path)
    }
    missingSegments.unshift(basename(current))
    current = parent
  }
}
