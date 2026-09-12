import { getBorderCharacters, table } from 'table'

export function formatCliTable(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return ''
  return table(
    rows.map((row) => [...row]),
    {
      border: getBorderCharacters('void'),
      columnDefault: { paddingLeft: 0, paddingRight: 2, wrapWord: true },
      drawHorizontalLine: () => false,
    },
  ).trimEnd()
}
