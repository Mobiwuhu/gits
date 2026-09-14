import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

export interface IFileSystemService {
  directorySize(path: string): Promise<number | null>
  writeFileAtomically(path: string, content: string, mode?: number): Promise<void>
}

export const IFileSystemService: IdentifierDecorator<IFileSystemService> =
  createIdentifier<IFileSystemService>('core.fileSystemService')
