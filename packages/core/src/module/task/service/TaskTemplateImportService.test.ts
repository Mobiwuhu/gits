import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

import { TaskScaffoldService } from './TaskScaffoldService'
import { TaskTemplateImportService } from './TaskTemplateImportService'

describe('TaskTemplateImportService', () => {
  it('copies the task template and supported project-level agent configuration', async () => {
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
    const agentFiles = [
      ['.agents/skills/shared/SKILL.md', 'shared skill\n'],
      ['.codex/hooks/preCommit.sh', 'codex hook\n'],
      ['.claude/skills/review/SKILL.md', 'claude skill\n'],
      ['.gemini/hooks/afterTool.sh', 'gemini hook\n'],
      ['.grok/skills/debug/SKILL.md', 'grok skill\n'],
      ['.cursor/hooks.json', '{"version":1}\n'],
      ['.pi/skills/refactor/SKILL.md', 'pi skill\n'],
    ] as const

    try {
      await mkdir(resolve(source, 'scripts/nested'), { recursive: true })
      await mkdir(resolve(source, 'docs'), { recursive: true })
      await writeFile(resolve(source, 'task.config.jsonc'), sourceConfig)
      await writeFile(resolve(source, 'scripts/release.sh'), '#!/bin/sh\necho release\n')
      await writeFile(resolve(source, 'scripts/nested/check.sh'), '#!/bin/sh\necho check\n')
      await writeFile(resolve(source, 'scripts/AGENTS.md'), 'script instructions\n')
      await writeFile(resolve(source, 'AGENTS.md'), 'task instructions\n')
      await writeFile(resolve(source, 'docs/AGENTS.md'), 'documentation instructions\n')
      await writeFile(resolve(source, 'docs/notImported.md'), 'ordinary documentation\n')
      await writeFile(resolve(source, 'CLAUDE.md'), 'claude instructions\n')
      await writeFile(resolve(source, 'GEMINI.md'), 'gemini instructions\n')
      await writeFile(resolve(source, '.cursorrules'), 'cursor rules\n')
      for (const [path, content] of agentFiles) {
        await mkdir(resolve(source, path, '..'), { recursive: true })
        await writeFile(resolve(source, path), content)
      }

      await mkdir(target)
      await new TaskScaffoldService().ensure(target)

      const imported = await new TaskTemplateImportService().importTemplate(source, target)
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
      assert.equal(
        await readFile(resolve(target, 'scripts/AGENTS.md'), 'utf8'),
        'script instructions\n',
      )
      assert.equal(await readFile(resolve(target, 'AGENTS.md'), 'utf8'), 'task instructions\n')
      assert.equal(
        await readFile(resolve(target, 'docs/AGENTS.md'), 'utf8'),
        'documentation instructions\n',
      )
      await assert.rejects(() => readFile(resolve(target, 'docs/notImported.md'), 'utf8'))
      assert.equal(await readFile(resolve(target, 'CLAUDE.md'), 'utf8'), 'claude instructions\n')
      assert.equal(await readFile(resolve(target, 'GEMINI.md'), 'utf8'), 'gemini instructions\n')
      assert.equal(await readFile(resolve(target, '.cursorrules'), 'utf8'), 'cursor rules\n')
      for (const [path, content] of agentFiles) {
        assert.equal(await readFile(resolve(target, path), 'utf8'), content)
      }
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
        () => new TaskTemplateImportService().importTemplate(source, target),
        /refusing to overwrite/u,
      )
      assert.equal(await readFile(resolve(target, 'task.config.jsonc'), 'utf8'), targetConfig)
      await assert.rejects(() => readFile(resolve(target, 'scripts/imported.sh'), 'utf8'))
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('does not overwrite existing target agent configuration', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-template-import-test-'))
    const source = resolve(root, 'source-task')
    const target = resolve(root, 'target-task')

    try {
      await mkdir(resolve(source, '.claude'), { recursive: true })
      await writeFile(resolve(source, 'task.config.jsonc'), validConfiguration('source'))
      await writeFile(resolve(source, '.claude/settings.json'), '{"source":true}\n')
      await new TaskScaffoldService().ensure(target)
      await mkdir(resolve(target, '.claude'), { recursive: true })
      await writeFile(resolve(target, '.claude/settings.json'), '{"target":true}\n')

      await assert.rejects(
        () => new TaskTemplateImportService().importTemplate(source, target),
        /Target \.claude already exists/u,
      )
      assert.equal(
        await readFile(resolve(target, '.claude/settings.json'), 'utf8'),
        '{"target":true}\n',
      )
      assert.equal(
        isDefaultConfiguration(await readFile(resolve(target, 'task.config.jsonc'), 'utf8')),
        true,
      )
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

function isDefaultConfiguration(content: string): boolean {
  return content.includes('git@<host>:<group>/<repo>.git')
}
