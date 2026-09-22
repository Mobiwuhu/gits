import type { TaskTemplateCommandOutput, TaskTemplateView } from '@usegits/core'

import { formatCliTable } from './cliTable'

export function formatTaskTemplateOutput(
  output: TaskTemplateCommandOutput,
  wide = false
): string {
  if (output.templates.length === 0) {
    return output.warnings?.join('\n') ?? 'No task templates found.'
  }
  const table = wide
    ? formatCliTable([
        [
          'NAME',
          'KIND',
          'STATE',
          'ACTION',
          'FILES',
          'BYTES',
          'UPDATED',
          'DIGEST',
          'PATH',
        ],
        ...output.templates.map(wideRow),
      ])
    : formatCliTable([
        ['NAME', 'KIND', 'STATE', 'UPDATED', 'FILES'],
        ...output.templates.map((template) => [
          template.name,
          template.kind,
          template.state,
          template.updatedAt ?? `gits ${template.createdWith}`,
          formatNullableNumber(template.fileCount),
        ]),
      ])
  const errors = output.templates.flatMap((template) =>
    template.error === null
      ? []
      : [`${template.name}: ${template.error.code}: ${template.error.message}`]
  )
  return [
    table,
    ...errors,
    ...(output.warnings ?? []),
    `result: ${output.ok ? 'ok' : 'failure'}`,
  ].join('\n')
}

function wideRow(template: TaskTemplateView): readonly string[] {
  return [
    template.name,
    template.kind,
    template.state,
    template.action,
    formatNullableNumber(template.fileCount),
    formatNullableNumber(template.byteCount),
    template.updatedAt ?? '-',
    template.digest ?? '-',
    template.path ?? '-',
  ]
}

function formatNullableNumber(number: number | null): string {
  return number === null ? '-' : String(number)
}
