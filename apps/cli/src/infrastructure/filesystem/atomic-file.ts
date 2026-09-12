import { chmod, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function writeFileAtomically(
  destination: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  const parent = dirname(destination)
  await mkdir(parent, { mode: 0o700, recursive: true })
  const temporary = resolve(parent, `.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', mode)

  try {
    await handle.writeFile(content, 'utf8')
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
