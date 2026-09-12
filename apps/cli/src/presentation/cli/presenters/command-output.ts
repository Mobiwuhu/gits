import type { CommandOutput, RepositoryCommandResult } from '../../../domain/task/model.js'
import { formatCliTable } from './cli-table.js'

export interface CommandPresentation {
  readonly diagnostic?: { readonly code: string; readonly message: string }
  readonly exitCode: number
  readonly output: CommandOutput
}

export function formatCommandOutput(presentation: CommandPresentation): string {
  const { output } = presentation
  if (output.repos.length === 0) {
    if (presentation.diagnostic) {
      return `${presentation.diagnostic.code}: ${presentation.diagnostic.message}`
    }
    return output.ok ? 'No repositories configured.' : 'Command failed.'
  }

  const rows = output.repos.map(toRow)
  const headers = ['REPO', 'EXPECTED', 'ACTUAL', 'WORKTREE', 'CHECKOUT', 'UPSTREAM', 'STATE']
  const body = formatCliTable([headers, ...rows])
  const errors = output.repos
    .filter((repository) => repository.error)
    .map(
      (repository) => `${repository.name}: ${repository.error?.code}: ${repository.error?.message}`,
    )
  const mirrorNotes = output.repos.flatMap((repository) => {
    const notes: string[] = []
    if (repository.mirror !== undefined) {
      notes.push(
        `${repository.name}: cloned via repo mirror ${repository.mirror.name} (${repository.mirror.path}) · ${repository.mirror.dissociated ? 'dissociated' : 'shared objects retained'}`,
      )
    }
    if (repository.mirrorFallbackReason !== undefined) {
      notes.push(`${repository.name}: repo mirror fallback: ${repository.mirrorFallbackReason}`)
    }
    return notes
  })

  return [body, ...mirrorNotes, ...errors, `result: ${output.ok ? 'ok' : 'partial failure'}`].join(
    '\n',
  )
}

function toRow(repository: RepositoryCommandResult): string[] {
  const dirty = repository.flags.includes('dirty') ? 'dirty' : 'clean'
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
    repository.state === 'missing' ||
    repository.state === 'not-git'
  ) {
    return '-'
  }

  const expected = checkoutLabel(repository.expected.checkout)
  const actual = checkoutLabel(repository.actual.checkout)
  return repository.flags.includes('checkout-different') ? `${actual} != ${expected}` : actual
}

function checkoutLabel(checkout: readonly string[] | null): string {
  return checkout === null ? 'all' : checkout.join(', ')
}

function formatState(repository: RepositoryCommandResult): string {
  if (repository.state === 'ahead' && repository.actual.ahead !== null) {
    return `ahead ${repository.actual.ahead}`
  }
  if (repository.state === 'behind' && repository.actual.behind !== null) {
    return `behind ${repository.actual.behind}`
  }
  if (
    repository.state === 'diverged' &&
    repository.actual.ahead !== null &&
    repository.actual.behind !== null
  ) {
    return `diverged ${repository.actual.ahead}/${repository.actual.behind}`
  }
  return repository.state ?? '-'
}
