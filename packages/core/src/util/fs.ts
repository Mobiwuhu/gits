import { lstat, stat } from 'node:fs/promises'

import { hasErrorCode } from './error'

export async function pathExists(path: string): Promise<boolean> {
  return exists(() => stat(path))
}

export async function pathEntryExists(path: string): Promise<boolean> {
  return exists(() => lstat(path))
}

async function exists(inspect: () => Promise<unknown>): Promise<boolean> {
  try {
    await inspect()
    return true
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false
    }
    throw error
  }
}
