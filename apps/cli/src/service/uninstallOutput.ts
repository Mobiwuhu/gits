import type { GitsUninstallOutput } from '@gits/core'

import { formatCliTable } from './cliTable'

export function formatUninstallOutput(output: GitsUninstallOutput): string {
  const targets = formatCliTable([
    ['SCOPE', 'TYPE', 'STATE', 'PATH'],
    ...output.targets.map((target) => [
      target.scope,
      target.kind,
      target.exists ? 'present' : 'absent',
      target.path,
    ]),
  ])
  const mirrors =
    output.mirrors.length === 0
      ? ''
      : formatCliTable([
          ['MIRROR', 'DEPENDENTS', 'PATH'],
          ...output.mirrors.map((mirror) => [
            mirror.name,
            String(mirror.dependents.length),
            mirror.path,
          ]),
        ])
  const removed = output.removedPaths.map((path) => `removed: ${path}`)
  const warnings = output.warnings.map((warning) => `warning: ${warning}`)
  const result = output.dryRun
    ? 'dry-run: no files were changed'
    : `result: ${output.ok ? 'uninstalled' : 'partial failure'}`
  return [targets, mirrors, ...removed, ...warnings, result]
    .filter((line) => line.length > 0)
    .join('\n')
}
