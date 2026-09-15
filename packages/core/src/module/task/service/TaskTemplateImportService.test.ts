import assert from 'node:assert/strict'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

import { TaskScaffoldService } from './TaskScaffoldService'
import { TaskTemplateImportService } from './TaskTemplateImportService'

void describe('TaskTemplateImportService', () => {
  void it('copies every source task entry except repos', async () => {
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
    const copiedFiles = [
      ['AGENTS.md', 'task instructions\n'],
      ['docs/AGENTS.md', 'documentation instructions\n'],
      ['docs/decision.md', 'architecture decision\n'],
      ['scripts/AGENTS.md', 'script instructions\n'],
      ['scripts/release.sh', '#!/bin/sh\necho release\n'],
      ['scripts/nested/check.sh', '#!/bin/sh\necho check\n'],
      ['.agents/skills/shared/SKILL.md', 'shared skill\n'],
      ['.workspace/settings.json', '{"theme":"dark"}\n'],
      ['justfile', 'dev:\n    pnpm dev\n'],
      ['processCompose.yaml', 'version: "0.5"\n'],
    ] as const

    try {
      await mkdir(source)
      await writeFile(resolve(source, 'task.config.jsonc'), sourceConfig)
      for (const [path, content] of copiedFiles) {
        await mkdir(resolve(source, path, '..'), { recursive: true })
        await writeFile(resolve(source, path), content)
      }
      await mkdir(resolve(source, 'repos/api/.git'), { recursive: true })
      await writeFile(
        resolve(source, 'repos/AGENTS.md'),
        'source repository instructions\n'
      )
      await writeFile(
        resolve(source, 'repos/api/package.json'),
        '{"name":"api"}\n'
      )
      await writeFile(
        resolve(source, 'repos/api/.git/HEAD'),
        'ref: refs/heads/main\n'
      )

      await new TaskScaffoldService().ensure(target)

      const imported = await createTemplateImporter().importTemplate(
        source,
        target
      )
      assert.deepEqual(
        imported.repositories.map((repository) => repository.name),
        ['api', 'web']
      )
      assert.equal(
        await readFile(resolve(target, 'task.config.jsonc'), 'utf-8'),
        sourceConfig
      )
      for (const [path, content] of copiedFiles) {
        assert.equal(await readFile(resolve(target, path), 'utf-8'), content)
      }
      await assert.rejects(async () => access(resolve(target, 'repos/api')))
      assert.match(
        await readFile(resolve(target, 'repos/AGENTS.md'), 'utf-8'),
        /独立 Git 仓库/u
      )
      assert.equal(
        await readFile(resolve(source, 'task.config.jsonc'), 'utf-8'),
        sourceConfig
      )
      assert.equal(
        await readFile(resolve(source, 'repos/api/package.json'), 'utf-8'),
        '{"name":"api"}\n'
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('does not overwrite a non-placeholder target configuration', async () => {
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
        async () => createTemplateImporter().importTemplate(source, target),
        /refusing to overwrite/u
      )
      assert.equal(
        await readFile(resolve(target, 'task.config.jsonc'), 'utf-8'),
        targetConfig
      )
      await assert.rejects(async () =>
        access(resolve(target, 'scripts/imported.sh'))
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('does not overwrite customized task instructions', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-template-import-test-'))
    const source = resolve(root, 'source-task')
    const target = resolve(root, 'target-task')

    try {
      await mkdir(source)
      await writeFile(
        resolve(source, 'task.config.jsonc'),
        validConfiguration('source')
      )
      await writeFile(resolve(source, 'AGENTS.md'), 'source instructions\n')
      await new TaskScaffoldService().ensure(target)
      await writeFile(
        resolve(target, 'AGENTS.md'),
        'customized target instructions\n'
      )

      await assert.rejects(
        async () => createTemplateImporter().importTemplate(source, target),
        /Target AGENTS\.md contains non-default content/u
      )
      assert.equal(
        await readFile(resolve(target, 'AGENTS.md'), 'utf-8'),
        'customized target instructions\n'
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('does not overwrite an existing target entry with user content', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-template-import-test-'))
    const source = resolve(root, 'source-task')
    const target = resolve(root, 'target-task')

    try {
      await mkdir(resolve(source, '.workspace'), { recursive: true })
      await mkdir(resolve(source, 'docs'), { recursive: true })
      await writeFile(
        resolve(source, 'task.config.jsonc'),
        validConfiguration('source')
      )
      await writeFile(
        resolve(source, '.workspace/settings.json'),
        '{"source":true}\n'
      )
      await writeFile(resolve(source, 'docs/imported.md'), 'imported\n')
      await new TaskScaffoldService().ensure(target)
      await mkdir(resolve(target, '.workspace'), { recursive: true })
      await writeFile(
        resolve(target, '.workspace/settings.json'),
        '{"target":true}\n'
      )

      await assert.rejects(
        async () => createTemplateImporter().importTemplate(source, target),
        /Target \.workspace contains non-default content/u
      )
      assert.equal(
        await readFile(resolve(target, '.workspace/settings.json'), 'utf-8'),
        '{"target":true}\n'
      )
      await assert.rejects(async () =>
        access(resolve(target, 'docs/imported.md'))
      )
      assert.equal(
        isDefaultConfiguration(
          await readFile(resolve(target, 'task.config.jsonc'), 'utf-8')
        ),
        true
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

function createTemplateImporter(): TaskTemplateImportService {
  return new TaskTemplateImportService(new TaskScaffoldService())
}

function validConfiguration(name: string): string {
  return JSON.stringify({
    repos: {
      [name]: {
        branch: 'fix/save-button',
        from: 'origin/main',
        url: `git@host:team/${name}.git`,
      },
    },
  })
}

function isDefaultConfiguration(content: string): boolean {
  return content.includes('git@<host>:<group>/<repo>.git')
}
