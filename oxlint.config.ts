import { defineConfig } from 'oxlint'
import core from 'ultracite/oxlint/core'

export default defineConfig({
  env: {
    browser: false,
    es2024: true,
    node: true,
  },
  extends: [core],
  ignorePatterns: ['**/dist/**'],
  options: {
    typeAware: true,
  },
  overrides: [
    {
      files: ['**/contract/**/*.ts'],
      rules: {
        // ReDI 会为每个接口声明同名的运行时注入令牌。
        'no-redeclare': 'off',
        'typescript/method-signature-style': 'off',
      },
    },
    {
      files: ['apps/cli/src/**/*.ts', 'packages/core/src/**/*.ts'],
      rules: {
        // 架构检查要求注入依赖使用 readonly 构造器参数属性。
        'typescript/parameter-properties': 'off',
      },
    },
    {
      files: ['**/service/*.ts'],
      rules: {
        // Contract 的实现必须保持为实例方法，即使方法暂时不访问实例状态。
        'class-methods-use-this': 'off',
      },
    },
    {
      files: ['**/*.test.ts'],
      rules: {
        // node:test 的注册调用与测试夹具中的边界断言都是有意行为。
        'typescript/no-floating-promises': 'off',
        'typescript/no-unsafe-member-access': 'off',
        'typescript/no-unsafe-type-assertion': 'off',
        'typescript/strict-void-return': 'off',
      },
    },
    {
      files: ['apps/cli/src/**/*Command.ts'],
      rules: {
        // Incur 在 run 回调处不会保留具体命令 schema 的推导结果，需要在边界收窄。
        'typescript/no-unsafe-type-assertion': 'off',
      },
    },
    {
      files: ['apps/cli/src/contract/types/cliContext.ts'],
      rules: {
        // IncurContext 的四个泛型参数目前只能由上游的 any 占位。
        'typescript/no-explicit-any': 'off',
      },
    },
    {
      files: [
        'scripts/installGitHooks.ts',
        'scripts/runRelizy.ts',
        'scripts/verifyPackages.ts',
        'scripts/writeCoreDistPackage.ts',
      ],
      rules: {
        // util.promisify 的重载和 JSON.parse 的外部数据边界会触发 tsgolint 误报。
        'typescript/no-unsafe-type-assertion': 'off',
        'typescript/strict-void-return': 'off',
      },
    },
    {
      files: [
        'apps/cli/src/service/CliProgressService.ts',
        'packages/core/src/module/repoMirror/service/GetRepoMirrorLogsService.ts',
        'packages/core/src/module/repoMirror/service/RepoMirrorLockService.ts',
        'packages/core/src/service/GitCommandService.ts',
        'packages/core/src/service/ProcessService.ts',
        'scripts/runRelizy.ts',
      ],
      rules: {
        // 延迟、锁等待、子进程和 Deferred 都必须把回调 API 包装为 Promise。
        'promise/avoid-new': 'off',
      },
    },
    {
      files: [
        'packages/core/src/module/repoMirror/service/RepoMirrorStoreService.test.ts',
      ],
      rules: {
        // 测试使用按位与读取 POSIX 文件权限位。
        'no-bitwise': 'off',
      },
    },
    {
      files: [
        'packages/core/src/module/repoMirror/service/StableRunnerInstaller.ts',
      ],
      rules: {
        // 这些内容是生成脚本中的 Shell 参数展开占位符，并非 JavaScript 插值。
        'no-template-curly-in-string': 'off',
      },
    },
    {
      files: ['packages/core/tsdown.config.ts'],
      rules: {
        // Ultracite 要求使用 import.meta.dirname，但 tsgolint 尚未识别该 Node 类型。
        'typescript/no-unsafe-argument': 'off',
      },
    },
    {
      files: [
        'apps/cli/src/service/CliApplication.integration.test.ts',
        'packages/core/src/module/repoMirror/service/GetRepoMirrorLogsService.ts',
        'packages/core/src/module/repoMirror/service/RepoMirrorDependencyService.ts',
        'packages/core/src/module/repoMirror/service/RepoMirrorGitService.ts',
        'packages/core/src/module/repoMirror/service/RepoMirrorLockService.ts',
        'packages/core/src/module/repoMirror/service/RepoMirrorLoggerService.test.ts',
        'packages/core/src/module/repoMirror/service/ResolveRepoMirrorService.ts',
        'packages/core/src/module/task/service/remotePreflight.ts',
        'packages/core/src/module/task/service/TaskRootService.ts',
        'packages/core/src/module/task/service/TaskScaffoldService.ts',
        'packages/core/src/module/task/service/TaskTemplateImportService.test.ts',
        'packages/core/src/module/task/service/TaskTemplateImportService.ts',
        'packages/core/src/service/ConcurrencyService.ts',
        'packages/core/src/service/FileSystemService.ts',
        'scripts/checkArchitecture.ts',
      ],
      rules: {
        // 这些流程包含有意的串行 I/O、轮询或状态迁移，保留提示但不阻断提交。
        'no-await-in-loop': 'warn',
      },
    },
  ],
  rules: {
    complexity: ['error', 30],
    // 项目有意使用可提升的辅助函数声明，架构检查也会直接检查这类声明。
    'func-style': 'off',
    'max-classes-per-file': ['error', 5],
    'no-unmodified-loop-condition': 'error',
    'no-use-before-define': [
      'error',
      {
        allowNamedExports: true,
        classes: false,
        enums: true,
        functions: false,
        ignoreTypeReferences: true,
        typedefs: false,
        variables: true,
      },
    ],
    // 每个源码目录都必须显式提供 index barrel。
    'oxc/no-barrel-file': 'off',
    // Service 的异步 Contract 允许实现直接返回已有 Promise。
    'require-await': 'off',
    // Ultracite 的该风格规则会要求使用 `!`，与 no-non-null-assertion 冲突。
    'typescript/non-nullable-type-assertion-style': 'off',
    // 只在异常处理边界要求 await，避免给每个 Promise 转发都增加冗余 await。
    'typescript/return-await': ['error', 'in-try-catch'],
    // Service/Contract 文件使用 PascalCase、辅助文件使用 camelCase 是既有约定。
    'unicorn/filename-case': 'off',
    // 项目使用 Node.js 内置模块的具名导入，以显式表达实际依赖的 API。
    'unicorn/import-style': 'off',
  },
})
