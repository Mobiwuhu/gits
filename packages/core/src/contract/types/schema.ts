import * as v from 'valibot'

export const isoDateSchema: v.GenericSchema<string> = v.pipe(
  v.string(),
  v.check((value) => {
    const timestamp = Date.parse(value)
    return (
      Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    )
  }, 'Expected a canonical ISO date')
)
