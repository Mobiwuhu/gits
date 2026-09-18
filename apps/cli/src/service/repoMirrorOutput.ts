import type { RepoMirrorCommandOutput, RepoMirrorView } from '@gits/core'

import { formatCliTable } from './cliTable'

export function formatRepoMirrorOutput(
  output: RepoMirrorCommandOutput,
  wide = false
): string {
  if (output.mirrors.length === 0) {
    return output.ok
      ? 'No repo mirrors configured.'
      : (output.warnings?.join('\n') ?? 'Command failed.')
  }
  const summary = formatCliTable([
    ['NAME', 'PATH', 'REPOSITORY', 'SCHEDULE', 'LAST FETCH', 'NEXT FETCH'],
    ...output.mirrors.map((mirror) => [
      mirror.name,
      mirror.path,
      mirror.repositoryState,
      mirror.scheduleState,
      formatLastRun(mirror),
      formatNextFetch(mirror),
    ]),
  ])
  const details = wide
    ? output.mirrors.map((mirror) => `\n${formatDetails(mirror)}`).join('\n')
    : ''
  const errors = output.mirrors
    .filter((mirror) => mirror.error !== null)
    .map(
      (mirror) =>
        `${mirror.name}: ${mirror.error?.code}: ${mirror.error?.message}`
    )
  const warnings = output.warnings ?? []
  return [
    summary + details,
    ...errors,
    ...warnings,
    `result: ${output.ok ? 'ok' : 'partial failure'}`,
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

function formatDetails(mirror: RepoMirrorView): string {
  return formatCliTable([
    ['FIELD', 'VALUE'],
    ['name', mirror.name],
    ['path', mirror.path],
    ['fetch URL', mirror.fetchUrl],
    ['aliases', mirror.aliases.length === 0 ? '-' : mirror.aliases.join('\n')],
    ['cron', mirror.schedule?.cron ?? 'off'],
    ['fetch command', mirror.fetchCommand],
    ['backend', mirror.schedulerBackend],
    ['native job', mirror.nativeJob ?? '-'],
    ['projection', mirror.projectionPath ?? '-'],
    ['schedule state', mirror.scheduleState],
    ['scheduler message', mirror.schedulerMessage ?? '-'],
    [
      'dependents',
      mirror.dependents.length === 0 ? '-' : mirror.dependents.join('\n'),
    ],
    ['size', mirror.sizeBytes === null ? '-' : formatBytes(mirror.sizeBytes)],
  ])
}

function formatLastRun(mirror: RepoMirrorView): string {
  const run = mirror.lastRun
  return run === null ? 'never' : `${run.finishedAt} · ${run.status}`
}

function formatNextFetch(mirror: RepoMirrorView): string {
  if (mirror.schedule === null) {
    return 'off'
  }
  return mirror.nextFetchAt ?? 'unavailable'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = units[0] ?? 'KiB'
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index] ?? unit
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`
}
