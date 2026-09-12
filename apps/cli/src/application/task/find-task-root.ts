import { access, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { GitsError } from '../../domain/task/errors.js'

const configurationName = 'task.config.jsonc'

export async function resolveWorkingDirectory(input: string | undefined): Promise<string> {
  const directory = resolve(input ?? process.cwd())

  try {
    const metadata = await stat(directory)
    if (!metadata.isDirectory()) {
      throw new GitsError('invalid-directory', `Not a directory: ${directory}`)
    }
  } catch (error) {
    if (error instanceof GitsError) throw error
    throw new GitsError('invalid-directory', `Cannot access directory: ${directory}`)
  }

  return directory
}

export async function findTaskRoot(start: string): Promise<string> {
  let current = await resolveWorkingDirectory(start)

  while (true) {
    try {
      await access(resolve(current, configurationName))
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) {
        throw new GitsError(
          'task-not-found',
          `No ${configurationName} found from ${start} through its parent directories.`,
        )
      }
      current = parent
    }
  }
}
