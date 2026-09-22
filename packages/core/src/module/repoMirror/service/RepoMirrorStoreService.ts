import { readFile } from 'node:fs/promises'

import { Inject } from '@wendellhu/redi'
import { applyEdits, modify, parse, printParseErrorCode } from 'jsonc-parser'
import type { ParseError } from 'jsonc-parser'

import {
  IFileSystemService,
  IGitsPathService,
  RepoMirrorConfigurationError,
} from '../../../contract/index'
import type {
  IRepoMirrorStoreService,
  RepoMirrorConfiguration,
  RepoMirrorDefinition,
} from '../../../contract/index'
import { hasErrorCode } from '../../../util/index'

const defaultConfiguration: RepoMirrorConfiguration = {
  repoMirrors: [],
  repoMirrorsSettings: { maxConcurrentFetches: 4 },
  version: 1,
}

const initialContent = `{
  // 由 gits 管理的本机 Git 对象镜像。
  "version": 1,
  "repoMirrorsSettings": {
    "maxConcurrentFetches": 4,
  },
  "repoMirrors": [],
}
`

type JsonObject = Record<string, unknown>

export class RepoMirrorStoreService implements IRepoMirrorStoreService {
  constructor(
    @Inject(IGitsPathService) private readonly paths: IGitsPathService,
    @Inject(IFileSystemService) private readonly fileSystem: IFileSystemService
  ) {}

  async load(): Promise<RepoMirrorConfiguration> {
    let content: string
    try {
      content = await readFile(this.paths.config, 'utf-8')
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return defaultConfiguration
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new RepoMirrorConfigurationError(
        `Cannot read ${this.paths.config}: ${message}`
      )
    }
    return parseRepoMirrorConfiguration(content, this.paths.config)
  }

  async save(configuration: RepoMirrorConfiguration): Promise<void> {
    await this.paths.ensureLayout()
    let content = initialContent
    try {
      content = await readFile(this.paths.config, 'utf-8')
      parseRepoMirrorConfiguration(content, this.paths.config)
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error
      }
    }

    content = updateProperty(content, ['version'], configuration.version)
    content = updateProperty(
      content,
      ['repoMirrorsSettings'],
      configuration.repoMirrorsSettings
    )
    content = updateProperty(
      content,
      ['repoMirrors'],
      configuration.repoMirrors
    )
    await this.fileSystem.writeFileAtomically(this.paths.config, content)
  }
}

export function parseRepoMirrorConfiguration(
  content: string,
  source = 'config.jsonc'
): RepoMirrorConfiguration {
  const errors: ParseError[] = []
  const parsed: unknown = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  })
  if (errors.length > 0) {
    const details = errors
      .map(
        (error) =>
          `${printParseErrorCode(error.error)} at offset ${error.offset}`
      )
      .join(', ')
    throw new RepoMirrorConfigurationError(`Cannot parse ${source}: ${details}`)
  }
  if (!isObject(parsed)) {
    throw new RepoMirrorConfigurationError(`${source} must contain an object.`)
  }

  const issues: string[] = []
  const { version } = parsed
  if (version !== 1) {
    issues.push(
      typeof version === 'number' && version > 1
        ? `Unsupported config version ${version}; upgrade gits before modifying it.`
        : 'version must be 1.'
    )
  }

  const maxConcurrentFetches = parseMaximumConcurrency(
    parsed.repoMirrorsSettings,
    issues
  )
  const mirrors = parseMirrors(parsed.repoMirrors, issues)
  if (issues.length > 0) {
    throw new RepoMirrorConfigurationError(`Invalid ${source}.`, issues)
  }

  return {
    repoMirrors: mirrors,
    repoMirrorsSettings: { maxConcurrentFetches },
    version: 1,
  }
}

function parseMaximumConcurrency(value: unknown, issues: string[]): number {
  if (value === undefined) {
    return 4
  }
  if (!isObject(value)) {
    issues.push('repoMirrorsSettings must be an object.')
    return 4
  }
  const maximum = value.maxConcurrentFetches
  if (maximum === undefined) {
    return 4
  }
  if (
    !Number.isInteger(maximum) ||
    typeof maximum !== 'number' ||
    maximum < 1 ||
    maximum > 32
  ) {
    issues.push(
      'repoMirrorsSettings.maxConcurrentFetches must be an integer from 1 to 32.'
    )
    return 4
  }
  return maximum
}

function parseMirrors(
  value: unknown,
  issues: string[]
): readonly RepoMirrorDefinition[] {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    issues.push('repoMirrors must be an array.')
    return []
  }

  const mirrors: RepoMirrorDefinition[] = []
  const names = new Set<string>()
  for (const [index, item] of value.entries()) {
    const location = `repoMirrors[${index}]`
    if (!isObject(item)) {
      issues.push(`${location} must be an object.`)
      continue
    }
    const name = parseName(item.name, `${location}.name`, issues)
    const urls = parseUrls(item.urls, `${location}.urls`, issues)
    const schedule = parseSchedule(
      item.schedule,
      `${location}.schedule`,
      issues
    )
    if (name === undefined || urls === undefined) {
      continue
    }
    if (names.has(name)) {
      issues.push(`Duplicate repo mirror name '${name}'.`)
      continue
    }
    names.add(name)
    mirrors.push({
      name,
      urls,
      ...(schedule === undefined ? {} : { schedule }),
    })
  }
  return mirrors
}

function parseName(
  value: unknown,
  location: string,
  issues: string[]
): string | undefined {
  if (
    typeof value !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value)
  ) {
    issues.push(`${location} must match [a-z0-9][a-z0-9._-]{0,63}.`)
    return undefined
  }
  return value
}

function parseUrls(
  value: unknown,
  location: string,
  issues: string[]
): readonly [string, ...string[]] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${location} must be a non-empty array.`)
    return undefined
  }
  const urls: string[] = []
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      issues.push(`${location}[${index}] must be a non-empty string.`)
      continue
    }
    const url = item.trim()
    const issue = unsafeUrlIssue(url)
    if (issue !== null) {
      issues.push(`${location}[${index}] ${issue}`)
      continue
    }
    if (!urls.includes(url)) {
      urls.push(url)
    }
  }
  const [first] = urls
  return first === undefined ? undefined : [first, ...urls.slice(1)]
}

function parseSchedule(
  value: unknown,
  location: string,
  issues: string[]
): { readonly cron: string } | undefined {
  if (value === undefined) {
    return undefined
  }
  if (
    !isObject(value) ||
    typeof value.cron !== 'string' ||
    value.cron.trim().length === 0
  ) {
    issues.push(`${location}.cron must be a non-empty string.`)
    return undefined
  }
  return { cron: value.cron.trim() }
}

function unsafeUrlIssue(value: string): string | null {
  if (value.includes('\0') || /[\r\n]/u.test(value)) {
    return 'cannot contain NUL or newlines.'
  }
  if (value.startsWith('-')) {
    return 'cannot begin with a hyphen.'
  }
  if (/^https?:\/\//iu.test(value)) {
    try {
      const parsed = new URL(value)
      if (parsed.username.length > 0 || parsed.password.length > 0) {
        return 'cannot contain embedded HTTP credentials.'
      }
    } catch {
      return 'must be a valid HTTP(S) URL.'
    }
  }
  return null
}

function updateProperty(
  content: string,
  path: readonly (string | number)[],
  value: unknown
): string {
  const edits = modify(content, [...path], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  return applyEdits(content, edits)
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
