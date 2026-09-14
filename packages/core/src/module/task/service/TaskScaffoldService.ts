import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { extract } from '@scaffdog/core'
import { compile, createContext, extendContext } from '@scaffdog/engine'

import { GitsError, type ITaskScaffoldService } from '../../../contract/index'

const templateFileName = 'taskScaffold.md'

export class TaskScaffoldService implements ITaskScaffoldService {
  async ensure(root: string): Promise<void> {
    const taskRoot = resolve(root)
    await mkdir(taskRoot, { recursive: true })

    const files = await this.renderTemplate(taskRoot)
    await Promise.all(
      files.map(async (file) => {
        await mkdir(dirname(file.path), { recursive: true })
        await this.writeMissingFile(file.path, file.content)
      }),
    )

    await mkdir(resolve(root, 'repos'), { recursive: true })
  }

  private async renderTemplate(root: string): Promise<readonly ScaffoldFile[]> {
    const source = await this.readTemplate()
    const extracted = extract(source, {})
    const context = createContext({ cwd: root })

    for (const [name, value] of extracted.variables) {
      context.variables.set(name, compile(value, context))
    }

    const files = extracted.templates.map((template) => {
      const relativePath = compile(template.filename, context)
      const path = this.resolveOutputPath(root, relativePath)
      const variables = new Map(context.variables)
      variables.set('output', { path: relativePath })
      const content = compile(template.content, extendContext(context, { variables }))
      return { content, path }
    })

    if (files.length === 0) {
      throw new GitsError('task-template-empty', `Scaffdog template ${templateFileName} is empty.`)
    }

    return files
  }

  private async readTemplate(): Promise<string> {
    const candidates = [
      resolve(import.meta.dirname, 'templates', templateFileName),
      resolve(import.meta.dirname, '../../../../templates', templateFileName),
    ]

    for (const path of candidates) {
      try {
        return await readFile(path, 'utf8')
      } catch (error) {
        if (isMissingPathError(error)) continue
        const message = error instanceof Error ? error.message : String(error)
        throw new GitsError('task-template-unavailable', `Cannot read ${path}: ${message}`)
      }
    }

    throw new GitsError(
      'task-template-unavailable',
      `Cannot find the bundled Scaffdog template ${templateFileName}.`,
    )
  }

  private resolveOutputPath(root: string, relativePath: string): string {
    const path = resolve(root, relativePath)
    const fromRoot = relative(root, path)
    if (
      relativePath.length === 0 ||
      isAbsolute(relativePath) ||
      fromRoot === '..' ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new GitsError(
        'task-template-path-invalid',
        `Scaffdog template output must stay inside the task directory: ${relativePath}`,
      )
    }
    return path
  }

  private async writeMissingFile(path: string, content: string): Promise<void> {
    try {
      await writeFile(path, content, { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      if (isExistingPathError(error) && (await stat(path)).isFile()) return
      if (isExistingPathError(error)) {
        throw new GitsError(
          'task-scaffold-path-invalid',
          `Task scaffold expected a file but found another kind of path: ${path}`,
        )
      }
      throw error
    }
  }
}

interface ScaffoldFile {
  readonly content: string
  readonly path: string
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT'
}

function isExistingPathError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'EEXIST'
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
}
