export function uniqueStrings(values: readonly string[]): string[] {
  return [
    ...new Set(
      values.map((value) => value.trim()).filter((value) => value.length > 0)
    ),
  ]
}
