import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'
import { describe, it } from 'node:test'

import { runConcurrently } from './concurrent-runner.js'

describe('runConcurrently', () => {
  it('preserves ordered results and the concurrency limit with Listr presentation enabled', async () => {
    let active = 0
    let maximumActive = 0

    const summary = await runConcurrently(
      ['alpha', 'beta', 'gamma'],
      async (item, _index, _signal, task) => {
        assert.equal(task.enabled, true)
        task.update('running')
        task.write(`${item} output\n`)
        active += 1
        maximumActive = Math.max(maximumActive, active)
        try {
          await setTimeout(item === 'alpha' ? 20 : 5)
          if (item === 'beta') throw new Error('beta failed')
          return { failed: item === 'gamma', item }
        } finally {
          active -= 1
        }
      },
      {
        concurrency: 2,
        presentation: {
          enabled: true,
          outcome: (value) =>
            value.failed
              ? { status: 'failed', message: `${value.item} failed logically` }
              : { status: 'completed' },
          title: (item) => item,
        },
      },
    )

    assert.equal(maximumActive, 2)
    assert.deepEqual(
      summary.results.map((result) => result.status),
      ['fulfilled', 'rejected', 'fulfilled'],
    )
    assert.deepEqual(
      summary.results.map((result) => result.item),
      ['alpha', 'beta', 'gamma'],
    )
  })

  it('keeps unstarted work as not-run after an external abort', async () => {
    const controller = new AbortController()
    const summary = await runConcurrently(
      ['first', 'second'],
      async (item, _index, _signal, task) => {
        assert.equal(task.enabled, false)
        controller.abort()
        return item
      },
      { concurrency: 1, signal: controller.signal },
    )

    assert.equal(summary.aborted, true)
    assert.deepEqual(
      summary.results.map((result) => result.status),
      ['fulfilled', 'not-run'],
    )
  })
})
