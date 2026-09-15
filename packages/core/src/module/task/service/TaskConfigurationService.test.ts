import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

import {
  isDefaultTaskConfigurationTemplate,
  parseTaskConfiguration,
  TaskConfigurationService,
} from './TaskConfigurationService'
import { TaskScaffoldService } from './TaskScaffoldService'

describe('TaskConfigurationService', () => {
  it('accepts explicit full-checkout defaults and sparse overrides', () => {
    const root = '/tmp/gits-task-config-test'
    const defaulted = parseTaskConfiguration(
      root,
      `${root}/task.config.jsonc`,
      '{"repos":{"api":{"url":"https://example.com/api.git","path":"repos/api","branch":"task","from":"origin/main","checkout":null,"dissociate":false}}}',
    )
    assert.equal(defaulted.repositories[0]?.dissociate, false)
    assert.equal(defaulted.repositories[0]?.checkout, null)
    assert.equal(defaulted.repositories[0]?.path, 'repos/api')

    const explicit = parseTaskConfiguration(
      root,
      `${root}/task.config.jsonc`,
      '{"repos":{"api":{"url":"https://example.com/api.git","branch":"task","from":"origin/main","checkout":["knowledge","docs/guides"],"dissociate":true}}}',
    )
    assert.equal(explicit.repositories[0]?.dissociate, true)
    assert.deepEqual(explicit.repositories[0]?.checkout, ['knowledge', 'docs/guides'])
  })

  it('rejects unsafe, ambiguous, empty, and duplicate checkout directories', () => {
    const root = '/tmp/gits-task-config-test'
    const repository = {
      url: 'https://example.com/api.git',
      branch: 'task',
      from: 'origin/main',
    }

    for (const checkout of [
      [],
      ['/absolute'],
      ['C:/absolute'],
      ['../outside'],
      ['docs\\guides'],
      ['docs/**'],
      ['.git/objects'],
      ['knowledge', 'knowledge'],
    ]) {
      assert.throws(
        () =>
          parseTaskConfiguration(
            root,
            `${root}/task.config.jsonc`,
            JSON.stringify({ repos: { api: { ...repository, checkout } } }),
          ),
        /Invalid task\.config\.jsonc/u,
      )
    }
  })

  it('creates the identifiable default placeholder configuration', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-config-test-'))

    try {
      await new TaskScaffoldService().ensure(root)
      const content = await readFile(resolve(root, 'task.config.jsonc'), 'utf8')
      assert.equal(isDefaultTaskConfigurationTemplate(content), true)
      for (const parameter of ['url', 'path', 'branch', 'from', 'checkout', 'dissociate']) {
        assert.match(content, new RegExp(`"${parameter}"\\s*:`))
      }
      assert.match(content, /"checkout": null/u)
      assert.match(content, /"dissociate": false/u)
      assert.match(content, /稳定的仓库名称/u)
      assert.match(content, /本地工作区路径/u)
      assert.match(content, /远端起点/u)
      assert.match(content, /工作区范围/u)
      assert.match(content, /Mirror 对象策略/u)
      assert.match(await readFile(resolve(root, 'AGENTS.md'), 'utf8'), /临时任务工作区/u)
      assert.match(await readFile(resolve(root, 'docs/AGENTS.md'), 'utf8'), /任务范围内的知识/u)
      assert.match(await readFile(resolve(root, 'scripts/AGENTS.md'), 'utf8'), /可复用自动化脚本/u)
      assert.match(await readFile(resolve(root, 'repos/AGENTS.md'), 'utf8'), /独立 Git 仓库/u)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('rejects paths that escape the task repos directory', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-config-test-'))
    const store = new TaskConfigurationService()

    try {
      await writeFile(
        resolve(root, 'task.config.jsonc'),
        JSON.stringify({
          repos: {
            api: {
              path: '../outside',
              url: 'git@host:team/api.git',
              branch: 'feat/api',
              from: 'origin/main',
            },
          },
        }),
      )

      await assert.rejects(() => store.load(root), /Invalid task\.config\.jsonc/u)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
