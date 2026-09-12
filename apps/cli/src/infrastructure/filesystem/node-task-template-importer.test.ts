import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

import { JsoncTaskConfigurationStore } from '../config/jsonc-task-configuration-store.js'
import { NodeTaskTemplateImporter } from './node-task-template-importer.js'

describe('NodeTaskTemplateImporter', () => {
  it('copies source task.config.jsonc verbatim and recursively copies scripts', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-template-import-test-'))
    const source = resolve(root, 'source-task')
    const target = resolve(root, 'target-task')
    const sourceConfig = [
      '{',
      '  // This comment and formatting must survive import.',
      '  "metadata": { "owner": "platform" },',
      '  "repos": {',
      '    "api": {',
      '      "url": "git@host:team/api.git",',
      '      "branch": "fix/save-button",',
      '      "from": "origin/release/1.2",',
      '    },',
      '    "web": {',
      '      "url": "git@host:team/web.git",',
      '      "branch": "fix/save-button",',
      '      "from": "origin/main",',
      '    },',
      '  },',
      '}',
      '',
    ].join('\n')

    try {
      await mkdir(resolve(source, 'scripts/nested'), { recursive: true })
      await writeFile(resolve(source, 'task.config.jsonc'), sourceConfig)
      await writeFile(resolve(source, 'scripts/release.sh'), '#!/bin/sh\necho release\n')
      await writeFile(resolve(source, 'scripts/nested/check.sh'), '#!/bin/sh\necho check\n')

      await mkdir(target)
      const store = new JsoncTaskConfigurationStore()
      await store.createTemplate(target)
      await mkdir(resolve(target, 'scripts'))

      const imported = await new NodeTaskTemplateImporter().importTemplate(source, target)
      assert.deepEqual(
        imported.repositories.map((repository) => repository.name),
        ['api', 'web'],
      )
      assert.equal(await readFile(resolve(target, 'task.config.jsonc'), 'utf8'), sourceConfig)
      assert.equal(
        await readFile(resolve(target, 'scripts/release.sh'), 'utf8'),
        '#!/bin/sh\necho release\n',
      )
      assert.equal(
        await readFile(resolve(target, 'scripts/nested/check.sh'), 'utf8'),
        '#!/bin/sh\necho check\n',
      )
      assert.equal(await readFile(resolve(source, 'task.config.jsonc'), 'utf8'), sourceConfig)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('does not overwrite a non-placeholder target configuration', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-template-import-test-'))
    const source = resolve(root, 'source-task')
    const target = resolve(root, 'target-task')
    const sourceConfig = validConfiguration('source')
    const targetConfig = validConfiguration('target')

    try {
      await mkdir(resolve(source, 'scripts'), { recursive: true })
      await writeFile(resolve(source, 'task.config.jsonc'), sourceConfig)
      await writeFile(resolve(source, 'scripts/imported.sh'), 'echo imported\n')
      await mkdir(resolve(target, 'scripts'), { recursive: true })
      await writeFile(resolve(target, 'task.config.jsonc'), targetConfig)

      await assert.rejects(
        () => new NodeTaskTemplateImporter().importTemplate(source, target),
        /refusing to overwrite/u,
      )
      assert.equal(await readFile(resolve(target, 'task.config.jsonc'), 'utf8'), targetConfig)
      await assert.rejects(() => readFile(resolve(target, 'scripts/imported.sh'), 'utf8'))
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

function validConfiguration(name: string): string {
  return JSON.stringify({
    repos: {
      [name]: {
        url: 'git@host:team/' + name + '.git',
        branch: 'fix/save-button',
        from: 'origin/main',
      },
    },
  })
}
