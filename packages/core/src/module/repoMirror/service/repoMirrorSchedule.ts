import { createHash } from 'node:crypto'

import { CronExpressionParser } from 'cron-parser'

import { RepoMirrorUsageError } from '../../../contract/index'
import type { RepoMirrorSchedule } from '../../../contract/index'

const portableField =
  /^(?:\*|\d+)(?:-(?:\d+))?(?:\/(?:\d+))?(?:,(?:\*|\d+)(?:-(?:\d+))?(?:\/(?:\d+))?)*$/u

export function createAutomaticSchedule(
  installationId: string,
  identity: string
): RepoMirrorSchedule {
  const minute = hashNumber(installationId, identity, 'minute') % 60
  const hour = hashNumber(installationId, identity, 'hour') % 6
  return { cron: `${minute} ${hour}-23/6 * * *` }
}

export function parseScheduleOption(
  value: string,
  installationId: string,
  identity: string
): RepoMirrorSchedule | null {
  const schedule = value.trim()
  if (schedule === 'off') {
    return null
  }
  if (schedule === 'auto') {
    return createAutomaticSchedule(installationId, identity)
  }
  validatePortableCron(schedule)
  return { cron: schedule }
}

export function validatePortableCron(value: string): void {
  const fields = value.trim().split(/\s+/u)
  if (fields.length !== 5) {
    throw new RepoMirrorUsageError(
      'Schedule must be auto, off, or a five-field cron expression.'
    )
  }
  if (!fields.every((field) => portableField.test(field))) {
    throw new RepoMirrorUsageError(
      'Cron supports only numbers, *, lists, ranges, and steps in five fields.'
    )
  }
  try {
    CronExpressionParser.parse(value)
  } catch (error) {
    throw new RepoMirrorUsageError(
      `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export function nextScheduledDate(
  cron: string,
  currentDate: Date = new Date()
): Date | null {
  try {
    return CronExpressionParser.parse(cron, { currentDate }).next().toDate()
  } catch {
    return null
  }
}

function hashNumber(...parts: readonly string[]): number {
  const digest = createHash('sha256').update(parts.join('\0')).digest()
  return digest.readUInt32BE(0)
}
