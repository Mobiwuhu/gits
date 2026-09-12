import { access, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'

import type {
  RawTaskConfiguration,
  TaskConfigurationStore,
} from '../../application/ports/task-configuration-store.js'
import { ConfigurationError } from '../../domain/task/errors.js'
import type { TaskConfiguration, TaskRepository } from '../../domain/task/model.js'

const configurationFileName = 'task.config.jsonc'

const template = `{
  // 仓库定义。每个 key 都是稳定的仓库名称，可用于
  // "gits install example-repo"、"gits status example-repo" 等命令。
  "repos": {
    "example-repo": {
      // 运行 gits install 前请替换所有 <...> 占位符。
      // Git 远端地址，会被记录为 origin；SSH 和 HTTPS 地址均可。
      "url": "git@<host>:<group>/<repo>.git",

      // 相对当前 Task 目录的本地工作区路径，必须位于 repos/ 之下。
      "path": "repos/example-repo",

      // 本地任务分支；不存在时由 gits 创建，之后保持检出该分支。
      "branch": "<task-branch>",

      // 仅在任务分支需要创建时使用的远端起点，格式必须是 origin/<branch>。
      "from": "origin/<base-branch>",

      // 工作区范围：null 表示完整检出；要局部检出则改为非空目录数组，
      // 例如 ["knowledge", "docs/guides"]。目录相对仓库根，根目录文件仍会保留。
      "checkout": null,

      // Mirror 对象策略：false 保留更快、更省空间的共享对象依赖；
      // true 会复制对象，使工作仓库不再依赖 Mirror，但安装更慢且占用更多磁盘。
      "dissociate": false
    }
  }
}
`

interface ParsedRepository {
  readonly branch: string
  readonly checkout: readonly string[] | null
  readonly dissociate: boolean
  readonly from: string
  readonly path?: string
  readonly url: string
}

type JsonObject = Record<string, unknown>

export class JsoncTaskConfigurationStore implements TaskConfigurationStore {
  async createTemplate(root: string): Promise<void> {
    const configPath = resolve(root, configurationFileName)

    try {
      await access(configPath)
      return
    } catch {
      await writeFile(configPath, template, { encoding: 'utf8', flag: 'wx' })
    }
  }

  async load(root: string): Promise<RawTaskConfiguration> {
    const configPath = resolve(root, configurationFileName)
    let content: string

    try {
      content = await readFile(configPath, 'utf8')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new ConfigurationError(`Cannot read ${configurationFileName}: ${message}`)
    }

    return {
      configuration: parseTaskConfiguration(root, configPath, content),
      content,
    }
  }
}

export function isDefaultTaskConfigurationTemplate(content: string): boolean {
  try {
    const raw = ensureObject(parseJsonc(content), 'configuration root')
    return isTemplateRepositorySet(ensureObject(raw.repos, 'repos'))
  } catch {
    return false
  }
}

export function parseTaskConfiguration(
  root: string,
  configPath: string,
  content: string,
): TaskConfiguration {
  const raw = ensureObject(parseJsonc(content), 'configuration root')
  const repos = ensureObject(raw.repos, 'repos')
  const issues: string[] = []
  const repositories: TaskRepository[] = []
  const paths = new Set<string>()

  for (const [name, value] of Object.entries(repos)) {
    const parsed = parseRepository(name, value, issues)
    if (!parsed) continue

    const parsedPath = resolveRepositoryPath(root, name, parsed.path, issues)
    if (!parsedPath) continue

    if (paths.has(parsedPath.absolutePath)) {
      issues.push(`Repository '${name}' resolves to a duplicate path: ${parsedPath.path}`)
      continue
    }
    paths.add(parsedPath.absolutePath)

    repositories.push({
      absolutePath: parsedPath.absolutePath,
      branch: parsed.branch,
      checkout: parsed.checkout,
      dissociate: parsed.dissociate,
      from: parsed.from,
      name,
      path: parsedPath.path,
      url: parsed.url,
    })
  }

  if (repositories.length === 0) issues.push('repos must contain at least one repository.')
  if (issues.length > 0) {
    throw new ConfigurationError(`Invalid ${configurationFileName}.`, issues)
  }

  return {
    configPath,
    repositories,
    root,
  }
}

function parseJsonc(content: string): unknown {
  const errors: ParseError[] = []
  const parsed = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  })

  if (errors.length > 0) {
    const diagnostics = errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(', ')
    throw new ConfigurationError(`Cannot parse ${configurationFileName}: ${diagnostics}`)
  }

  return parsed
}

function ensureObject(value: unknown, location: string): JsonObject {
  if (!isObject(value)) {
    throw new ConfigurationError(`${location} must be an object.`)
  }
  return value
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRepository(
  name: string,
  value: unknown,
  issues: string[],
): ParsedRepository | undefined {
  if (!isValidRepositoryName(name)) {
    issues.push(
      `Repository name '${name}' must be non-empty and cannot contain '/', '\\', or '..'.`,
    )
    return undefined
  }
  if (!isObject(value)) {
    issues.push(`Repository '${name}' must be an object.`)
    return undefined
  }

  const url = requiredString(value.url, `repos.${name}.url`, issues)
  const branch = requiredString(value.branch, `repos.${name}.branch`, issues)
  const from = requiredString(value.from, `repos.${name}.from`, issues)
  const path = optionalString(value.path, `repos.${name}.path`, issues)
  const checkout = optionalCheckout(value.checkout, `repos.${name}.checkout`, issues)
  const dissociate = optionalBoolean(value.dissociate, `repos.${name}.dissociate`, issues) ?? false

  if (!url || !branch || !from) return undefined
  if (!from.startsWith('origin/') || from.length === 'origin/'.length) {
    issues.push(`repos.${name}.from must use the form origin/<branch>.`)
  }

  return {
    url,
    branch,
    checkout,
    dissociate,
    from,
    ...(path ? { path } : {}),
  }
}

function optionalCheckout(
  value: unknown,
  location: string,
  issues: string[],
): readonly string[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${location} must be a non-empty array of repository-relative directories.`)
    return null
  }

  const directories: string[] = []
  const seen = new Set<string>()
  for (const [index, entry] of value.entries()) {
    const entryLocation = `${location}[${index}]`
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      issues.push(`${entryLocation} must be a non-empty string.`)
      continue
    }

    const directory = entry.trim()
    const segments = directory.split('/')
    if (
      isAbsolute(directory) ||
      /^[A-Za-z]:\//u.test(directory) ||
      directory.includes('\\') ||
      segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    ) {
      issues.push(
        `${entryLocation} must be a canonical repository-relative directory without '.', '..', empty segments, or backslashes.`,
      )
      continue
    }
    if (/[*?[\]]/u.test(directory)) {
      issues.push(`${entryLocation} must name a directory and cannot contain glob characters.`)
      continue
    }
    if (/\p{Cc}/u.test(directory)) {
      issues.push(`${entryLocation} cannot contain control characters.`)
      continue
    }
    if (segments.some((segment) => segment.toLowerCase() === '.git')) {
      issues.push(`${entryLocation} cannot select Git administrative paths.`)
      continue
    }
    if (seen.has(directory)) {
      issues.push(`${location} contains the duplicate directory '${directory}'.`)
      continue
    }

    seen.add(directory)
    directories.push(directory)
  }

  return directories
}

function optionalBoolean(value: unknown, location: string, issues: string[]): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    issues.push(`${location} must be a boolean when present.`)
    return undefined
  }
  return value
}

function requiredString(value: unknown, location: string, issues: string[]): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`${location} must be a non-empty string.`)
    return undefined
  }
  return value.trim()
}

function optionalString(value: unknown, location: string, issues: string[]): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`${location} must be a non-empty string when present.`)
    return undefined
  }
  return value.trim()
}

function isValidRepositoryName(name: string): boolean {
  return name.length > 0 && !name.includes('/') && !name.includes('\\') && !name.includes('..')
}

function resolveRepositoryPath(
  root: string,
  name: string,
  configuredPath: string | undefined,
  issues: string[],
): { absolutePath: string; path: string } | undefined {
  const candidate = configuredPath ?? `repos/${name}`
  if (isAbsolute(candidate) || candidate.split(/[\\/]/).includes('..')) {
    issues.push(`repos.${name}.path must be a relative path below repos/ and cannot contain '..'.`)
    return undefined
  }

  const reposRoot = resolve(root, 'repos')
  const absolutePath = resolve(root, candidate)
  const withinRepos = relative(reposRoot, absolutePath)
  if (
    withinRepos.length === 0 ||
    withinRepos === '..' ||
    withinRepos.startsWith(`..${sep}`) ||
    isAbsolute(withinRepos)
  ) {
    issues.push(`repos.${name}.path must resolve beneath the task root's repos/ directory.`)
    return undefined
  }

  return {
    absolutePath,
    path: relative(root, absolutePath).split(sep).join('/'),
  }
}

function isTemplateRepositorySet(repos: JsonObject): boolean {
  const entries = Object.entries(repos)
  if (entries.length !== 1 || entries[0]?.[0] !== 'example-repo') return false
  const value = entries[0][1]
  if (!isObject(value)) return false

  return (
    value.url === 'git@<host>:<group>/<repo>.git' &&
    value.branch === '<task-branch>' &&
    value.from === 'origin/<base-branch>'
  )
}
