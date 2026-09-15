# 基于类与 ReDI 的架构重构计划

> 状态：已实施；本文同时作为后续目录与依赖规范日期：2026-09-13范围：`gits` CLI 的源码组织、Workspace 拆包、面向对象改造和依赖装配相关资料：[ReDI](https://redi.wzhu.dev/)、[Declare Dependency](https://redi.wzhu.dev/docs/declare-dependency)

## 1. 结论

本次重构采用“私有 Core 包 + CLI 应用包”的模块化单体结构：

```text
apps/cli  ──────>  packages/core
   │                    │
   │                    ├── contract
   │                    ├── service
   │                    └── module
   │
   ├── contract
   ├── service
   ├── module
   └── bootstrap
```

- `packages/core` 是私有应用核心包，包含业务规则、业务流程和 Node/Git 等基础能力。
- `apps/cli` 是可执行应用包，只负责 Incur 命令定义、参数转换、终端交互、结果输出和进程退出码。
- 两个包都使用 WBS 风格的 `contract / service / module` 目录规则。
- 行为组件优先使用类；`index.ts`、依赖注册清单和启动函数不强行包装成没有状态的类。
- 使用 `@wendellhu/redi` 声明构造器依赖，并在唯一的组合根创建 Injector。
- 一个终端命令启动一个 Node.js 进程；一个进程只创建一个 Injector。
- 保留 Incur 现有的命令 schema、shell completion、`--llms`、MCP、CTA 和输出能力，不切换 CLI 框架。
- 不再使用 `domain / application / ports / infrastructure / presentation` 术语。
- 不再保留全能的 `RepoMirrorManager` 或全局 Service Locator。

## 2. 为什么重构

当前实现已经具备完整行为，但目录和依赖关系需要开发者同时理解多套架构术语：

```text
domain
application
application/ports
infrastructure
presentation
```

同时存在以下具体问题：

- `apps/cli/src/presentation/cli/services.ts` 手工创建完整对象图，并通过 `getApplicationServices()` 暴露全局 Service Locator。
- Route 在运行时主动取得整个 `ApplicationServices`，无法仅从构造器看出自身依赖。
- `application/ports` 当前包含十余个接口，开发者需要反复判断一个能力应叫 port、gateway、store 还是 adapter。
- `RepoMirrorManager` 已超过 1,100 行，同时承载 list、path、logs、add、set、fetch、remove 和 doctor。
- `apps/cli` 同时承载业务、平台实现和展示，包边界没有表达真实依赖方向。
- 新增命令需要凭经验决定放在哪一层，没有一套固定的机械步骤。

这次重构的目标不是追求更复杂的“纯架构”，而是把新增功能约束为少数固定动作。

## 3. 设计目标

### 3.1 目标

1. 看到目录即可判断代码的业务归属和职责。
2. 看到类的构造器即可判断它依赖哪些能力。
3. 一个公开 CLI 命令对应一个 CLI Command 类和一个 Core Service 类。
4. 所有通过构造器注入的 Service 都依赖接口 Identifier，不依赖具体实现类。
5. 所有依赖绑定集中、显式、可搜索。
6. Core 不依赖 CLI，业务代码不知道 Incur、终端颜色或进程退出码。
7. 保持现有命令、配置文件、持久化数据和输出契约不变。
8. 每一步迁移后都能通过类型检查和相关测试，避免一次性重写。

### 3.2 非目标

- 不改变公开命令名称、参数、alias 或默认值。
- 不改变 `task.config.jsonc` 和 `~/.gits/config.jsonc` 格式。
- 不改变 repo mirror、调度、锁、日志和卸载的产品语义。
- 不引入常驻 daemon，也不在不同 CLI 进程之间共享内存 Service。
- 不把 Core 建设成与 Node.js 完全隔离的“纯领域模型”包。
- 不为目录对称而创建空目录、空接口或无行为类。
- 不在本次重构中顺便增加新功能。

## 4. 固定目录规则

### 4.1 WBS 风格骨架

每个业务包采用下面的固定语义：

```text
src/
├── contract/   # 对外类型、常量，以及所有注入 Service 的接口
├── service/    # 包级、跨模块复用的基础 Service
├── module/     # 按业务能力组织的模块
├── bootstrap/  # 仅应用包拥有；创建和启动应用
└── index.ts
```

规则如下：

- `contract` 只出现在包的 `src` 根目录。
- `module/<moduleName>` 内不再嵌套 `contract` 或另一个 `module`。
- 模块实现统一放在 `module/<moduleName>/service`。
- 跨多个模块复用的能力才进入包根 `service`。
- 模块内辅助类留在该模块的 `service`，不能为了“通用”过早上移。
- 没有真实文件时不创建空的 `types`、`constants`、`interface` 或 `service` 目录。
- 所有源码目录必须提供 `index.ts`。
- 测试默认与实现放在一起，例如 `AddRepoMirrorService.test.ts`，不创建仅用于容纳测试的导出目录。

### 4.2 命名规则

源码中不使用 kebab-case 或 snake_case：

| 对象                 | 规则           | 示例                      |
| -------------------- | -------------- | ------------------------- |
| 目录                 | 小驼峰         | `repoMirror/`             |
| 普通模块文件         | 小驼峰         | `commandResult.ts`        |
| 类文件               | 大驼峰         | `AddRepoMirrorService.ts` |
| 接口/Identifier 文件 | 大驼峰         | `IGitService.ts`          |
| 测试文件             | 与被测文件同名 | `GitService.test.ts`      |
| 聚合导出             | 固定名称       | `index.ts`                |

缩写统一使用 `Cli`、`Git`、`Jsonc`、`RepoMirror`，例如：

```text
CliApplication.ts
GitService.ts
JsoncConfigurationService.ts
RepoMirrorStoreService.ts
```

### 4.3 index.ts 规则

每个源码目录都提供明确导出：

```ts
// contract/types/index.ts
export * from './commandResult'
export * from './repoMirror'
export * from './task'
```

```ts
// module/repoMirror/index.ts
export * from './service/index'
```

```ts
// module/index.ts
export * from './repoMirror/index'
export * from './task/index'
export * from './uninstall/index'
```

约束：

- 跨目录引用通过目标目录的 `index.ts`。
- 同一目录内部可以直接引用具体文件。
- 包内部实现不能从自身包根入口反向导入，例如 Core 内部不能写 `from '@gits/core'`。
- `index.ts` 只做导出，不初始化容器、不读文件、不执行命令。
- `service/index.ts` 必须使用具名导出，只暴露 Service/Command 实现类以及经过明确选择的跨模块契约；不能用 `export *` 顺带泄露实现辅助函数、测试配置或内部类型。
- 禁止 default export，避免重命名不一致；Incur 从文件路由迁移为显式注册后也不再需要 Route default export。
- `package.json#exports` 决定真正的包外公开面；存在目录 `index.ts` 不等于必须把全部内部实现发布给外部包。

### 4.4 TypeScript 与无扩展名导入

源码文件全部使用 `.ts`，项目采用 TypeScript Bundler 模块解析和 tsdown/Rolldown 构建。源码里的相对导入写成：

```ts
import { GitService } from './GitService'
```

源码既不写 `.ts`，也不预写 `.js`。tsdown 在构建阶段解析并捆绑相对模块，最终只把合法的 ESM JavaScript 放入 `dist`。架构门禁会检查源码目录不存在真实 `.js` 文件，并要求源码内部的相对导入省略文件扩展名。

仓库根目录只保留共享的 `tsconfig.base.json`，包含 `strict`、Bundler 模块解析、装饰器等所有包共同使用的选项；每个 workspace 包保留自己的 `tsconfig.json` 并继承该 base。根目录不再放一个重复聚合源码的 `tsconfig.json`。直接通过 `tsx` 从仓库根运行测试时，脚本使用 `TSX_TSCONFIG_PATH=tsconfig.base.json` 显式选择共享配置。

### 4.5 深模块与浅暴露

每个 Service 都必须是“深模块”：用尽可能小而稳定的接口隐藏足够完整的业务实现。这里的“深”指实现被封装，不是要求文件必须很长；“浅”指调用者只理解业务能力，不需要理解内部步骤和依赖传递方式。

固定规则：

- 命令型 Service 对外只暴露 `execute()`；Command 对外只暴露 `register()`。
- 资源型基础 Service 可以暴露多个内聚操作，例如 `IGitService`，但公开方法必须全部来自对应接口。
- Service 的流程步骤使用 `private` 方法或 `#private` 成员，不能成为未声明的隐式 public 方法。
- 构造器注入的依赖保存在类字段中，内部直接使用 `this.xxx`；禁止重新拼成 `*Dependencies` 对象传给外部流程函数。
- 禁止用类外的 `executeXxx()` 函数承载 Service 主流程。主流程必须由 Service 自身实现。
- 仅被当前 Service 使用的实现细节不导出。复杂 Service 可以拆成同名子目录，但该目录的 `index.ts` 仍只导出 Service 类。
- 无状态、确定性的计算可以保留为纯函数；纯函数不是 Service，不进入 ReDI，也不能借助 Service barrel 扩大公开面。
- 只有被至少两个 Service 复用，或者独立管理外部资源生命周期的有状态能力，才提取为新的接口与可注入 Service。

例如，Task Service 的结构应是：

```ts
export class FetchTaskService implements IFetchTaskService {
  constructor(
    @Inject(IConcurrencyService)
    private readonly concurrency: IConcurrencyService,
    @Inject(IGitService)
    private readonly git: IGitService
  ) {}

  async execute(input: FetchTaskInput): Promise<CommandOutput> {
    // 完整用例入口；调用者无需知道内部阶段。
    return this.fetchRepositories(input)
  }

  private async fetchRepositories(
    input: FetchTaskInput
  ): Promise<CommandOutput> {
    // 内部流程直接使用 this.concurrency / this.git。
  }
}
```

## 5. 预期目录

### 5.1 仓库总览

```text
.
├── apps/
│   └── cli/
│       ├── package.json
│       ├── tsconfig.json
│       ├── tsdown.config.ts
│       └── src/
│           └── ...
│
├── packages/
│   └── core/
│       ├── package.json
│       ├── tsconfig.json
│       ├── tsdown.config.ts
│       └── src/
│           └── ...
│
├── docs/
│   └── class-based-di-refactoring-plan.md
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

`pnpm-workspace.yaml` 最终包含：

```yaml
packages:
  - apps/*
  - packages/*
```

### 5.2 packages/core

`packages/core` 是私有包，包名为 `@gits/core`：

```text
packages/core/
├── package.json
├── tsconfig.json
├── tsdown.config.ts
├── templates/
│   └── taskScaffold.md
└── src/
    ├── contract/
    │   ├── types/
    │   │   ├── GitsError.ts
    │   │   ├── RepoMirrorError.ts
    │   │   ├── TaskError.ts
    │   │   ├── commandResult.ts
    │   │   ├── concurrency.ts
    │   │   ├── git.ts
    │   │   ├── gitsPath.ts
    │   │   ├── repoMirror.ts
    │   │   ├── repoMirrorService.ts
    │   │   ├── task.ts
    │   │   ├── taskProgress.ts
    │   │   ├── taskService.ts
    │   │   ├── uninstall.ts
    │   │   └── index.ts
    │   │
    │   ├── interface/
    │   │   ├── I{UseCase}Service.ts
    │   │   ├── I{Resource}Service.ts
    │   │   └── index.ts
    │   │
    │   └── index.ts
    │
    ├── service/
    │   ├── ConcurrencyService.ts
    │   ├── FileSystemService.ts
    │   ├── GitCommandService.ts
    │   ├── GitService.ts
    │   ├── GitsPathService.ts
    │   ├── ProcessService.ts
    │   └── index.ts
    │
    ├── module/
    │   ├── repoMirror/
    │   │   ├── service/
    │   │   │   ├── AddRepoMirrorService.ts
    │   │   │   ├── DoctorRepoMirrorService.ts
    │   │   │   ├── FetchRepoMirrorService.ts
    │   │   │   ├── GetRepoMirrorLogsService.ts
    │   │   │   ├── GetRepoMirrorPathService.ts
    │   │   │   ├── ListRepoMirrorService.ts
    │   │   │   ├── RemoveRepoMirrorService.ts
    │   │   │   ├── ResolveRepoMirrorService.ts
    │   │   │   ├── SetRepoMirrorService.ts
    │   │   │   ├── RepoMirrorConfigurationService.ts
    │   │   │   ├── RepoMirrorDependencyService.ts
    │   │   │   ├── RepoMirrorGitService.ts
    │   │   │   ├── RepoMirrorLockService.ts
    │   │   │   ├── RepoMirrorLoggerService.ts
    │   │   │   ├── RepoMirrorSchedulerService.ts
    │   │   │   ├── RepoMirrorStoreService.ts
    │   │   │   ├── RepoMirrorViewService.ts
    │   │   │   ├── StableRunnerInstaller.ts
    │   │   │   └── index.ts
    │   │   └── index.ts
    │   │
    │   ├── task/
    │   │   ├── service/
    │   │   │   ├── AddTaskRepoMirrorsService.ts
    │   │   │   ├── FetchTaskService.ts
    │   │   │   ├── InitializeTaskService.ts
    │   │   │   ├── InstallTaskService.ts
    │   │   │   ├── PushTaskService.ts
    │   │   │   ├── StatusTaskService.ts
    │   │   │   ├── SwitchTaskService.ts
    │   │   │   ├── TaskConfigurationService.ts
    │   │   │   ├── TaskRootService.ts
    │   │   │   ├── TaskScaffoldService.ts
    │   │   │   ├── TaskTemplateImportService.ts
    │   │   │   └── index.ts
    │   │   └── index.ts
    │   │
    │   ├── uninstall/
    │   │   ├── service/
    │   │   │   ├── GitsPersistenceService.ts
    │   │   │   ├── UninstallService.ts
    │   │   │   └── index.ts
    │   │   └── index.ts
    │   │
    │   └── index.ts
    │
    ├── dependencies.ts
    └── index.ts
```

`templates/taskScaffold.md` 是 `gits init` 的 Scaffdog Markdown 模板，统一维护 `task.config.jsonc`、根 `AGENTS.md`、`docs/AGENTS.md`、`scripts/AGENTS.md` 和 `repos/AGENTS.md` 的初始内容。四份 `AGENTS.md` 提供任务工作区及各子目录的默认职责和工作约定，后续代理可在任务执行过程中持续补充上下文、工具和风险边界。`repos/` 随 `repos/AGENTS.md` 一并由模板创建，不需要 `TaskScaffoldService` 单独创建空目录。

上图表达职责位置，不要求第一步机械地生成全部空文件。迁移某项现有能力时才创建对应文件。

Core 的模块依赖方向固定为：

```text
contract
   ↑
service
   ↑
repoMirror
   ↑       ↑
 task   uninstall
```

- 根 `service` 不能依赖任何业务 `module`。
- `repoMirror` 可以依赖根 `service`。
- `task` 可以使用 repo mirror 加速安装，因此允许 `task -> repoMirror`。
- `uninstall` 可以查询、解除和清理 mirror，因此允许 `uninstall -> repoMirror`。
- `repoMirror` 不反向依赖 `task`。
- `repo-mirrors add --from-task` 的任务读取和编排放在 `AddTaskRepoMirrorsService`，从而避免 `repoMirror <-> task` 循环依赖。

### 5.3 apps/cli

`apps/cli` 本身已经表达“这是 CLI”，因此不再保留多余的 `src/cli` 或 `presentation/cli` 层：

```text
apps/cli/
├── package.json
├── tsconfig.json
├── tsdown.config.ts
└── src/
    ├── contract/
    │   ├── types/
    │   │   ├── cliContext.ts
    │   │   ├── cliPresentation.ts
    │   │   └── index.ts
    │   │
    │   ├── constants/
    │   │   ├── exitCode.ts
    │   │   └── index.ts
    │   │
    │   ├── interface/
    │   │   ├── ICliApplication.ts
    │   │   ├── ICliCommand.ts
    │   │   ├── ICliConfirmationService.ts
    │   │   ├── ICliErrorService.ts
    │   │   ├── ICliOutputService.ts
    │   │   ├── ICliRuntimeService.ts
    │   │   ├── IRepoMirrorSubcommand.ts
    │   │   └── index.ts
    │   │
    │   └── index.ts
    │
    ├── service/
    │   ├── CliApplication.ts
    │   ├── CliConfirmationService.ts
    │   ├── CliErrorService.ts
    │   ├── CliOutputService.ts
    │   ├── CliProgressService.ts
    │   ├── CliRuntimeService.ts
    │   └── index.ts
    │
    ├── module/
    │   ├── task/
    │   │   ├── service/
    │   │   │   ├── FetchTaskCommand.ts
    │   │   │   ├── InitializeTaskCommand.ts
    │   │   │   ├── InstallTaskCommand.ts
    │   │   │   ├── PushTaskCommand.ts
    │   │   │   ├── StatusTaskCommand.ts
    │   │   │   ├── SwitchTaskCommand.ts
    │   │   │   └── index.ts
    │   │   └── index.ts
    │   │
    │   ├── repoMirror/
    │   │   ├── service/
    │   │   │   ├── AddRepoMirrorCommand.ts
    │   │   │   ├── DoctorRepoMirrorCommand.ts
    │   │   │   ├── FetchRepoMirrorCommand.ts
    │   │   │   ├── GetRepoMirrorLogsCommand.ts
    │   │   │   ├── GetRepoMirrorPathCommand.ts
    │   │   │   ├── ListRepoMirrorCommand.ts
    │   │   │   ├── RemoveRepoMirrorCommand.ts
    │   │   │   ├── RepoMirrorCommand.ts
    │   │   │   ├── SetRepoMirrorCommand.ts
    │   │   │   └── index.ts
    │   │   └── index.ts
    │   │
    │   ├── uninstall/
    │   │   ├── service/
    │   │   │   ├── UninstallCommand.ts
    │   │   │   └── index.ts
    │   │   └── index.ts
    │   │
    │   └── index.ts
    │
    ├── bootstrap/
    │   ├── container.ts
    │   └── index.ts
    │
    ├── dependencies.ts
    └── index.ts
```

CLI 包的依赖方向固定为：

```text
contract
   ↑
service
   ↑
module
   ↑
bootstrap/index.ts
```

CLI 的 `module` 可以依赖 `@gits/core`，但 Core 不能依赖 CLI。

## 6. Command 与 Service 的边界

一个用户命令拆成两个类：

```text
apps/cli                                  packages/core

AddRepoMirrorCommand  ─────────────────>  AddRepoMirrorService
参数 schema / flag                         业务校验
Incur context                              状态读取与修改
确认交互                                  Git / 文件 / 调度操作
人类或 JSON 输出                           结构化结果
退出码                                    不感知终端
```

以 `repo-mirrors add` 为例：

```text
argv
  -> Incur
  -> AddRepoMirrorCommand
  -> AddRepoMirrorService.execute(input)
  -> RepoMirrorStoreService / IGitService / RepoMirrorSchedulerService
  -> CommandResult
  -> CliOutputService
  -> stdout/stderr + exit code
```

固定规则：

- Command 类只有一个公开的注册入口，负责定义 Incur command 和调用 Core Service。
- Core 命令 Service 只有一个主要用例入口，统一命名为 `execute()`。
- CLI 输入类型只在 CLI 内使用；转换后传入 Core 的稳定输入类型。
- Core 返回结构化结果，不直接 `console.log()`，不设置 `process.exitCode`。
- Command 不直接执行 Git、文件系统、锁、调度或持久化操作。
- 一个类如果同时实现两个公开命令，必须拆成两个命令 Service。
- 只有被至少两个命令 Service 复用，或者独立管理一个外部资源生命周期的逻辑，才抽取成模块内辅助 Service。

## 7. ReDI 装配方案

### 7.1 Identifier 与接口

统一规则：所有进入构造器的 Service 依赖都建立接口和 Identifier。具体类只出现在实现文件、测试的手工构造以及 `dependencies.ts` 的 `{ useClass }` 绑定中。

不需要接口的对象只有纯数据、回调、第三方值对象和类内部自行创建的私有实现细节；它们不能作为 ReDI 注入的 Service 依赖。

接口和 ReDI Identifier 放在同一个文件：

```ts
import { createIdentifier, type IdentifierDecorator } from '@wendellhu/redi'

export interface IGitService {
  // 稳定能力定义
}

export const IGitService: IdentifierDecorator<IGitService> =
  createIdentifier<IGitService>('core.gitService')
```

消费方和注册清单固定写法如下：

```ts
constructor(@Inject(IGitService) private readonly git: IGitService) {}

[IGitService, { useClass: GitService }]
```

禁止 `@Inject(GitService)`，也禁止在业务类中 `new GitService()` 或调用 `Injector#get()`。

注入依赖统一使用 TypeScript 构造函数参数属性：默认写成 `private readonly`，只有确实属于类公开 API 的依赖才使用 `public readonly`。项目不启用 `erasableSyntaxOnly`，避免为每个注入参数重复声明字段和编写赋值语句。

有限且稳定的业务状态、动作和模式优先声明为字符串 `enum`，不要重复书写字符串字面量联合类型：

```ts
export enum RepositoryActionResult {
  Success = 'success',
  Skipped = 'skipped',
  Failed = 'failed',
  NotRun = 'not-run',
}
```

开放集合仍然使用 `string`，固定命令名等单值判别字段仍可使用单个字符串字面量；不能为了枚举化而把错误消息、路径、用户输入或第三方协议字段做成枚举。

### 7.2 Core 注册清单

`packages/core/src/dependencies.ts` 是 Core 的默认 ReDI 注册清单，不是新的业务层：

```ts
import type { Dependency } from '@wendellhu/redi'

export const coreDependencies: Dependency[] = [
  [IGitService, { useClass: GitService }],
  [IFileSystemService, { useClass: FileSystemService }],
  [IInstallTaskService, { useClass: InstallTaskService }],
  [IAddRepoMirrorService, { useClass: AddRepoMirrorService }],
]
```

该文件只允许：

- 类注册；
- Identifier 到实现的绑定；
- value/factory 注册；
- 必要的生命周期选项。

禁止在这里执行业务逻辑、读配置、访问文件或主动调用某个 Service。

### 7.3 唯一组合根

`apps/cli/src/bootstrap/container.ts` 是整个可执行程序唯一的组合根：

```ts
export function createContainer(): Injector {
  return new Injector([...coreDependencies, ...cliDependencies])
}
```

当前 CLI 只使用一个 Injector，不引入父子容器：

- CLI 每次执行本来就是独立进程。
- 当前没有页面子树、请求作用域或动态插件生命周期。
- 包依赖方向应由 Workspace、TypeScript import 和依赖检查保证，而不是用容器层级模拟。

如果将来出现常驻进程或明确的多作用域需求，再单独设计子 Injector；不能仅为了“分层看起来漂亮”提前引入。

### 7.4 CLI 进程生命周期

```text
用户执行 gits ...
  -> 操作系统启动 Node.js 进程
  -> index.ts 调用 createContainer() 一次
  -> Injector 创建/解析 CliApplication
  -> CliApplication 注册全部 Incur Command
  -> Incur 解析并执行唯一命中的 Command
  -> 进程结束
```

因此生命周期约定为：

```text
一次 CLI 调用 = 一个 Node.js 进程 = 一个 Injector
```

- 不在每个 Command handler 内创建容器。
- 不建立跨进程全局单例。
- 构造器只接收和保存依赖，不执行 I/O 或启动后台任务。
- 重操作放在 `execute()`、`run()` 或明确的初始化方法中。
- 只有经测量确实影响启动时间的依赖才配置 `lazy: true`。
- 测试默认每个用例创建独立 Injector，避免状态串扰。

### 7.5 CLI Command 注册

Incur 支持通过 `.command()` 显式注册命令，因此重构后不再依赖 `cli.fs()` 扫描 Route 文件。

`CliApplication` 通过 ReDI 的多实现注入获得全部顶层 `ICliCommand`，按注册清单中的稳定顺序挂载到 Incur：

```ts
export class CliApplication {
  readonly #commands: readonly ICliCommand[]

  constructor(@Many(ICliCommand) commands: ICliCommand[]) {
    this.#commands = commands
  }

  async run(argv: readonly string[]): Promise<void> {
    const cli = createGitsCli()

    for (const command of this.#commands) {
      command.register(cli)
    }

    await cli.serve([...argv])
  }
}
```

`RepoMirrorCommand` 负责创建并挂载 `repo-mirrors` 子 CLI；add、list、fetch 等叶子 Command 仍然保持独立类。它们通过 CLI 包内的 `IRepoMirrorSubcommand` 多实现 Identifier 收集；该接口放在 `apps/cli/src/contract/interface`，但不会从私有 CLI 包对外发布。

只有 `apps/cli/src/index.ts` 可以主动调用：

```ts
injector.get(ICliApplication)
```

业务 Service 和 Command 类中禁止使用 `Injector#get()`；它们只能通过构造器声明依赖。

## 8. 包边界与依赖

### 8.1 package.json

`packages/core/package.json`：

```json
{
  "name": "@gits/core",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "publishConfig": {
    "directory": "dist",
    "linkDirectory": true
  }
}
```

采用 `publishConfig.directory` 方案，不使用自定义 export condition。tsdown 在 `packages/core/dist` 生成单文件 ESM 和声明文件，`build:done` hook 同步生成独立的生产 `package.json`，其中 `main`、`types` 和 `exports` 分别指向 `index.js` 与 `index.d.ts`；源码清单的 `exports` 继续指向 `src/index.ts`。`linkDirectory: true` 让 pnpm 在本地开发时将 `@gits/core` 链接到该生产目录，因此 CLI 的全局链接无需 TypeScript loader；`pnpm pack/publish` 也只处理 `dist`。修改 Core 后需要重新构建，持续开发时使用根目录的 `pnpm build:watch`。

`apps/cli/package.json`：

```json
{
  "dependencies": {
    "@gits/core": "workspace:*",
    "@wendellhu/redi": "catalog:",
    "incur": "catalog:"
  }
}
```

ReDI 会由两个包直接使用，必须通过 Workspace catalog 锁定同一个版本，避免同一进程加载多份 ReDI。

### 8.2 第三方依赖归属

依赖跟随使用者移动：

| 依赖               | 目标包          | 原因                       |
| ------------------ | --------------- | -------------------------- |
| `incur`            | `apps/cli`      | CLI schema、解析和输出协议 |
| `table`、`listr2`  | `apps/cli`      | 终端展示与进度反馈         |
| `@wendellhu/redi`  | 两个包          | Identifier/装饰器和组合根  |
| `jsonc-parser`     | `packages/core` | 任务和 mirror 配置持久化   |
| `cron-parser`      | `packages/core` | mirror 调度业务            |
| `proper-lockfile2` | `packages/core` | 机器级互斥与并发槽         |
| `pino`             | `packages/core` | 持久化结构化运行日志       |
| `plist`            | `packages/core` | macOS 调度投影             |

如果 `listr2` 当前与业务并发逻辑耦合，先通过 CLI 的进度 Contract 解耦，再移动依赖；不能让 Core 为了进度显示反向依赖 CLI。

### 8.3 自动化依赖门禁

重构完成前增加 dependency-cruiser 或等价静态规则，至少保证：

1. `packages/core` 禁止导入 `apps/cli`。
2. `contract` 禁止导入同包的 `service`、`module` 和 `bootstrap`。
3. 根 `service` 禁止导入业务 `module`。
4. `repoMirror` 禁止导入 `task` 和 `uninstall`。
5. `apps/cli/module` 可以导入 `@gits/core`，Core 不允许反向导入。
6. 除 `bootstrap/container.ts` 和测试外，禁止导入 ReDI 的 `Injector`。
7. 禁止源码循环依赖。
8. ReDI 注入参数必须是带可见性修饰符的只读构造函数参数属性。
9. 有限字符串联合类型必须改为字符串枚举；开放字符串和单值判别字段不受此限制。

目录规范只有配合自动门禁才是规则，否则仍会逐渐退化为约定。

## 9. 当前目录到目标目录的映射

| 当前位置 | 目标位置 |
| --- | --- |
| `domain/task/model.ts` | `packages/core/src/contract/types/task.ts` |
| `domain/repo-mirror/model.ts` | `packages/core/src/contract/types/repoMirror.ts` |
| `domain/*/errors.ts` | 对应 Contract 类型或模块 Service 邻近文件 |
| `application/use-cases/*.ts` | `packages/core/src/module/task/service/*TaskService.ts` |
| `application/task/*.ts` | Task 模块内的命令 Service 或共享辅助 Service |
| `application/repo-mirrors/repo-mirror-manager.ts` | 八个独立 RepoMirror 命令 Service |
| `application/repo-mirrors/configured-repo-mirror-resolver.ts` | `ResolveRepoMirrorService.ts` |
| `application/uninstall/gits-uninstaller.ts` | `UninstallService.ts` |
| `application/ports/*.ts` | 按新 Service 职责整理；每个可注入 Service 在 `contract/interface` 声明接口与 Identifier |
| `infrastructure/git/*` | 根 `service/GitService.ts` 或其邻近私有实现 |
| `infrastructure/filesystem/*` | 根 `service/FileSystemService.ts` 或所属业务模块 |
| `infrastructure/process/*` | 根 `service/ProcessService.ts` |
| `infrastructure/repo-mirrors/*` | Core 的 repoMirror 模块 Service |
| `infrastructure/scheduler/*` | Core 的 repoMirror 模块 Service |
| `presentation/cli/routes/*` | `apps/cli/src/module/*/service/*Command.ts` |
| `presentation/cli/presenters/*` | `apps/cli/src/service/CliOutputService.ts` 及邻近类 |
| `presentation/cli/services.ts` | 删除；由 ReDI 和 `bootstrap/container.ts` 取代 |
| `getApplicationServices()` | 删除；改为构造器注入 |
| `setApplicationServicesForTesting()` | 删除；测试使用独立 Injector 和替代绑定 |

旧 port 不必机械保留原名，应按新的 Service 职责重新整理；但凡一个 Service 通过构造器注入另一个 Service，就必须依赖 `contract/interface` 中的接口 Identifier。只有不参与注入的模块私有纯函数、值对象和实现细节可以不额外声明接口。

## 10. 分阶段迁移

### Phase 0：兼容性验证与基线

1. 在 Workspace catalog 固定 ReDI 版本。
2. 用最小类验证 `@Inject`、`createIdentifier`、`@Many` 能通过当前开发、类型检查和构建链路。
3. 当前项目使用 TypeScript 7 和 tsdown；验证 ReDI 所需的 `experimentalDecorators` 与构造函数参数属性能通过 `tsc --noEmit` 检查，并由 Rolldown/Oxc 正确生成 Node ESM。
4. ReDI 不要求 `emitDecoratorMetadata`，不主动引入 `reflect-metadata`。
5. 不启用 `erasableSyntaxOnly`；ReDI 注入参数统一使用 `private readonly` 构造函数参数属性，有限稳定值集合优先使用字符串枚举。运行产物统一由 tsdown 构建，不再使用 `tsc` 或 `tsgo` emit。
6. 在迁移前运行并记录 `pnpm check` 基线。

通过标准：开发运行、类型检查、测试和构建都能执行最小 ReDI 示例。

### Phase 1：建立 Workspace 包骨架

1. 新增私有 `packages/core`。
2. 更新 `pnpm-workspace.yaml`。
3. 建立 `contract / service / module` 和全部必要的 `index.ts`。
4. 配置 Core 的 build/typecheck。
5. 让 CLI 通过 `workspace:*` 引用 Core 的一个最小导出。

本阶段不移动业务逻辑，不改变运行行为。

### Phase 2：迁移 Contract 与基础 Service

1. 先迁移 Task、RepoMirror 和 CommandResult 类型。
2. 将 Git、文件系统、进程、日志、并发等基础能力重命名并迁移到 Core 根 `service`。
3. 为每个被构造器注入的 Service 建立 ReDI Identifier。
4. 新增 `coreDependencies`，但暂时允许旧装配桥接新 Service。
5. 逐个迁移对应单元测试。

### Phase 3：迁移 Task 模块

按风险从低到高，将现有函数用例转换为类：

```text
initializeTask  -> InitializeTaskService.execute()
statusTask      -> StatusTaskService.execute()
fetchTask       -> FetchTaskService.execute()
pushTask        -> PushTaskService.execute()
switchTask      -> SwitchTaskService.execute()
installTask     -> InstallTaskService.execute()
```

先保持函数内部算法不变，只改变归属和依赖取得方式；完成后再做局部去重。

### Phase 4：拆分 RepoMirrorManager

先迁移只读操作，再迁移修改操作：

1. `GetRepoMirrorPathService`
2. `GetRepoMirrorLogsService`
3. `ListRepoMirrorService`
4. `FetchRepoMirrorService`
5. `SetRepoMirrorService`
6. `AddRepoMirrorService`
7. `RemoveRepoMirrorService`
8. `DoctorRepoMirrorService`

每迁移一个操作：

1. 从 Manager 移出该操作及仅属于它的私有函数。
2. 通过构造器注入它实际使用的依赖。
3. 保持输入、输出和错误码不变。
4. 将对应 Route/测试切到新 Service。
5. 相关测试通过后再迁移下一个操作。

所有调用方迁移完成后删除 `RepoMirrorManager`，不能长期保留“新 Service 调回旧 Manager”的双层结构。

### Phase 5：迁移 Uninstall

1. 将 `GitsUninstaller` 改为 `UninstallService`。
2. 通过 repoMirror 模块公开的 Service 执行依赖检查和 detach。
3. 保持 managed path、ownership、dry-run、force 和 purge 安全校验不变。

### Phase 6：迁移 CLI

1. 建立 CLI 的 `contract / service / module`。
2. 将共享执行、确认、错误和输出逻辑改为包级 Service 类。
3. 为每个现有 Route 建立对应 Command 类。
4. 用 Incur `.command()` 和子 CLI 显式注册，替换 `cli.fs()` 文件扫描。
5. 在 `container.ts` 注册 `ICliCommand` 多实现和 CLI Service。
6. 将入口缩减为“创建容器、获取 CliApplication、执行”。
7. 删除 `presentation/cli/services.ts` 和所有 Service Locator API。

### Phase 7：清理与门禁

1. 删除空的旧 `domain / application / infrastructure / presentation` 目录。
2. 确认所有源码目录都有 `index.ts`。
3. 增加依赖方向和循环依赖检查。
4. 更新 README 中的源码位置和架构说明。
5. 运行完整 `pnpm check`。
6. 对比重构前后的 `--help`、JSON 输出和集成测试结果。

## 11. 新增命令的固定流程

重构完成后，新增一个命令只允许走下面四步：

```text
1. packages/core/module/<module>/service 新增 XxxService
2. apps/cli/module/<module>/service 新增 XxxCommand
3. 在各级 index.ts 显式导出
4. 在 coreDependencies 和 CLI container 中注册
```

放置判断不再依赖感觉：

| 问题 | 放置位置 |
| --- | --- |
| 这是 CLI 参数、确认、显示或退出码吗？ | `apps/cli` |
| 这是一个公开命令的业务流程吗？ | `packages/core/module/<module>/service/XxxService.ts` |
| 被多个业务模块共同使用吗？ | `packages/core/service` |
| 只被一个模块内部复用吗？ | 该模块的 `service` |
| 会作为构造器中的 Service 依赖吗？ | 根 `contract/interface` 增加接口和 Identifier |
| 只是类内部私有实现或纯函数吗？ | 留在相邻文件，不进入 DI |
| 只是纯类型且会跨包传递吗？ | 根 `contract/types` |

## 12. 测试策略

- Core 单元测试直接构造目标 Service，或创建带测试绑定的独立 Injector。
- CLI Command 测试替换 Core Service 和 `ICliOutputService`，验证参数映射与输出调用。
- CLI 集成测试继续覆盖真实入口和完整命令行为。
- 每个测试使用独立容器，不复用生产全局容器。
- 不再使用 `setApplicationServicesForTesting()` 修改进程级全局变量。
- repo mirror、锁、调度、持久化和卸载安全测试必须原样保留。
- 重构阶段每个迁移提交都运行受影响测试；每个 Phase 结束运行完整 `pnpm check`。

## 13. 完成标准

同时满足以下条件才算重构完成：

- `apps/cli` 只承担 CLI 适配和应用启动。
- 所有核心业务实现位于私有 `packages/core`。
- 两个包均遵守 `contract / service / module` 规则。
- 所有源码目录都有 `index.ts`，命名符合驼峰规则。
- `RepoMirrorManager` 已删除，八个命令由独立 Service 承担。
- `getApplicationServices()` 和 `setApplicationServicesForTesting()` 已删除。
- 除组合根和测试外，没有代码主动调用 `Injector#get()`。
- Core 没有导入 CLI 或 Incur。
- 没有源码循环依赖。
- 现有 CLI 命令、参数、JSON 结构、配置和磁盘数据兼容。
- Incur 的 help、completion、`--llms`、MCP 和 CTA 能力保持可用。
- `pnpm check` 全部通过。

## 14. 最终心智模型

重构后只需记住四个概念：

```text
Contract     大家共同遵守的类型和可替换接口
Service      一个明确能力或一个业务用例的类
Module       按 Task、RepoMirror、Uninstall 聚合 Service
Bootstrap    在进程启动时把所有类装配起来
```

其中一次命令的完整路径永远是：

```text
index.ts
  -> Injector
  -> XxxCommand
  -> XxxService
  -> 基础 Service
  -> 结构化结果
  -> CliOutputService
```

这条路径和目录结构一一对应，新增功能不再需要判断 domain、application、port、gateway 或 adapter。
