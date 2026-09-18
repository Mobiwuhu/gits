#!/usr/bin/env node

import {
  gitsSchedulerWorkerEnvironmentVariable,
  IStableRunnerInstaller,
} from '@gits/core'

import { createContainer, schedulerWorkerSource } from './bootstrap/index'
import { ICliApplication } from './contract/index'

const container = createContainer(schedulerWorkerSource(import.meta.url))
try {
  if (process.env[gitsSchedulerWorkerEnvironmentVariable] !== '1') {
    try {
      await container.get(IStableRunnerInstaller).refreshIfInstalled()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `[gits] Could not refresh the installed scheduler runner: ${message}\nRun "gits repo-mirrors doctor --fix --yes" to retry.\n`
      )
    }
  }
  await container.get(ICliApplication).run(process.argv.slice(2))
} finally {
  container.dispose()
}
