# gits

[简体中文](README.md) | [English](README.en.md)

`gits` 是面向一个开发任务涉及多个 Git 仓库的任务工作区 CLI。它将这些仓库组织为一个 Task Branch Set（任务分支集），统一完成准备、查看、切换、获取远程状态和安全推送。

`task.config.jsonc` 只保存稳定意图：仓库身份、任务分支、首次创建分支时使用的远程基线，以及可选的工作区目录范围。当前分支、工作区改动、upstream、实际 sparse-checkout 和提交状态始终以原生 Git 为事实来源。

仓库采用 `packages/core` + `apps/cli` 的模块化单体结构。Core 保存业务 Service，CLI 只负责 Incur 参数、交互和输出；全部 Command 通过 ReDI 构造器注入并显式注册，不扫描文件路由。源码和公共 npm 包统一使用 `@usegits/core` 与 `@usegits/cli`，安装 CLI 后的命令名仍是 `gits`。

## 安装

从公共 npm 安装 CLI：

```sh
npm install --global @usegits/cli
gits --help
```

如果只需要复用底层 Service 和 Contract：

```sh
npm install @usegits/core
```

## 环境要求

- Node.js 22.18.0 或更高版本（发布包运行时最低支持 22.17.1）
- pnpm 9.15.9 或更高版本
- 已安装 Git，且 `git` 可从 `PATH` 找到

如果希望由 Node 管理 pnpm 版本，可先执行：

```sh
corepack enable
```

## 开发与构建

在仓库根目录执行：

```sh
pnpm install
pnpm build
pnpm dev -- --help
```

`pnpm build` 使用 tsdown/Rolldown 将 Core 和 CLI 构建为 Node.js ESM；`tsc` 只负责 `--noEmit` 类型检查，不参与生成运行产物。仓库内运行 CLI 时由 `tsx` 直接加载 TypeScript 源码，并显式启用 `@usegits/source` 条件，因此日常开发不要求先构建。

提交前可运行与 CI 相同的完整检查：

```sh
pnpm check
```

代码质量工具直接使用 Oxlint 和 Oxfmt 的原生配置。Oxlint 只启用核心的 correctness、suspicious、perf 分类及少量项目规则；Oxfmt 保持单引号、无分号风格。Lefthook 会在 `pre-commit` 执行两项检查，并在 `commit-msg` 使用 Commitlint 校验 Conventional Commits。依赖安装时会自动注册这些 Git hooks。

Relizy 负责 unified 版本、Changelog、Git 标签与 GitHub Release，根包、CLI 和 Core 会一起升级到同一版本。GitHub 的 **Release** workflow 随后从该版本 tag 发布固定的公共 npm 包 `@usegits/core` 和 `@usegits/cli`；包名与 registry 均由仓库固定，不读取本地映射配置。

正常发布应在 GitHub Actions 页面手动运行 **Release** workflow，并选择 `patch`、`minor` 或 `major`。以下命令只用于本地预检、恢复或调试：

```sh
pnpm release:check           # 仅预演 Relizy，不重复执行 pnpm check
pnpm publish:npm:check       # 构建、验收并 dry-run 公共 npm 包
pnpm publish:npm             # 仅在恢复或调试时手动发布公共 npm 包
```

npm 发布脚本直接从两个公开包生成临时 tarball，依次发布 Core 和 CLI，并在重试时跳过已经存在的版本。CLI 源码仍通过 `@usegits/core` 维护模块边界；正式 CLI 会将 Core 与运行依赖打成一个自包含文件，因此安装 CLI 不需要额外解析 Core 或公共运行依赖。Core 仍作为独立包发布，供其他程序直接复用。整个过程不会改写源码包清单。

GitHub Actions 通过 npm Trusted Publishing 的 OIDC 临时凭据发布，不保存长期 `NPM_TOKEN`。全新包必须先交互式发布一次；创建成功后，应分别将 `@usegits/core` 和 `@usegits/cli` 的 Trusted Publisher 绑定到 `Mobiwuhu/gits`、`release.yml` 与 `npm` environment，后续版本即可完全由 Release workflow 发布。

可以直接运行 CLI 的 TypeScript 源码：

```sh
pnpm dev -- --help
```

需要持续检查构建产物时，可以另开一个终端运行：

```sh
pnpm build:watch
```

打包或安装该 CLI 后，正式二进制名称为 `gits`。

### 全局链接

在仓库根目录执行：

```sh
pnpm link:global
gits --help
```

`link:global` 会先构建整个 workspace，再把 CLI 注册为全局 `gits` 命令。开发链接与正式 tarball 使用同一个 `dist/index.js` 入口和原生 Node.js 运行时，不需要全局安装 `tsx`。源码变化后需重新构建；需要持续同步全局命令时可同时运行 `pnpm build:watch`。

## 快速试用

创建一个任务目录并生成初始脚手架：

```sh
mkdir -p /tmp/gits-demo
pnpm dev -- -C /tmp/gits-demo init
```

该目录会得到：

```text
gits-demo/
├── task.config.jsonc
├── AGENTS.md
├── docs/
│   └── AGENTS.md
├── scripts/
│   └── AGENTS.md
└── repos/
    └── AGENTS.md
```

这组文件由 Scaffdog Markdown 模板 [`packages/core/templates/taskScaffold.md`](packages/core/templates/taskScaffold.md) 生成；开发者可以直接编辑模板来维护新任务的默认内容。四份 `AGENTS.md` 分别说明任务工作区、文档、自动化脚本和多仓库容器的用途与工作约定，让后续代理能够复用当前任务积累的上下文和工具。重复执行 `init` 只补齐缺失文件，不覆盖已经填写的内容。生成的 `task.config.jsonc` 会把当前支持的每个仓库参数都显式列出并逐项注释；只需替换占位符和按需修改显式值，不需要猜测隐藏默认值。编辑后类似：

```jsonc
{
  "repos": {
    "api": {
      "url": "git@host:team/api.git",
      "path": "repos/api",
      "branch": "feat/template-import-4821",
      "from": "origin/main",
      "checkout": null,
      "dissociate": false,
    },
    "web": {
      "url": "git@host:team/web.git",
      "path": "repos/apps/web",
      "branch": "feature/template-import",
      "from": "origin/release/4.8",
      "checkout": null,
      "dissociate": false,
    },
  },
}
```

然后准备并查看仓库：

```sh
pnpm dev -- -C /tmp/gits-demo install
pnpm dev -- -C /tmp/gits-demo status
```

若已有一个任务目录，可直接复用其中的任务上下文：

```sh
pnpm dev -- -C /tmp init gits-demo-copy \
  --from ~/tasks/task-example
```

`--from` 会按源目录实际生效的 `.gitignore` 导入内容，完全跳过源顶层 `repos/`，再用当前 Scaffdog default 补齐目标中缺失的骨架。源根部必须有一份有效且未被忽略的 `task.config.jsonc`。该操作不访问远程、不执行源脚本，也不修改源目录。

### 可复用任务模板

经常重复使用同一套任务骨架时，可以把完整目录保存为机器级命名模板：

```sh
gits init ./template-seed
# 按需修改 template-seed 中的配置、说明和其他文件
gits template add fullstack ./template-seed
gits template list
gits init ./payment-refactor --template fullstack
```

模板是独立快照，默认保存到 `${GITS_HOME}/templates/`（通常为 `~/.gits/templates/`）；保存后不再依赖源目录。`template add` 和 `template update` 只接受包含当前完整 Scaffdog 骨架的目录，并遵守根级、嵌套和适用父级 `.gitignore`，包括 `!` 否定规则。顶层 `repos/AGENTS.md` 会保留，实际仓库工作区、任何 `.git` 和事务临时文件不会进入快照。固定排除项和 `.gitignore` 之外的内容会原样保存，这不是秘密扫描。

模板生命周期命令为：

```sh
gits template update fullstack ./template-seed
gits template rename fullstack team-default
gits template remove team-default --yes          # 移入 trash
gits template remove team-default --purge --yes  # 永久删除
```

内置 `default` 模板始终可列出和使用，但不能更新、重命名或删除。模板名与新任务目录名彼此独立；使用已保存模板时不会再次应用快照中的 `.gitignore`。

### 只检出仓库中的部分目录

仓库配置可用可选的 `checkout` 数组限制工作区中实际物化的目录。例如，下面仍然创建一个可编辑、可提交和可推送的完整 Git 仓库，但工作区只展开 `knowledge/`：

```jsonc
{
  "repos": {
    "backend-aio": {
      "url": "git@github.com:example/application.git",
      "branch": "feat/my-task",
      "from": "origin/main",
      "checkout": ["knowledge"],
    },
  },
}
```

`checkout: null` 表示完整检出；改为数组时必须是非空的仓库相对目录列表。旧配置为保持兼容仍可省略该字段，但 `gits init` 不再依赖这种隐式写法。v1 使用 Git cone-mode sparse-checkout，不接受绝对路径、`..`、反斜杠、glob、单文件或 `.git` 管理路径。cone mode 会保留仓库根部的直接文件，但不会物化其他未选择的子目录。

```sh
gits install backend-aio
gits status backend-aio
```

`install` 不仅安装缺失仓库，也会对齐已有且处于可安全操作状态的仓库：修改 `checkout` 后再次运行 `install` 即可。若工作区有任何未提交或未跟踪改动，CLI 会拒绝改变检出范围；`status` 会用 `checkout-different` 标记配置漂移，`switch` 在切换任务分支后会重新应用已配置的局部检出。配置的目录在目标 `HEAD` 中不存在时，安装以 `checkout-path-missing` 失败，并且不会留下新仓库。

局部检出与 repo mirror 是正交能力。Mirror 始终按规范化远端身份保存完整 bare repository；`checkout` 不参与 mirror key，同一远端的多个不同目录视图会复用同一个 mirror：

```sh
gits repo-mirrors add --from-task backend-aio --yes
gits install backend-aio
```

默认的非 `dissociate` 安装继续通过 alternates 借用 mirror objects。局部检出只减少 Task 工作区物化的文件，不承诺减少完整 Mirror 的对象占用，也不会自动启用 partial clone。

## 命令

```sh
gits init [directory] [--template <name> | --from <source-task-dir>] [--dry-run]
gits template add <name> <source-directory> [--dry-run]
gits template list [--wide]
gits template update <name> <source-directory> [--dry-run]
gits template rename <name> <new-name>
gits template remove <name> [--purge] [--yes]
gits install [-j <jobs>] [repo...]
gits status [repo...]
gits fetch [-j <jobs>] [repo...]
gits switch [--stash] [-j <jobs>] [repo...]
gits push (--all | <repo...>) [--dry-run]
gits repo-mirrors [name...] [--wide]
gits repo-mirrors add <url>... [--name <name>] [--alias <url>...] [--schedule <auto|off|cron>]
gits repo-mirrors add --from-task [repo...]
gits repo-mirrors set <name>... [--url <url>] [--add-alias <url>...] [--remove-alias <url>...] [--schedule <auto|off|cron>]
gits repo-mirrors fetch [name...] [--maintenance] [-j <jobs>]
gits repo-mirrors path <name>
gits repo-mirrors logs <name> [--lines <n>] [--follow]
gits repo-mirrors doctor [name...] [--remote] [--deep] [--fix]
gits repo-mirrors remove <name>... [--detach-dependents | --force] [--purge]
gits uninstall [--dry-run] [--detach-dependents | --force] [--yes]
```

任务命令会从当前目录开始，向上查找最近的 `task.config.jsonc`。可使用类似 Git 的 `-C` 从其他目录操作任务：

```sh
gits -C tasks/task-template-import status --json
```

任务命令的 `--json` 返回稳定的 `{ command, ok, repos }` 结构，`init` 另带模板来源摘要；template 命令返回 `{ command, ok, templates }`，mirror 命令返回 `{ command, ok, mirrors }`。Incur 还提供命令 schema、shell 补全、`--llms`、MCP 和后续操作建议（CTA）。

## Uninstall

先查看将被清理的全部 gits 持久化路径：

```sh
gits uninstall --dry-run
```

确认后，卸载会停止并删除属于当前 `GITS_HOME` 的 LaunchAgent/systemd user timer（包括 Linux timer enablement symlink），永久删除 templates、mirrors、配置、状态、日志、锁、临时文件和 trash，最后删除 `GITS_HOME` 本身：

```sh
gits uninstall --yes
```

如果任务仓库仍通过 alternates 借用 mirror objects，默认卸载会拒绝执行。推荐先安全复制所需对象并校验仓库；只有明确接受这些仓库可能损坏时才使用 `--force`。强制模式会在危险路径与 ownership 校验通过后，绕过依赖和 mirror 健康检查，因此损坏的 config、dependency state 或 bare repository 也不会阻止最终清理：

```sh
gits uninstall --detach-dependents --yes
gits uninstall --force --yes
```

CLI 只删除自己拥有的运行数据和原生调度投影，不遍历或删除任务工作区，也不删除 pnpm/npm/Homebrew 管理的可执行文件或全局链接；包本身仍应由原安装工具移除。

机器级持久化路径统一登记在 `packages/core/src/service/gitsPersistenceRegistry.ts`，包括默认数据根、根目录内的受管目录/文件，以及必须投影到操作系统目录的调度文件。新增功能不能自行硬编码新的机器级目录；先登记后复用，`uninstall --dry-run` 和真正清理会自动获得同一份清单。

## Repo Mirrors

`repo-mirrors` 管理机器级 Git 对象镜像。创建一次后，原有的 `gits install` 会按规范化远端地址自动匹配健康镜像，不需要增加安装参数：

```sh
gits repo-mirrors add git@host:team/api.git --name api --yes
gits repo-mirrors add --from-task --yes
gits repo-mirrors list --wide
gits install
```

这里的 mirror 是由 `git clone --mirror` 创建的 bare repository：它只有 Git 对象、refs 和配置，没有可编辑的 checkout 工作区。默认数据和配置位于 `~/.gits`：

```text
~/.gits/
├── config.jsonc
├── templates/<name>/{manifest.json,content/}
├── repo-mirrors/<name>.git/
├── state/repo-mirror-dependencies/<name>.json
├── logs/repo-mirrors/<name>/*.jsonl
├── locks/
├── bin/gits-repo-mirror-runner.cjs
├── bin/gits-repo-mirror-worker.mjs
├── tmp/
└── trash/
```

`repoMirrors` 在 `~/.gits/config.jsonc` 中是数组，元素的 `name` 是稳定主键；`urls` 也是非空数组，`urls[0]` 是活动 fetch 地址，其余地址是用于自动匹配的 aliases。因此同一仓库的 SSH 和 HTTPS 地址可以归到一个 mirror：

```jsonc
{
  "version": 1,
  "repoMirrorsSettings": { "maxConcurrentFetches": 4 },
  "repoMirrors": [
    {
      "name": "api",
      "urls": ["git@host:team/api.git", "https://host/team/api.git"],
      "schedule": { "cron": "17 1-23/6 * * *" },
    },
  ],
}
```

镜像日志不会无限增长：每个 mirror 最多保留 20 次、10 MiB 的完成日志，全部 mirror 的完成日志合计上限为 256 MiB；异常退出留下的 active 日志会在确认 writer 不存活且超过 24 小时后清理，绝对最长保留 7 天。launchd/systemd 的 emergency log 每个文件上限 1 MiB，并只保留两个备份（每个 mirror 最多约 3 MiB）。

未传 `--schedule` 的新 mirror 默认约每 6 小时稳定错峰刷新。macOS 使用用户级 LaunchAgent，Linux 使用 `systemd --user` timer；配置仍以 `~/.gits/config.jsonc` 为事实来源，系统目录中只保存可重建的调度投影。`list --wide` 会显示本机 mirror 路径、活动 URL、aliases、cron、下一次执行时间、原生 job 和实际生成的 fetch 命令。也可以直接使用：

发布包会把依赖已打包的 scheduler worker 复制到 `~/.gits/bin`，原生任务不会引用 npm/pnpm 安装目录；worker 仍由 runner 校准时记录的 Node 可执行文件启动。升级或重新安装后，第一次运行新版 `gits` 会刷新已有 runner；创建或更新调度时也会重建它。只卸载 npm 包不会删除 `~/.gits`，所以 Node 可执行文件仍存在时，已安装的 worker 可以继续运行；重新安装后第一次调用会把 runner 对齐到当前版本。需要停止调度并删除机器数据时应使用 `gits uninstall`。`gits repo-mirrors doctor --fix --yes` 会先重建 runner 和 worker，再读取配置或修复 mirror，因此配置或 mirror 损坏不会阻止 runner 校准。

```sh
gits repo-mirrors path api
gits repo-mirrors fetch api
gits repo-mirrors set api --schedule off
gits repo-mirrors logs api --lines 200
gits repo-mirrors doctor api --deep
```

安装默认使用 `git clone --reference-if-able` 并保留 alternates，因此速度更快、额外磁盘占用更少，但新仓库会借用 mirror 中的 Git objects。CLI 会登记并保护这种依赖，阻止直接删除、修复或 GC mirror。只有某个任务仓库明确要求独立对象库时，才在它的 `task.config.jsonc` 中配置：

```jsonc
{
  "repos": {
    "api": {
      "url": "git@host:team/api.git",
      "branch": "feat/example",
      "from": "origin/main",
      "dissociate": true,
    },
  },
}
```

删除策略是显式的：

```sh
gits repo-mirrors remove api --yes                       # 无依赖时移入 trash
gits repo-mirrors remove api --detach-dependents --yes   # repack、校验依赖仓库后安全删除
gits repo-mirrors remove api --force --yes               # 跳过保护，依赖仓库可能立即损坏
gits repo-mirrors remove api --purge --yes               # 不进 trash，永久删除
```

`--force` 与 `--detach-dependents` 互斥，也不会绕过活动锁或路径校验。LFS payload 和 submodule 都有独立的存储与远端，不会因为父仓库 mirror 自动加速。

## 关键行为

- `init` 可重复执行，只补齐缺失的脚手架，不覆盖已有内容。
- 配置中的 `<...>` 占位值会阻止 `install`、`status`、`fetch`、`switch` 和 `push` 执行。
- `init <directory> --from <source-task-dir>` 按 `.gitignore` 导入除顶层 `repos/` 外的源内容，并在同一事务中补齐缺失的默认骨架；它不访问远程或修改源目录。
- `template add/update` 要求源目录已经包含完整默认骨架；命名模板是机器级独立快照，实例、模板和原始源目录之间没有持续关联。
- 导入只会替换目标目录中由脚手架生成的默认内容；目标已有自定义内容时直接失败，避免覆盖用户文件。
- `install` 先在工具临时目录 clone，局部检出与分支准备完成后才原子移动到目标目录；对已有仓库只会安全对齐 `checkout`，不会借机修改其他 Git 状态。
- `install` 会透明尝试匹配健康 repo mirror；配置、镜像或锁异常时无损回退普通 clone。
- 默认 mirror 安装保留受保护的 alternates 依赖；仅 `task.config.jsonc` 中显式 `dissociate: true` 的仓库会复制对象并断开依赖。
- `install`、`fetch` 和缺失分支的准备支持并发；TTY 模式使用 Listr2 固定显示每个仓库的状态和所属 Git 输出，JSON/agent/pipe 模式不输出动态控制字符。
- `switch` 只有显式传入 `--stash` 才会保存脏工作区，且不会自动恢复 stash。
- `checkout` 只控制工作区目录；路径列表不会进入 mirror 定义，同一远端的完整检出和多个局部检出共享同一个 mirror。
- `push` 是唯一会写入远程的命令；不会 force push、删除分支、自动 merge 或 rebase。
- SSH、SCP 和 HTTPS 形式的同一 host/path 仓库会被识别为同一个仓库，并标记为 `url-different`。

## 目录组织

```text
apps/cli/src/
├── contract/        # CLI 类型、常量和可注入接口
├── service/         # CLI 启动、交互、错误、输出与进度 Service
├── module/          # Task、TaskTemplate、RepoMirror、Uninstall Command 类
├── bootstrap/       # 唯一 Injector 组合根
├── dependencies.ts  # CLI 默认绑定
└── index.ts         # 进程入口

packages/core/src/
├── contract/        # 跨包类型和所有注入接口/Identifier
├── service/         # Git、文件、进程、并发等基础 Service
├── module/          # Task、TaskTemplate、RepoMirror、Uninstall 业务 Service
├── dependencies.ts  # Core 默认绑定
└── index.ts         # Core 对 CLI 的公开面
```

约束是“依赖接口、注册实现”：构造器只注入 `I...Service` Identifier，具体实现只在 `dependencies.ts` 中通过 `{ useClass }` 绑定。一次 CLI 调用只创建一个 Injector。

TypeScript 使用 Bundler 模块解析，源码相对导入不写文件扩展名，例如 `import './Foo'`。tsdown 会解析 `.ts` 模块并生成可由 Node.js 直接执行的 ESM，因此源码中不需要伪写 `.js` 后缀，仓库也不包含手写 JavaScript 源文件。

Core 包使用单一的条件导出映射：显式启用 `@usegits/source` 时解析到 `src/index.ts`，普通类型消费者解析到 `dist/index.d.ts`，默认运行时解析到 `dist/index.js`。共享 TypeScript 配置通过 `customConditions` 启用源码条件，`pnpm dev`、测试和 Rolldown 构建也显式启用同一条件，保证静态类型与开发运行时都读取实时源码。Core tarball 同时包含 `src`、`templates` 和 `dist`，因此每个导出目标都真实存在；打包和发布不再改写清单。CLI 的开发链接与发布包则始终运行同一个 `dist/index.js`。

## 校验

```sh
pnpm check
```

该命令会执行格式检查、lint、类型检查、架构依赖门禁、测试和构建。CLI 集成测试使用隔离的本地 bare Git remote，覆盖脚手架、`-C`、一次性目录导入、命名模板生命周期、配置占位符、安装、状态、push 和 `switch --stash`；并发测试覆盖 Listr2 展示开启时的并发上限、稳定结果顺序、独立失败和中断语义。

## 作者与许可证

`gits` 由 [Mobiwuhu](https://github.com/Mobiwuhu) 创建并维护。

本项目采用 [Apache License 2.0](LICENSE) 开源。再分发源码或改编作品时，须按照许可证保留适用的版权、署名和 [`NOTICE`](NOTICE) 声明。
