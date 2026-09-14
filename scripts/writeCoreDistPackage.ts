import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

interface CorePackage {
  readonly name: string
  readonly version: string
  readonly private?: boolean
  readonly type?: string
  readonly dependencies?: Readonly<Record<string, string>>
}

export async function writeCoreDistPackage(coreRoot: string): Promise<void> {
  const distDirectory = resolve(coreRoot, 'dist')
  const sourcePackage = JSON.parse(
    await readFile(resolve(coreRoot, 'package.json'), 'utf8'),
  ) as CorePackage

  const distPackage = {
    name: sourcePackage.name,
    version: sourcePackage.version,
    ...(sourcePackage.private === undefined ? {} : { private: sourcePackage.private }),
    type: sourcePackage.type ?? 'module',
    main: './index.js',
    types: './index.d.ts',
    exports: {
      '.': {
        types: './index.d.ts',
        import: './index.js',
      },
    },
    ...(sourcePackage.dependencies === undefined
      ? {}
      : { dependencies: sourcePackage.dependencies }),
  }

  await mkdir(distDirectory, { recursive: true })
  await cp(resolve(coreRoot, 'templates'), resolve(distDirectory, 'templates'), {
    recursive: true,
  })
  await writeFile(
    resolve(distDirectory, 'package.json'),
    `${JSON.stringify(distPackage, null, 2)}\n`,
  )
}
