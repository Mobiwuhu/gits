import { mkdir, open } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { TaskScaffold } from '../../application/ports/task-scaffold.js'

export class NodeTaskScaffold implements TaskScaffold {
  async ensure(root: string): Promise<void> {
    await mkdir(resolve(root, 'docs'), { recursive: true })
    await mkdir(resolve(root, 'scripts'), { recursive: true })
    await mkdir(resolve(root, 'repos'), { recursive: true })

    const agentsPath = resolve(root, 'AGENTS.md')
    const handle = await open(agentsPath, 'a')
    await handle.close()
  }
}
