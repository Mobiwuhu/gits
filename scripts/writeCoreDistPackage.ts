import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

interface CorePackage {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly description?: string
  readonly engines?: Readonly<Record<string, string>>
  readonly keywords?: readonly string[]
  readonly name: string
  readonly type?: string
  readonly version: string
}

export async function writeCoreDistPackage(coreRoot: string): Promise<void> {
  const distDirectory = resolve(coreRoot, 'dist')
  const sourcePackage = JSON.parse(
    await readFile(resolve(coreRoot, 'package.json'), 'utf-8')
  ) as CorePackage

  const distPackage = {
    ...(sourcePackage.dependencies === undefined
      ? {}
      : { dependencies: sourcePackage.dependencies }),
    ...(sourcePackage.description === undefined
      ? {}
      : { description: sourcePackage.description }),
    ...(sourcePackage.engines === undefined
      ? {}
      : { engines: sourcePackage.engines }),
    exports: {
      '.': {
        import: './index.js',
        types: './index.d.ts',
      },
    },
    ...(sourcePackage.keywords === undefined
      ? {}
      : { keywords: sourcePackage.keywords }),
    main: './index.js',
    name: sourcePackage.name,
    publishConfig: {
      access: 'public',
    },
    type: sourcePackage.type ?? 'module',
    types: './index.d.ts',
    version: sourcePackage.version,
  }

  await mkdir(distDirectory, { recursive: true })
  await cp(
    resolve(coreRoot, 'templates'),
    resolve(distDirectory, 'templates'),
    {
      recursive: true,
    }
  )
  await cp(resolve(coreRoot, 'README.md'), resolve(distDirectory, 'README.md'))
  await writeFile(
    resolve(distDirectory, 'package.json'),
    `${JSON.stringify(distPackage, null, 2)}\n`
  )
}
