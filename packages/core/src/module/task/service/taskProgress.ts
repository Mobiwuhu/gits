import type {
  RepositoryProgress,
  RepositoryProgressReporter,
} from '../../../contract/index'

export function reportProgress(
  reporter: RepositoryProgressReporter | undefined,
  progress: RepositoryProgress
): void {
  try {
    reporter?.(progress)
  } catch {
    // 进度渲染不能改变仓库操作的结果。
  }
}
