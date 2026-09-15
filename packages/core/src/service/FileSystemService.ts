import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import type { IFileSystemService } from '../contract/index'

export class FileSystemService implements IFileSystemService {
  async directorySize(path: string): Promise<number | null> {
    try {
      const metadata = await stat(path)
      if (!metadata.isDirectory()) {
        return metadata.size
      }
    } catch (error) {
      if (this.hasCode(error, 'ENOENT')) {
        return null
      }
      throw error
    }

    let total = 0
    const pending = [path]
    while (pending.length > 0) {
      const directory = pending.pop()
      if (directory === undefined) {
        break
      }
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        const child = resolve(directory, entry.name)
        if (entry.isDirectory()) {
          pending.push(child)
        } else if (entry.isFile()) {
          const metadata = await stat(child)
          total += metadata.size
        }
      }
    }
    return total
  }

  async writeFileAtomically(
    destination: string,
    content: string,
    mode = 0o600
  ): Promise<void> {
    const parent = dirname(destination)
    await mkdir(parent, { mode: 0o700, recursive: true })
    const temporary = resolve(parent, `.${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', mode)

    try {
      await handle.writeFile(content, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    try {
      await rename(temporary, destination)
      await chmod(destination, mode)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  private hasCode(error: unknown, code: string): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === code
    )
  }
}
