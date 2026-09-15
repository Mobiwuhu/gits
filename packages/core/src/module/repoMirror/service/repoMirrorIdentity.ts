import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

import { RepoMirrorUsageError } from '../../../contract/index'
import type { IRepoMirrorGitService } from '../../../contract/index'
import { normalizeGitUrl } from '../../../service/gitUrl'
import type { GitUrlIdentity } from '../../../service/gitUrl'

export interface ResolvedRepoMirrorUrl {
  readonly identity: GitUrlIdentity
  readonly key: string
  readonly original: string
  readonly resolved: string
}

export async function resolveRepoMirrorUrl(
  gateway: IRepoMirrorGitService,
  value: string
): Promise<ResolvedRepoMirrorUrl> {
  const original = value.trim()
  const expanded = (await gateway.resolveRemoteUrl(original)) ?? original
  const normalizedInput = isAbsolute(expanded)
    ? pathToFileURL(expanded).href
    : expanded
  const identity = normalizeGitUrl(normalizedInput)
  if (identity === null) {
    throw new RepoMirrorUsageError(
      `Cannot identify Git repository URL: ${value}`
    )
  }
  return {
    identity,
    key: `${identity.host}/${identity.path}`,
    original,
    resolved: expanded,
  }
}

export function deriveRepoMirrorName(identity: GitUrlIdentity): string {
  const base =
    identity.path.split('/').findLast((segment) => segment.length > 0) ??
    'repository'
  const normalized = base
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[^a-z0-9]+/u, '')
    .slice(0, 64)
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(normalized)) {
    throw new RepoMirrorUsageError(
      'Cannot derive a safe mirror name; pass --name explicitly.'
    )
  }
  return normalized
}

export function validateRepoMirrorName(name: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(name)) {
    throw new RepoMirrorUsageError(
      "Mirror name must match '[a-z0-9][a-z0-9._-]{0,63}'."
    )
  }
}
