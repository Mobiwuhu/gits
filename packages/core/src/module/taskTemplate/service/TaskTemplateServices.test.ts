import assert from 'node:assert/strict'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

import {
  GitsError,
  TaskDirectoryEntryKind,
  TaskDirectorySourcePolicy,
} from '../../../contract/index'
import { GitsPathService } from '../../../service/GitsPathService'
import { canonicalizePath } from '../../../util/index'
import { TaskDirectoryMaterializationService } from '../../task/service/TaskDirectoryMaterializationService'
import { TaskScaffoldService } from '../../task/service/TaskScaffoldService'
import { ListTaskTemplateService } from './ListTaskTemplateService'
import { TaskDirectorySourcePlanService } from './TaskDirectorySourcePlanService'
import { assertTaskTemplateName } from './taskTemplateHelpers'
import { TaskTemplateLockService } from './TaskTemplateLockService'
import { TaskTemplateSnapshotService } from './TaskTemplateSnapshotService'
import { TaskTemplateStoreService } from './TaskTemplateStoreService'

void describe('task template services', () => {
  void it('enforces canonical local template names', () => {
    for (const name of [
      'a',
      'fullstack',
      'team-default',
      'v2',
      'a'.repeat(63),
    ]) {
      assert.doesNotThrow(() => assertTaskTemplateName(name))
    }
    for (const name of [
      '',
      'default',
      '-leading',
      'trailing-',
      'Uppercase',
      'two words',
      '../escape',
      'a'.repeat(64),
    ]) {
      assert.throws(() => assertTaskTemplateName(name), GitsError)
    }
    assert.doesNotThrow(() =>
      assertTaskTemplateName('default', { allowDefault: true })
    )
  })

  void it('applies parent, nested, negated, and fixed exclusion rules', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-source-plan-test-'))
    const source = resolve(root, 'source')
    const plans = new TaskDirectorySourcePlanService()

    try {
      await mkdir(resolve(root, '.git'))
      await mkdir(resolve(source, 'nested/.git'), { recursive: true })
      await mkdir(resolve(source, 'repos/application/.git'), {
        recursive: true,
      })
      await writeFile(
        resolve(root, '.gitignore'),
        ['source/parent-ignored.txt', ''].join('\n')
      )
      await writeFile(
        resolve(source, '.gitignore'),
        [
          '*.tmp',
          '!keep.tmp',
          '!repos/application/**',
          '!nested/.git/**',
          '',
        ].join('\n')
      )
      await writeFile(resolve(source, 'parent-ignored.txt'), 'ignored\n')
      await writeFile(resolve(source, 'drop.tmp'), 'ignored\n')
      await writeFile(resolve(source, 'keep.tmp'), 'selected\n')
      await writeFile(resolve(source, '.hidden'), 'selected\n')
      await writeFile(resolve(source, 'nested/.git/HEAD'), 'forbidden\n')
      await writeFile(resolve(source, 'repos/AGENTS.md'), 'required\n')
      await writeFile(resolve(source, 'repos/application/package.json'), '{}\n')
      await writeFile(
        resolve(source, 'repos/application/.git/HEAD'),
        'forbidden\n'
      )
      await writeFile(resolve(source, '.gits-template-leftover'), 'ignored\n')

      const plan = await plans.plan(
        source,
        TaskDirectorySourcePolicy.NamedTemplate,
        {
          allowedRepositoryPaths: ['repos', 'repos/AGENTS.md'],
        }
      )
      const selected = plan.entries.map((entry) => entry.relativePath)
      assert.equal(selected.includes('.gitignore'), true)
      assert.equal(selected.includes('.hidden'), true)
      assert.equal(selected.includes('keep.tmp'), true)
      assert.equal(selected.includes('repos'), true)
      assert.equal(selected.includes('repos/AGENTS.md'), true)
      assert.equal(selected.includes('drop.tmp'), false)
      assert.equal(selected.includes('parent-ignored.txt'), false)
      assert.equal(
        selected.some((path) => path.includes('/.git')),
        false
      )
      assert.equal(
        selected.some((path) => path.startsWith('repos/application')),
        false
      )
      assert.equal(selected.includes('.gits-template-leftover'), false)

      const oneOff = await plans.plan(
        source,
        TaskDirectorySourcePolicy.OneOffImport
      )
      assert.equal(
        oneOff.entries.some((entry) => entry.relativePath === 'repos'),
        false
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('accepts safe internal symlinks and rejects escaping links', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-template-link-test-'))
    const plans = new TaskDirectorySourcePlanService()

    try {
      await writeFile(resolve(root, 'target.txt'), 'target\n')
      await symlink('target.txt', resolve(root, 'safe-link'))
      const safe = await plans.plan(
        root,
        TaskDirectorySourcePolicy.OneOffImport
      )
      assert.equal(
        safe.entries.find((entry) => entry.relativePath === 'safe-link')
          ?.linkTarget,
        'target.txt'
      )

      await symlink('../outside.txt', resolve(root, 'escaping-link'))
      await assert.rejects(
        plans.plan(root, TaskDirectorySourcePolicy.OneOffImport),
        hasErrorCode('template-entry-invalid')
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('copies stored snapshots exactly without reapplying their .gitignore', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-stored-plan-test-'))
    const plans = new TaskDirectorySourcePlanService()

    try {
      await writeFile(resolve(root, '.gitignore'), 'selected.txt\n')
      await writeFile(resolve(root, 'selected.txt'), 'snapshot content\n')
      const captured = await plans.plan(
        root,
        TaskDirectorySourcePolicy.NamedTemplate
      )
      assert.equal(
        captured.entries.some((entry) => entry.relativePath === 'selected.txt'),
        false
      )

      const stored = await plans.plan(
        root,
        TaskDirectorySourcePolicy.StoredTemplate
      )
      assert.equal(
        stored.entries.some((entry) => entry.relativePath === 'selected.txt'),
        true
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('canonicalizes symlinked ancestors for prospective paths', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-canonical-path-test-'))
    const actual = resolve(root, 'actual')
    const alias = resolve(root, 'alias')

    try {
      await mkdir(actual)
      await symlink('actual', alias)
      assert.equal(
        await canonicalizePath(resolve(alias, 'future/task')),
        resolve(await canonicalizePath(actual), 'future/task')
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('requires the complete effective scaffold and reports all missing paths', async () => {
    const root = await mkdtemp(
      resolve(tmpdir(), 'gits-template-scaffold-test-')
    )
    const source = resolve(root, 'source')
    const scaffold = new TaskScaffoldService()
    const snapshots = new TaskTemplateSnapshotService(
      new TaskDirectorySourcePlanService(),
      scaffold
    )

    try {
      await scaffold.ensure(source)
      await rm(resolve(source, 'docs/AGENTS.md'))
      await rm(resolve(source, 'scripts/AGENTS.md'))
      await assert.rejects(
        snapshots.capture({
          createdWith: 'test',
          name: 'incomplete',
          sourceRoot: source,
        }),
        (error: unknown) =>
          hasErrorCode('template-scaffold-incomplete')(error) &&
          error instanceof Error &&
          error.message.includes('docs/AGENTS.md') &&
          error.message.includes('scripts/AGENTS.md')
      )

      await scaffold.ensure(source)
      await writeFile(
        resolve(source, '.gitignore'),
        ['docs/*', '!docs/keep.md', ''].join('\n')
      )
      await writeFile(resolve(source, 'docs/keep.md'), 'kept\n')
      await assert.rejects(
        snapshots.capture({
          createdWith: 'test',
          name: 'ignored',
          sourceRoot: source,
        }),
        hasErrorCode('template-scaffold-ignored')
      )

      await writeFile(
        resolve(source, '.gitignore'),
        ['docs/*', '!docs/AGENTS.md', '!docs/keep.md', ''].join('\n')
      )
      const captured = await snapshots.capture({
        createdWith: 'test',
        name: 'complete',
        sourceRoot: source,
      })
      assert.equal(
        captured.entries.some(
          (entry) => entry.relativePath === 'docs/AGENTS.md'
        ),
        true
      )
      assert.equal(
        captured.entries.some((entry) => entry.relativePath === 'docs/keep.md'),
        true
      )

      await writeFile(resolve(source, 'task.config.jsonc'), '{ invalid jsonc')
      await assert.rejects(
        snapshots.capture({
          createdWith: 'test',
          name: 'invalid-config',
          sourceRoot: source,
        }),
        hasErrorCode('template-content-invalid')
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('produces deterministic snapshots and detects stored-content tampering', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-template-digest-test-'))
    const first = resolve(root, 'first')
    const second = resolve(root, 'second')
    const stored = resolve(root, 'stored')
    const scaffold = new TaskScaffoldService()
    const snapshots = new TaskTemplateSnapshotService(
      new TaskDirectorySourcePlanService(),
      scaffold
    )

    try {
      await scaffold.ensure(first)
      await scaffold.ensure(second)
      await writeFile(resolve(first, 'custom.bin'), Buffer.from([0, 1, 2, 255]))
      await writeFile(
        resolve(second, 'custom.bin'),
        Buffer.from([0, 1, 2, 255])
      )
      await writeFile(resolve(first, 'run.sh'), '#!/bin/sh\n')
      await writeFile(resolve(second, 'run.sh'), '#!/bin/sh\n')
      await chmod(resolve(first, 'run.sh'), 0o755)
      await chmod(resolve(second, 'run.sh'), 0o755)

      const firstCapture = await snapshots.capture({
        createdWith: 'test',
        name: 'stable',
        sourceRoot: first,
      })
      const secondCapture = await snapshots.capture({
        createdWith: 'test',
        name: 'stable-copy',
        sourceRoot: second,
      })
      assert.equal(
        firstCapture.manifest.content.digest,
        secondCapture.manifest.content.digest
      )

      await snapshots.write(firstCapture, stored)
      const loaded = await snapshots.read(stored, 'stable')
      assert.equal(
        loaded.manifest.content.digest,
        firstCapture.manifest.content.digest
      )
      const manifestPath = resolve(stored, 'manifest.json')
      const manifest = await readFile(manifestPath, 'utf-8')
      const invalidManifest = manifest.replace(
        /"fileCount": \d+/u,
        '"fileCount": -1'
      )
      assert.notEqual(invalidManifest, manifest)
      await writeFile(manifestPath, invalidManifest)
      await assert.rejects(
        snapshots.read(stored, 'stable'),
        hasErrorCode('template-integrity-failed')
      )
      await writeFile(manifestPath, manifest)

      await mkdir(resolve(stored, 'content/repos/application'))
      await writeFile(
        resolve(stored, 'content/repos/application/package.json'),
        '{}\n'
      )
      await assert.rejects(
        snapshots.read(stored, 'stable'),
        (error: unknown) =>
          hasErrorCode('template-integrity-failed')(error) &&
          error instanceof Error &&
          error.message.includes('forbidden snapshot content')
      )
      await rm(resolve(stored, 'content/repos/application'), {
        recursive: true,
      })
      await writeFile(resolve(stored, 'content/AGENTS.md'), 'tampered\n')
      await assert.rejects(
        snapshots.read(stored, 'stable'),
        hasErrorCode('template-integrity-failed')
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('lists damaged local templates as unhealthy without failing the list', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-template-list-test-'))
    const paths = new GitsPathService({
      environment: { GITS_HOME: resolve(root, 'home') },
    })
    const snapshots = new TaskTemplateSnapshotService(
      new TaskDirectorySourcePlanService(),
      new TaskScaffoldService()
    )
    const store = new TaskTemplateStoreService(paths, snapshots)
    const list = new ListTaskTemplateService(snapshots, store)

    try {
      await mkdir(resolve(paths.templates, 'broken'), { recursive: true })
      const output = await list.execute({ wide: true })
      assert.equal(output.ok, true)
      assert.deepEqual(
        output.templates.map((template) => [template.name, template.state]),
        [
          ['default', 'ready'],
          ['broken', 'unhealthy'],
        ]
      )
      assert.equal(
        output.templates[1]?.error?.code,
        'template-integrity-failed'
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('returns busy instead of waiting for a held template lock', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-template-lock-test-'))
    const paths = new GitsPathService({
      environment: { GITS_HOME: resolve(root, 'home') },
    })
    const locks = new TaskTemplateLockService(paths)

    try {
      const first = await locks.acquire('locked')
      assert.notEqual(first, null)
      assert.equal(await locks.acquire('locked'), null)
      await first?.()
      const acquiredAgain = await locks.acquire('locked')
      assert.notEqual(acquiredAgain, null)
      await acquiredAgain?.()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  void it('preflights every target conflict before writing any entry', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'gits-materialize-test-'))
    const target = resolve(root, 'target')
    const materialization = new TaskDirectoryMaterializationService(
      new TaskScaffoldService()
    )

    try {
      await mkdir(target)
      await writeFile(resolve(target, 'conflict.txt'), 'user content\n')
      await assert.rejects(
        materialization.materialize({
          dryRun: false,
          entries: [
            {
              content: 'new\n',
              kind: TaskDirectoryEntryKind.File,
              mode: 0o644,
              relativePath: 'created-before-conflict.txt',
            },
            {
              content: 'replacement\n',
              kind: TaskDirectoryEntryKind.File,
              mode: 0o644,
              relativePath: 'conflict.txt',
            },
          ],
          root: target,
        }),
        hasErrorCode('template-target-conflict')
      )
      await assert.rejects(async () =>
        access(resolve(target, 'created-before-conflict.txt'))
      )
      assert.equal(
        await readFile(resolve(target, 'conflict.txt'), 'utf-8'),
        'user content\n'
      )

      await writeFile(resolve(target, 'empty-user-file.txt'), '')
      await assert.rejects(
        materialization.materialize({
          dryRun: false,
          entries: [
            {
              content: 'replacement\n',
              kind: TaskDirectoryEntryKind.File,
              mode: 0o644,
              relativePath: 'empty-user-file.txt',
            },
          ],
          root: target,
        }),
        hasErrorCode('template-target-conflict')
      )
      assert.equal(
        await readFile(resolve(target, 'empty-user-file.txt'), 'utf-8'),
        ''
      )

      await materialization.materialize({
        dryRun: true,
        entries: [
          {
            content: 'preview\n',
            kind: TaskDirectoryEntryKind.File,
            mode: 0o644,
            relativePath: 'preview.txt',
          },
        ],
        root: resolve(root, 'dry-run-target'),
      })
      await assert.rejects(async () => access(resolve(root, 'dry-run-target')))
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

function hasErrorCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof GitsError && error.code === code
}
