import { readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

export async function directorySize(path: string): Promise<number | null> {
  try {
    const metadata = await stat(path)
    if (!metadata.isDirectory()) return metadata.size
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null
    throw error
  }

  let total = 0
  const pending = [path]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) break
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const child = resolve(directory, entry.name)
      if (entry.isDirectory()) pending.push(child)
      else if (entry.isFile()) total += (await stat(child)).size
    }
  }
  return total
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
