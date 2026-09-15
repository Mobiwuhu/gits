import { build } from 'plist'
import type { PlistValue } from 'plist'

import type { RepoMirrorScheduledInvocation } from '../../../contract/index'
import type { CalendarEntry } from './portableCron'

export interface LaunchdJob {
  readonly calendarEntries: readonly CalendarEntry[]
  readonly invocation: RepoMirrorScheduledInvocation
  readonly label: string
  readonly standardErrorPath: string
  readonly standardOutputPath: string
}

export function renderLaunchdPlist(job: LaunchdJob): string {
  const value: PlistValue = {
    EnvironmentVariables: { ...job.invocation.environment },
    KeepAlive: false,
    Label: job.label,
    ProcessType: 'Background',
    ProgramArguments: [job.invocation.executable, ...job.invocation.arguments],
    RunAtLoad: false,
    StandardErrorPath: job.standardErrorPath,
    StandardOutPath: job.standardOutputPath,
    StartCalendarInterval: job.calendarEntries.map(toLaunchdCalendarEntry),
    ThrottleInterval: 30,
    Umask: 0o77,
  }
  return build(value, { indent: '  ', newline: '\n', pretty: true })
}

function toLaunchdCalendarEntry(entry: CalendarEntry): PlistValue {
  return {
    ...(entry.day === undefined ? {} : { Day: entry.day }),
    ...(entry.hour === undefined ? {} : { Hour: entry.hour }),
    ...(entry.minute === undefined ? {} : { Minute: entry.minute }),
    ...(entry.month === undefined ? {} : { Month: entry.month }),
    ...(entry.weekday === undefined ? {} : { Weekday: entry.weekday }),
  }
}
