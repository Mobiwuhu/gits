import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { compareGitUrls, normalizeGitUrl } from './gitUrl'

describe('Git remote identity', () => {
  it('treats SSH and HTTPS transports for the same host and path as one repository', () => {
    const comparison = compareGitUrls(
      'git@github.com:wevm/incur.git',
      'https://github.com/wevm/incur',
    )

    assert.equal(comparison.isSameRepository, true)
    assert.equal(comparison.isTransportDifferent, true)
  })

  it('normalizes file remotes so local integration repositories have stable identity', () => {
    assert.deepEqual(normalizeGitUrl('file:///tmp/task/origin.git'), {
      host: 'file',
      path: 'tmp/task/origin',
    })
  })
})
