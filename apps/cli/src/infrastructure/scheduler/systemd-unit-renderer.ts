import type { RepoMirrorScheduledInvocation } from '../../application/ports/repo-mirror-scheduler.js'
import { calendarEntryToSystemd, type CalendarEntry } from './portable-cron.js'

export interface SystemdJob {
  readonly calendarEntries: readonly CalendarEntry[]
  readonly invocation: RepoMirrorScheduledInvocation
  readonly name: string
  readonly standardErrorPath: string
  readonly standardOutputPath: string
}

export interface SystemdUnits {
  readonly service: string
  readonly timer: string
}

export function renderSystemdUnits(job: SystemdJob): SystemdUnits {
  const command = [job.invocation.executable, ...job.invocation.arguments]
    .map(quoteSystemdValue)
    .join(' ')
  const environment = Object.entries(job.invocation.environment)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `Environment=${quoteSystemdValue(`${key}=${value}`)}`)
  const service = [
    '[Unit]',
    `Description=Fetch gits repo mirror ${escapeDescription(job.name)}`,
    'X-Gits-Managed=true',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${command}`,
    ...environment,
    `StandardOutput=append:${escapeDirectivePath(job.standardOutputPath)}`,
    `StandardError=append:${escapeDirectivePath(job.standardErrorPath)}`,
    'UMask=0077',
    '',
  ].join('\n')
  const calendars = job.calendarEntries.map(
    (entry) => `OnCalendar=${calendarEntryToSystemd(entry)}`,
  )
  const timer = [
    '[Unit]',
    `Description=Schedule gits repo mirror ${escapeDescription(job.name)}`,
    'X-Gits-Managed=true',
    '',
    '[Timer]',
    ...calendars,
    'Persistent=true',
    `Unit=${job.name}.service`,
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n')
  return { service, timer }
}

function quoteSystemdValue(value: string): string {
  assertSingleLine(value)
  return `"${value.replace(/%/gu, '%%').replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
}

function escapeDirectivePath(value: string): string {
  assertSingleLine(value)
  return value.replace(/%/gu, '%%').replace(/\\/gu, '\\\\').replace(/ /gu, '\\x20')
}

function escapeDescription(value: string): string {
  assertSingleLine(value)
  return value.replace(/%/gu, '%%')
}

function assertSingleLine(value: string): void {
  if (value.includes('\0') || /[\r\n]/u.test(value)) {
    throw new Error('Native scheduler values cannot contain NUL or newlines.')
  }
}
