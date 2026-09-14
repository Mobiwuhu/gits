import { RepoMirrorUsageError } from '../../../contract/index'
import { validatePortableCron } from './repoMirrorSchedule'

export interface CalendarEntry {
  readonly day?: number
  readonly hour?: number
  readonly minute?: number
  readonly month?: number
  readonly weekday?: number
}

export function compileCalendarEntries(cron: string): readonly CalendarEntry[] {
  validatePortableCron(cron)
  const fields = cron.trim().split(/\s+/u)
  const minute = expandField(fields[0] as string, 0, 59)
  const hour = expandField(fields[1] as string, 0, 23)
  const day = expandField(fields[2] as string, 1, 31)
  const month = expandField(fields[3] as string, 1, 12)
  const weekday = expandField(fields[4] as string, 0, 7).map((value) => (value === 7 ? 0 : value))
  const dayWildcard = fields[2] === '*'
  const weekdayWildcard = fields[4] === '*'
  const branches: readonly Readonly<{
    days: readonly (number | undefined)[]
    weekdays: readonly (number | undefined)[]
  }>[] =
    !dayWildcard && !weekdayWildcard
      ? [
          { days: day, weekdays: [undefined] },
          { days: [undefined], weekdays: uniqueNumbers(weekday) },
        ]
      : [{ days: day, weekdays: weekday }]

  const entries: CalendarEntry[] = []
  for (const branch of branches) {
    for (const monthValue of wildcardValue(month, fields[3] === '*')) {
      for (const dayValue of wildcardValue(branch.days, dayWildcard && branches.length === 1)) {
        for (const weekdayValue of wildcardValue(
          branch.weekdays,
          weekdayWildcard && branches.length === 1,
        )) {
          for (const hourValue of wildcardValue(hour, fields[1] === '*')) {
            for (const minuteValue of wildcardValue(minute, fields[0] === '*')) {
              entries.push({
                ...(dayValue === undefined ? {} : { day: dayValue }),
                ...(hourValue === undefined ? {} : { hour: hourValue }),
                ...(minuteValue === undefined ? {} : { minute: minuteValue }),
                ...(monthValue === undefined ? {} : { month: monthValue }),
                ...(weekdayValue === undefined ? {} : { weekday: weekdayValue }),
              })
              if (entries.length > 256) {
                throw new RepoMirrorUsageError(
                  'Cron expression expands to more than 256 native calendar entries.',
                )
              }
            }
          }
        }
      }
    }
  }
  return deduplicateEntries(entries)
}

export function calendarEntryToSystemd(entry: CalendarEntry): string {
  const weekday = entry.weekday === undefined ? '' : `${weekdayName(entry.weekday)} `
  const month = entry.month === undefined ? '*' : pad(entry.month)
  const day = entry.day === undefined ? '*' : pad(entry.day)
  const hour = entry.hour === undefined ? '*' : pad(entry.hour)
  const minute = entry.minute === undefined ? '*' : pad(entry.minute)
  return `${weekday}*-${month}-${day} ${hour}:${minute}:00`
}

function expandField(field: string, minimum: number, maximum: number): readonly number[] {
  const values = new Set<number>()
  for (const component of field.split(',')) {
    const [rangePart, stepPart] = component.split('/')
    const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10)
    if (!Number.isSafeInteger(step) || step < 1)
      throw new RepoMirrorUsageError('Cron step must be positive.')
    let start: number
    let end: number
    if (rangePart === '*') {
      start = minimum
      end = maximum
    } else if (rangePart?.includes('-')) {
      const [startText, endText] = rangePart.split('-')
      start = Number.parseInt(startText ?? '', 10)
      end = Number.parseInt(endText ?? '', 10)
    } else {
      start = Number.parseInt(rangePart ?? '', 10)
      end = stepPart === undefined ? start : maximum
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < minimum ||
      end > maximum ||
      start > end
    ) {
      throw new RepoMirrorUsageError(`Cron value '${component}' is outside ${minimum}-${maximum}.`)
    }
    for (let value = start; value <= end; value += step) values.add(value)
  }
  return [...values].toSorted((left, right) => left - right)
}

function wildcardValue(
  values: readonly (number | undefined)[],
  wildcard: boolean,
): readonly (number | undefined)[] {
  return wildcard ? [undefined] : values
}

function deduplicateEntries(entries: readonly CalendarEntry[]): readonly CalendarEntry[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = JSON.stringify(entry)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function uniqueNumbers(values: readonly number[]): readonly number[] {
  return [...new Set(values)]
}

function weekdayName(value: number): string {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][value] ?? 'Sun'
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
