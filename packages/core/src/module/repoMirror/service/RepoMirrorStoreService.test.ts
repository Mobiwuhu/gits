import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

import { FileSystemService, GitsPathService } from '../../../service/index'
import { RepoMirrorStoreService, parseRepoMirrorConfiguration } from './RepoMirrorStoreService'

describe('RepoMirrorStoreService', () => {
  it('preserves comments and unrelated machine settings while updating managed fields', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-mirror-config-test-'))
    const paths = new GitsPathService({ environment: { GITS_HOME: resolve(root, '.gits') } })
    try {
      await mkdir(paths.home, { recursive: true })
      await writeFile(
        paths.config,
        `{
  // Keep this user-authored note.
  "version": 1,
  "unrelated": { "keep": true },
  "repoMirrors": [],
}
`,
      )

      const store = new RepoMirrorStoreService(paths, new FileSystemService())
      await store.save({
        repoMirrors: [
          {
            name: 'api',
            schedule: { cron: '17 1-23/6 * * *' },
            urls: ['git@example.com:team/api.git', 'https://example.com/team/api.git'],
          },
        ],
        repoMirrorsSettings: { maxConcurrentFetches: 7 },
        version: 1,
      })

      const content = await readFile(paths.config, 'utf8')
      assert.match(content, /Keep this user-authored note/u)
      assert.match(content, /"unrelated": \{ "keep": true \}/u)
      assert.equal((await stat(paths.config)).mode & 0o777, 0o600)
      assert.deepEqual(await store.load(), {
        repoMirrors: [
          {
            name: 'api',
            schedule: { cron: '17 1-23/6 * * *' },
            urls: ['git@example.com:team/api.git', 'https://example.com/team/api.git'],
          },
        ],
        repoMirrorsSettings: { maxConcurrentFetches: 7 },
        version: 1,
      })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('rejects malformed, unsafe, and newer configuration instead of overwriting it', () => {
    assert.throws(
      () => parseRepoMirrorConfiguration('{"version":2,"repoMirrors":[]}'),
      /Unsupported config version 2/u,
    )
    assert.throws(
      () =>
        parseRepoMirrorConfiguration(
          '{"version":1,"repoMirrors":[{"name":"api","urls":["https://user:secret@example.com/api.git"]}]}',
        ),
      /embedded HTTP credentials/u,
    )
    assert.throws(() => parseRepoMirrorConfiguration('{'), /Cannot parse/u)
  })
})
