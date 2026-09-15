import { RepositoryFlag, RepositoryState } from '@gits/core'
import type { RepositoryCommandResult } from '@gits/core'

import type { CommandPresentation } from '../contract/index'
import { formatCliTable } from './cliTable'

export function formatCommandOutput(presentation: CommandPresentation): string {
  const { output } = presentation
  if (output.repos.length === 0) {
    if (presentation.diagnostic) {
      return `${presentation.diagnostic.code}: ${presentation.diagnostic.message}`
    }
    return output.ok ? 'No repositories configured.' : 'Command failed.'
  }

  const rows = output.repos.map(toRow)
  const headers = [
    'REPO',
    'EXPECTED',
    'ACTUAL',
    'WORKTREE',
    'CHECKOUT',
    'UPSTREAM',
    'STATE',
  ]
  const body = formatCliTable([headers, ...rows])
  const errors = output.repos
    .filter((repository) => repository.error)
    .map(
      (repository) =>
        `${repository.name}: ${repository.error?.code}: ${repository.error?.message}`
    )
  const mirrorNotes = output.repos.flatMap((repository) => {
    const notes: string[] = []
    if (repository.mirror !== undefined) {
      notes.push(
        `${repository.name}: cloned via repo mirror ${repository.mirror.name} (${repository.mirror.path}) · ${repository.mirror.dissociated ? 'dissociated' : 'shared objects retained'}`
      )
    }
    if (repository.mirrorFallbackReason !== undefined) {
      notes.push(
        `${repository.name}: repo mirror fallback: ${repository.mirrorFallbackReason}`
      )
    }
    return notes
  })

  return [
    body,
    ...mirrorNotes,
    ...errors,
    `result: ${output.ok ? 'ok' : 'partial failure'}`,
  ].join('\n')
}

function toRow(repository: RepositoryCommandResult): string[] {
  const dirty = repository.flags.includes(RepositoryFlag.Dirty)
    ? 'dirty'
    : 'clean'
  const state = [formatState(repository), ...repository.flags].join(', ')

  return [
    repository.name,
    repository.expected.branch,
    repository.actual.branch ?? '-',
    dirty,
    formatCheckout(repository),
    repository.actual.upstream ?? '-',
    state,
  ]
}

function formatCheckout(repository: RepositoryCommandResult): string {
  if (
    repository.state === null ||
    repository.state === RepositoryState.Missing ||
    repository.state === RepositoryState.NotGit
  ) {
    return '-'
  }

  const expected = checkoutLabel(repository.expected.checkout)
  const actual = checkoutLabel(repository.actual.checkout)
  return repository.flags.includes(RepositoryFlag.CheckoutDifferent)
    ? `${actual} != ${expected}`
    : actual
}

function checkoutLabel(checkout: readonly string[] | null): string {
  return checkout === null ? 'all' : checkout.join(', ')
}

function formatState(repository: RepositoryCommandResult): string {
  if (
    repository.state === RepositoryState.Ahead &&
    repository.actual.ahead !== null
  ) {
    return `ahead ${repository.actual.ahead}`
  }
  if (
    repository.state === RepositoryState.Behind &&
    repository.actual.behind !== null
  ) {
    return `behind ${repository.actual.behind}`
  }
  if (
    repository.state === RepositoryState.Diverged &&
    repository.actual.ahead !== null &&
    repository.actual.behind !== null
  ) {
    return `diverged ${repository.actual.ahead}/${repository.actual.behind}`
  }
  return repository.state ?? '-'
}
