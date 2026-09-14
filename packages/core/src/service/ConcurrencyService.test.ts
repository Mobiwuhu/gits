import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'
import { describe, it } from 'node:test'

import {
  ConcurrentRunStatus,
  ConcurrentTaskOutcomeStatus,
  type ConcurrentPresentation,
  type ConcurrentRunPresentation,
  type ConcurrentRunResult,
  type IConcurrencyPresentationService,
} from '../contract/index'
import { ConcurrencyService } from './ConcurrencyService'

class TestPresentationService implements IConcurrencyPresentationService {
  create<T, R>(
    _items: readonly T[],
    _concurrency: number,
    _options: ConcurrentRunPresentation<T, R>,
  ): ConcurrentPresentation<T, R> {
    return {
      finish: async () => undefined,
      reporter: () => ({ enabled: true, update: () => undefined, write: () => undefined }),
      settle: (_result: ConcurrentRunResult<T, R>) => undefined,
      start: () => undefined,
    }
  }
}

describe('ConcurrencyService', () => {
  it('preserves ordered results and the concurrency limit with presentation enabled', async () => {
    let active = 0
    let maximumActive = 0

    const summary = await new ConcurrencyService(new TestPresentationService()).run(
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
              ? {
                  status: ConcurrentTaskOutcomeStatus.Failed,
                  message: `${value.item} failed logically`,
                }
              : { status: ConcurrentTaskOutcomeStatus.Completed },
          title: (item) => item,
        },
      },
    )

    assert.equal(maximumActive, 2)
    assert.deepEqual(
      summary.results.map((result) => result.status),
      [ConcurrentRunStatus.Fulfilled, ConcurrentRunStatus.Rejected, ConcurrentRunStatus.Fulfilled],
    )
    assert.deepEqual(
      summary.results.map((result) => result.item),
      ['alpha', 'beta', 'gamma'],
    )
  })

  it('keeps unstarted work as not-run after an external abort', async () => {
    const controller = new AbortController()
    const summary = await new ConcurrencyService().run(
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
      [ConcurrentRunStatus.Fulfilled, ConcurrentRunStatus.NotRun],
    )
  })
})
