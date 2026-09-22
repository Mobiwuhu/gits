import { lstat, readlink, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

import { globby } from 'globby'

import {
  GitsError,
  TaskDirectoryEntryKind,
  TaskDirectorySourcePolicy,
} from '../../../contract/index'
import type {
  ITaskDirectorySourcePlanService,
  TaskDirectoryEntry,
  TaskDirectorySourcePlan,
} from '../../../contract/index'
import {
  errorMessage,
  hasErrorCode,
  isPathInside,
  normalizeRelativePath,
} from '../../../util/index'

const transactionNames = ['.gits-import-*', '.gits-template-*']

export class TaskDirectorySourcePlanService implements ITaskDirectorySourcePlanService {
  async plan(
    sourceRoot: string,
    policy: TaskDirectorySourcePolicy,
    options: Readonly<{ allowedRepositoryPaths?: readonly string[] }> = {}
  ): Promise<TaskDirectorySourcePlan> {
    const requestedRoot = resolve(sourceRoot)
    await this.assertDirectory(requestedRoot)
    const root = await realpath(requestedRoot)
    const paths =
      policy === TaskDirectorySourcePolicy.StoredTemplate
        ? await globby('**/*', this.options(root, false, []))
        : await globby(
            '**/*',
            this.options(
              root,
              true,
              await this.fixedExclusions(root, policy, options)
            )
          )
    const relativePaths = await this.withAncestorDirectories(root, paths)
    const entries = await Promise.all(
      relativePaths.map(async (relativePath) =>
        this.createEntry(root, relativePath, policy)
      )
    )
    const sorted = entries.toSorted((left, right) =>
      left.relativePath.localeCompare(right.relativePath)
    )
    await this.validateSymbolicLinks(root, sorted)
    return { entries: sorted, policy, sourceRoot: root }
  }

  private options(
    cwd: string,
    gitignore: boolean,
    ignore: readonly string[]
  ): Parameters<typeof globby>[1] {
    return {
      cwd,
      dot: true,
      expandDirectories: false,
      followSymbolicLinks: false,
      gitignore,
      globalGitignore: false,
      ignore: [...ignore],
      onlyFiles: false,
      suppressErrors: false,
      unique: true,
    }
  }

  private async fixedExclusions(
    root: string,
    policy: TaskDirectorySourcePolicy,
    options: Readonly<{ allowedRepositoryPaths?: readonly string[] }>
  ): Promise<readonly string[]> {
    const exclusions = [
      '**/.git',
      '**/.git/**',
      ...transactionNames.flatMap((name) => [name, `${name}/**`]),
    ]
    if (policy === TaskDirectorySourcePolicy.OneOffImport) {
      exclusions.push('repos', 'repos/**')
      return exclusions
    }
    if (policy !== TaskDirectorySourcePolicy.NamedTemplate) {
      return exclusions
    }

    const allowed = new Set(options.allowedRepositoryPaths ?? [])
    const repositoriesRoot = resolve(root, 'repos')
    let children: readonly { readonly name: string }[]
    try {
      children = await readdir(repositoriesRoot, { withFileTypes: true })
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return exclusions
      }
      throw error
    }
    for (const child of children) {
      const childPath = `repos/${child.name}`
      const required = [...allowed].some(
        (path) => path === childPath || path.startsWith(`${childPath}/`)
      )
      if (!required) {
        exclusions.push(childPath, `${childPath}/**`)
      }
    }
    return exclusions
  }

  private async withAncestorDirectories(
    root: string,
    paths: readonly string[]
  ): Promise<readonly string[]> {
    const selected = new Set(paths.map(normalizeRelativePath))
    for (const path of selected) {
      let parent = normalizeRelativePath(dirname(path))
      while (parent !== '.' && parent.length > 0) {
        const metadata = await lstat(resolve(root, parent))
        if (metadata.isDirectory()) {
          selected.add(parent)
        }
        parent = normalizeRelativePath(dirname(parent))
      }
    }
    return [...selected].toSorted((left, right) => left.localeCompare(right))
  }

  private async createEntry(
    root: string,
    relativePath: string,
    policy: TaskDirectorySourcePolicy
  ): Promise<TaskDirectoryEntry> {
    const sourcePath = resolve(root, relativePath)
    if (!isPathInside(root, sourcePath) || relativePath.length === 0) {
      throw new GitsError(
        'template-entry-invalid',
        `Template entry escapes the source directory: ${relativePath}`
      )
    }
    if (
      policy === TaskDirectorySourcePolicy.StoredTemplate &&
      relativePath.split('/').includes('.git')
    ) {
      throw new GitsError(
        'template-integrity-failed',
        `Stored template contains forbidden Git metadata: ${relativePath}`
      )
    }
    const metadata = await lstat(sourcePath)
    if (metadata.isDirectory()) {
      return {
        kind: TaskDirectoryEntryKind.Directory,
        mode: metadata.mode,
        relativePath,
        size: 0,
        sourcePath,
      }
    }
    if (metadata.isFile()) {
      return {
        kind: TaskDirectoryEntryKind.File,
        mode: metadata.mode,
        relativePath,
        size: metadata.size,
        sourcePath,
      }
    }
    if (metadata.isSymbolicLink()) {
      const linkTarget = await readlink(sourcePath)
      return {
        kind: TaskDirectoryEntryKind.Symlink,
        linkTarget,
        mode: metadata.mode,
        relativePath,
        size: Buffer.byteLength(linkTarget),
        sourcePath,
      }
    }
    throw new GitsError(
      'template-entry-invalid',
      `Template entry must be a regular file, directory, or safe symbolic link: ${relativePath}`
    )
  }

  private async validateSymbolicLinks(
    root: string,
    entries: readonly TaskDirectoryEntry[]
  ): Promise<void> {
    const selected = new Set(entries.map((entry) => entry.relativePath))
    for (const entry of entries) {
      if (
        entry.kind !== TaskDirectoryEntryKind.Symlink ||
        entry.linkTarget === undefined
      ) {
        continue
      }
      if (isAbsolute(entry.linkTarget)) {
        throw this.invalidLink(entry, 'absolute targets are not allowed')
      }
      const lexicalTarget = resolve(dirname(entry.sourcePath), entry.linkTarget)
      if (!isPathInside(root, lexicalTarget)) {
        throw this.invalidLink(entry, 'target escapes the source directory')
      }
      if (isPathInside(lexicalTarget, entry.sourcePath)) {
        throw this.invalidLink(entry, 'target creates a directory cycle')
      }
      let resolvedTarget: string
      try {
        resolvedTarget = await realpath(entry.sourcePath)
        await stat(resolvedTarget)
      } catch (error) {
        const message = errorMessage(error)
        throw this.invalidLink(entry, `target cannot be resolved: ${message}`)
      }
      if (!isPathInside(root, resolvedTarget)) {
        throw this.invalidLink(
          entry,
          'resolved target escapes the source directory'
        )
      }
      const targetRelative = normalizeRelativePath(
        relative(root, resolvedTarget)
      )
      if (targetRelative.length === 0 || !selected.has(targetRelative)) {
        throw this.invalidLink(
          entry,
          'target is excluded by template selection rules'
        )
      }
    }
  }

  private invalidLink(entry: TaskDirectoryEntry, reason: string): GitsError {
    return new GitsError(
      'template-entry-invalid',
      `Unsafe symbolic link ${entry.relativePath}: ${reason}.`
    )
  }

  private async assertDirectory(path: string): Promise<void> {
    try {
      const metadata = await stat(path)
      if (metadata.isDirectory()) {
        return
      }
      throw new GitsError(
        'template-source-invalid',
        `Template source is not a directory: ${path}`
      )
    } catch (error) {
      if (error instanceof GitsError) {
        throw error
      }
      const message = errorMessage(error)
      throw new GitsError(
        'template-source-invalid',
        `Cannot access template source ${path}: ${message}`
      )
    }
  }
}
