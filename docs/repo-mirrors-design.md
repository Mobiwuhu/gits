# `repo-mirrors` v1 设计与实现说明

> 状态：v1 已实现，文末保留后续强化项  
> 日期：2026-09-10  
> 范围：`gits` CLI 的仓库镜像管理、持久化调度，以及现有任务仓库安装流程的镜像加速

当前实现已覆盖本文的用户闭环：复数命令面、`~/.gits` JSONC/裸镜像、URL aliases、批量并发、有界结构化日志、native emergency log 轮转、macOS launchd/Linux systemd user 调度、install 自动命中与 fail-open、默认 alternates 及依赖保护、显式 dissociate、局部 checkout、安全 detach、force remove、doctor 和显式 GC。operation journal、trash 自动回收、孤儿 managed artifact 清理，以及真实 GUI/user-manager 的跨平台压力 CI 仍属于后续 hardening；下文遇到这些内容时以“后续”标记，不作为当前代码已完成能力。

## 1. 结论先行

建议把“仓库镜像”设计成唯一的一等资源，命令组固定为复数形式：

```text
gits repo-mirrors ...
```

每个 mirror 同时拥有远端地址、本地 bare mirror、可选调度配置和运行状态。调度不是另一类顶层资源，因此不再引入 PRD 中的 `ref` 和 `schedule` 两套命令。

核心方案如下：

- 用户意图和镜像数据统一放在 `~/.gits`。
- macOS 使用用户级 `launchd` LaunchAgent，Linux 使用 `systemd --user` timer。
- 为了让操作系统自动发现任务，生成的 plist/unit 必须放入操作系统规定的目录；它们只是由 `~/.gits/config.jsonc` 重建出来的投影，不是数据源。
- 默认给新 mirror 生成按“本机 installation id + 仓库 identity”稳定错峰的调度；用户也可以指定便携的五段 cron 或关闭调度。
- 默认 `list` 直接展示 bare mirror 的本机绝对路径；`--wide` 再展示完整 URL、调度表达式、下一次计划执行时间以及实际生成的 fetch 命令。
- 批量 add/fetch/set/remove 通过 `IConcurrencyService` 保持既有 `-j` 产品语义：默认最多 4 个、结果顺序稳定、单项失败不阻止其他项、存在任何失败时退出码为 1；独立的原生调度进程还要经过机器级跨进程并发槽。
- 通用能力优先采用开源库：`cron-parser` 处理 cron，`@bybrave/proper-lockfile2` 处理跨进程锁和并发槽，`pino` 处理结构化日志，`table` 处理 CLI 表格的 Unicode/ANSI 宽度与换行，`plist` 生成 macOS property list；已有实现已经精确满足契约时不为了替换而增加依赖。
- JS 生态没有一个足够成熟、同时完整覆盖 macOS 定时 LaunchAgent 与 Linux systemd user timer 的通用库，因此只有这一小块保留两个很薄的自有 adapter。
- mirror 设置完成后，现有 `gits install` 自动匹配同一远端的健康 mirror，并在持有 mirror 使用锁期间使用 `git clone --reference-if-able` 加速。默认保留受登记和保护的 alternates 依赖；只有任务仓库显式配置 `dissociate: true` 才追加 `--dissociate`。配置、锁或 mirror 异常时无损退回普通 clone，无需额外增加 `ref clone` 命令。
- 任务仓库可用 `checkout: ["knowledge"]` 只物化指定的仓库内目录；该 consumer 属性不改变 mirror 身份或完整性，`install`/`status`/`switch` 在既有命令面内完成安装、漂移检测和安全对齐。

## 2. 目标与非目标

### 2.1 目标

1. 一条命令查看本机全部 Git repo mirrors，以及它们的远端、路径、最近一次 fetch、下一次 fetch、调度和健康状态。
2. 支持 mirror 的批量增删改查和并行 fetch。
3. CLI 退出或机器重启后，调度仍由 macOS/Linux 原生用户级服务保存并执行。
4. 用户可以看到并手动执行系统实际会调用的命令。
5. 不要求 root，不默认写 `/var/lib`，不改系统级 daemon。
6. 保持现有 CLI 的分层、JSON 输出和并发行为一致。
7. mirror 故障不能让现有任务安装功能失效；最差退回普通 clone。

### 2.2 非目标

- 不实现一个常驻 Node daemon。
- 不把 cron/crontab 当作第三套后备调度系统。
- 不在 v1 支持秒级 cron、任意时区、随机表达式或 Quartz 扩展语法。
- 不在自动 fetch 后隐式执行 `git gc`、`repack` 或对象 prune。
- 不允许用户在调度定义中注入任意 shell 命令。
- 不自动执行 `loginctl enable-linger` 等改变系统策略或可能需要管理员权限的操作。
- 不在 v1 提供 Windows 原生调度；没有 systemd user manager 的 Linux/WSL 环境仍可使用 CRUD、手动 fetch 和 install 加速。
- 不缓存 Git LFS 对象，也不自动把父仓库的 submodule 纳入 mirror。

### 2.3 用户使用闭环

mirror 是全局机器资源，任务配置仍然只保存仓库 URL，不保存 mirror name。用户只需要显式创建一次：

```text
# 从 URL 创建
gits repo-mirrors add git@code.byted.org:acme/frontend.git

# 或在任务目录中，把 task.config.jsonc 的全部/指定仓库批量加入
gits repo-mirrors add --from-task
gits repo-mirrors add --from-task api web
```

之后正常使用既有命令，不需要记住 mirror key：

```text
gits install
```

`install` 根据规范化 URL 自动匹配 mirror。TTY 模式通过 Listr2 为每个正在处理的仓库保留独立任务行，最终结果再显示命中的 mirror、本机路径和是否 dissociated；未命中、mirror 缺失或损坏时退回普通 clone。它不会为了便利而在 `install` 中隐式创建可能占用大量磁盘的 mirror。

日常管理只在需要时使用：

```text
gits repo-mirrors list                 # 看全部镜像、本机路径和上次/下次 fetch
gits repo-mirrors list --wide          # 再看 URL、磁盘占用和实际调度命令
gits repo-mirrors fetch                # 立即并行刷新全部镜像
gits repo-mirrors fetch frontend       # 只刷新一个
gits repo-mirrors path frontend        # 输出 bare mirror 的本机绝对路径
gits repo-mirrors set frontend --schedule off
gits repo-mirrors set frontend --schedule auto
gits repo-mirrors logs frontend        # 查看结构化运行日志
```

既有 `gits fetch` 仍只更新任务工作区；`gits repo-mirrors fetch` 才更新全局 bare mirrors，二者不偷偷互相触发。

## 3. 公开 JS 生态调研

调研信息截至 2026-09-10。cron 解析、并发控制、跨进程锁、结构化日志和 CLI 表格都有可直接采用的开源库；缺口仅在原生持久化调度：目前没有一个成熟 JS 库同时完整覆盖 macOS LaunchAgent 与 Linux systemd user timer 的注册、更新、删除、状态检查和故障恢复。因此本提案只为两个原生 scheduler 保留薄 adapter，其余通用能力尽量复用开源实现。

| 项目 | 能力 | 适用性判断 |
| --- | --- | --- |
| [`cron-parser`](https://github.com/harrisiirak/cron-parser) | TypeScript cron 解析、字段操作、时区/DST 和前后执行时间计算 | 建议采用。只负责纯计算，不负责持久化或启动任务，职责边界正好 |
| [`p-map`](https://github.com/sindresorhus/p-map) | 对 async mapper 做受限并发、保序和取消 | 调研后不采用。其 signal 会使外层立即以 `AbortError` 拒绝，而已启动 mapper 仍继续；要保持现有“停止派发、等待在途任务、未启动项为 not-run”契约仍需保留大部分自有协调代码 |
| [`@bybrave/proper-lockfile2`](https://github.com/bybraveHQ/proper-lockfile2) | 跨进程/跨机器文件锁、原子 `mkdir`、heartbeat、stale 和重试 | 建议采用。它是 `proper-lockfile` 的维护兼容 fork，修复 stale reclaim 双持锁竞态、内置 TypeScript 类型和 Node 22 CI；仍需精确锁版本并做 macOS/Linux 休眠与压力测试 |
| [`fs-ext`](https://github.com/baudehlo/node-fs-ext) | Unix `flock(2)`/`fcntl(2)` advisory lock | 作为兼容测试失败时的备选；进程退出和休眠语义更接近 OS lock，但引入 native addon 构建与跨 Node ABI 分发成本，且不适合网络文件系统 |
| [`pino`](https://github.com/pinojs/pino) | 结构化 JSON 日志 | 建议采用，以 in-process destination 向每次唯一 run 文件写入；不使用 worker transport，也不让多个短生命周期进程共享一个待轮转文件 |
| [`pino-roll`](https://github.com/mcollina/pino-roll) | 单进程日志文件轮转 | 调研后不采用。其默认 retention 只统计当前进程创建的文件，多短进程共享同一文件还会与 native stdout writer 竞争；结构化日志用唯一 run 文件，应用依赖加载前的 emergency log 则由稳定 runner 以 Node `fs` 做 1 MiB 定长写入和两个备份，边界更明确 |
| [`table`](https://github.com/gajus/table) | 把二维数据渲染成文本表格，支持全角字符、ANSI、列宽和换行 | 建议采用。返回字符串，能直接接入当前 presenter；使用无边框样式保持现有紧凑输出，由薄 facade 固定 TTY/pipe、长字段与 snapshot 语义 |
| [`listr2`](https://github.com/listr2/listr2) | 并行任务列表、每任务输出流、TTY 重绘和非 TTY renderer | 建议采用。TTY 下每个仓库使用固定任务行并接管对应 Git stdout/stderr；agent、JSON 和非 TTY 模式禁用动态 renderer，最终领域结果仍交给 Incur |
| [`cli-table3`](https://github.com/cli-table/cli-table3) | 轻量 CLI 表格、ANSI-aware 截断、对齐和自定义边框 | 可用备选，但主要 API 仍是 CommonJS 风格的可变 Table；本项目由 tsdown 生成 Node ESM，`table` 的具名函数和现有纯 formatter 更贴合 |
| [`@oclif/table`](https://github.com/oclif/table) | TypeScript-first 表格、自动终端宽度、Ink/CI renderer | 功能完整但 v1 会引入 Ink、React 等较重运行时，而本项目使用 Incur 且只需要确定性的字符串 renderer，暂不采用 |
| [`plist`](https://github.com/TooTallNate/plist.js) | 从 JavaScript 对象生成 Apple XML property list | 建议采用。v5 是带内置类型的 TypeScript 实现；用它负责 XML 编码和转义，再用 macOS 自带 `plutil -lint` 做平台校验，不手拼 plist XML |
| [`unitup`](https://github.com/litepacks/unitup) | 可编程的跨平台 service manager，并公开 JS API | 可参考 service adapter 结构，但其定时器文档明确是 systemd/Linux 能力，不能解决 macOS 定时任务 |
| [`opencode-scheduler`](https://github.com/different-ai/opencode-scheduler) | 已落地 launchd/systemd 的跨平台任务调度 | 可参考产物、日志和恢复设计；它是面向 OpenCode 的应用插件，不是稳定的通用 scheduler library，且部分 macOS 实现仍兼容旧式 `launchctl load/unload` |
| [`@minagents/wua`](https://github.com/minhvoio/wua_wake-up-ai) | 有独立 launchd/systemd adapter，并采用现代 `bootstrap` 流程 | 可参考目录拆分和跨平台测试；当前只覆盖较固定的每日唤醒场景，不足以承载本 CLI 的 cron/CRUD 语义 |
| [`node-schedule`](https://www.npmjs.com/package/node-schedule)、[`croner`](https://github.com/Hexagon/croner) | Node 进程内定时 | 不采用。进程退出后任务消失，不能满足持久化要求 |

### 3.1 依赖决策

v1 建议采用：

```text
cron-parser       cron 校验与 next-run 计算
ConcurrencyService 单进程受限并发
listr2            TTY 并行任务状态和每任务 Git 输出归属
proper-lockfile2 跨 CLI/调度进程互斥及机器级并发槽
pino            结构化日志
table           人类可读 CLI 表格
plist           macOS LaunchAgent plist 序列化
```

项目用窄 Service 接口固定自己的产品契约：

- `IConcurrencyService` 固定结果类型、worker 调度、默认并发数、进度回调和中断后的 `not-run` 表达；
- `IRepoMirrorLockService` 固定 config、mirror 和全局 slot 三类锁、等待策略和业务错误，原子性、heartbeat、stale、retry 和原子 reclaim 交给 `@bybrave/proper-lockfile2`；
- `IRepoMirrorLoggerService` 固定字段、脱敏、每次运行的唯一文件、大小/数量 retention 和 flush 生命周期，JSON 编码交给 `pino`；
- `CliOutputService` 固定 stdout/stderr 行为，`formatCliTable` 把可见宽度、ANSI 与全角字符处理交给 `table`；
- `renderLaunchdPlist` 把 scheduled invocation 映射为 plist 对象，XML 构建和转义交给 `plist`，平台合法性仍以 `plutil -lint` 为准；
- portable cron validator 只限制本项目承诺的五段语法，日期取值和 next-run 交给 `cron-parser`。

只有 cron 到 plist/unit 的编译和原生任务注册没有合适的统一库，需要自有 launchd/systemd adapter。这里也只包装官方命令和确定性模板，不扩展成通用 scheduler framework。

## 4. 对原 PRD 的关键修正

原 PRD 仍可作为需求背景，但以下内容不建议照搬：

| 原方向 | 本提案 | 原因 |
| --- | --- | --- |
| 顶层 `ref` 与 `schedule` 两类资源 | 唯一命令组 `repo-mirrors`，schedule 是 mirror 属性 | 用户操作的是仓库镜像；独立 schedule 会产生名称关联、级联删除和状态漂移 |
| 配置分散在 `~/.config/<cli>`，Linux mirror 默认放 `/var/lib` | 用户意图和数据统一在 `~/.gits` | 普通用户无需提权，备份、迁移和排障路径一致 |
| 所有文件都放 `~/.gits` | 仅 source of truth 放 `~/.gits`；OS 投影放原生扫描目录 | launchd/systemd 不会从任意目录自动发现用户任务 |
| 从 `launchctl list` 获取 next run | 根据保存的 cron 自行计算下一次执行时间 | `launchctl list` 的稳定字段只有 PID、上次退出状态和 label，并不提供 next-run |
| macOS 使用 `launchctl load/unload` | 使用 `bootstrap/bootout/print`，仅用 `enable` 清理旧 disabled override | 采用现代 launchctl 接口，off 不额外写入持久禁用状态 |
| 用 `flock` 避免重入 | 使用跨平台的 `@bybrave/proper-lockfile2` | stock macOS 不保证提供 `flock` 命令，也无需自研 heartbeat/stale lock |
| 设置 `gc.auto=0` 就足够 | fetch 明确传 `--no-auto-maintenance`，并设置 `maintenance.auto=false`、`gc.auto=0`、`gc.autoDetach=false` | Git fetch 默认可能触发 auto maintenance；仅关闭 auto-gc 不能完整表达“不自动维护” |
| 自动打开 Linux linger | `doctor` 只检测并给出建议 | linger 是机器策略，可能需要权限，也不应由普通 CRUD 隐式修改 |
| schedule 配置保存 last/next 状态 | 配置只保存稳定意图；运行状态单独保存 | 避免配置文件被每次运行改写，也避免缓存状态被误认为事实 |
| 提供单独的 reference clone 命令 | 现有 `install` 自动发现 mirror 并安全降级 | 减少命令概念，用户不需要理解 Git alternates |

## 5. 领域模型

### 5.1 一个 mirror 包含什么

这里的 bare repository 只有 Git 对象库、refs 和仓库配置，没有可编辑文件和 checkout 工作区；`git clone --mirror` 又在 bare 的基础上镜像全部 refs，并配置 `+refs/*:refs/*` fetch refspec。它是 `gits install` 的本机对象缓存，不是让用户直接开发的工作目录。

```ts
interface RepoMirrorDefinition {
  name: string
  urls: readonly [string, ...string[]]
  schedule?: {
    cron: string // 已解析且稳定保存的五段 cron
  }
}

interface GitsConfigV1 {
  version: 1
  repoMirrorsSettings?: {
    maxConcurrentFetches?: number
  }
  repoMirrors: RepoMirrorDefinition[]
}
```

以下内容由定义推导，不重复写入配置：

- bare mirror 路径；
- 规范化远端 identity；
- 当前优先 fetch URL（始终为 `urls[0]`）；
- 原生 job label 和投影路径；
- 操作系统 backend；
- 用户可执行的 fetch 命令。

以下内容属于观测状态，最新摘要写入 `state/`，历史事件写入有保留上限的单次运行日志，不写入配置：

- 最近一次尝试和成功时间；
- 退出码、耗时和错误摘要；
- 当前 scheduler 是否 loaded/enabled；
- 原生文件是否发生 drift；
- 当前是否被另一个 fetch/install/remove/repair/maintenance 持锁。

### 5.2 身份与命名

- `name` 是本机稳定主键，创建后不可直接改名；改名在后续版本中作为显式原子操作增加。
- 名称限制为 `[a-z0-9][a-z0-9._-]{0,63}`，避免路径、unit、label 和 shell 转义问题。
- 未传 `--name` 时从远端仓库 basename 推导；冲突时要求用户显式命名，不静默加序号。
- `repoMirrors` 是数组，`name` 是数组元素上的显式稳定主键，不再借用 JSON object key 表达身份。
- `urls` 是非空有序数组：第一项是唯一活动 fetch URL，后续项只是 install 匹配 aliases；v1 不把 alias 自动当成 fetch fallback。
- 使用项目现有的 `normalizeGitUrl` 规则规范化 URL，使常见 SSH、SCP-like SSH 和 HTTPS 地址能够自动识别；还要先用 `git ls-remote --get-url` 无网络展开用户的 `url.*.insteadOf` 配置。
- 自动聚合只发生在规范化 identity 完全相同时；用户通过显式 `--alias`/`--add-alias` 可以声明 host alias、代理域名等规范化后不同但确属同一仓库的地址。
- 任一规范化 URL identity 默认只能映射到一个 mirror，避免 install 得到歧义结果；真正切换 fetch 来源使用 `set --url`，而不是在失败时暗中尝试其他 alias。

### 5.3 状态是正交的

不要用一个巨大的 `status` 枚举混合所有情况。展示层组合以下三个维度：

```ts
type RepositoryState = 'initializing' | 'ready' | 'missing' | 'invalid'
type ScheduleState = 'off' | 'ready' | 'unavailable' | 'drifted'
type LastRunStatus =
  'never' | 'running' | 'success' | 'failed' | 'interrupted' | 'skipped-locked'
```

例如一个 mirror 可以同时是 `repository=ready`、`schedule=drifted`、`lastRun=success`。这样用户能明确知道是仓库坏了，还是仅调度投影需要修复。

## 6. 命令面

### 6.1 总览

```text
gits repo-mirrors
gits repo-mirrors list [<name>...] [--wide] [--json]
gits repo-mirrors path <name> [--json]
gits repo-mirrors add <url>... [--alias <url>...] [--name <name>] [--schedule <auto|off|cron>] [--dry-run] [--yes] [-j <jobs>]
gits repo-mirrors add --from-task [<repo>...] [--schedule <auto|off|cron>] [--dry-run] [--yes] [-j <jobs>]
gits repo-mirrors set <name>... --schedule <auto|off|cron> [-j <jobs>]
gits repo-mirrors set <name> [--url <url>] [--add-alias <url>...] [--remove-alias <url>...]
gits repo-mirrors remove <name>... [--detach-dependents | --force] [--yes] [--purge] [-j <jobs>]
gits repo-mirrors fetch [<name>...] [--maintenance] [-j <jobs>] [--json]
gits repo-mirrors logs <name> [--lines <n>] [--follow]
gits repo-mirrors doctor [<name>...] [--remote] [--deep] [--fix] [--yes] [--json]
gits uninstall [--dry-run] [--detach-dependents | --force] [--yes] [--json]
```

`repo-mirrors` 公开命令只保留 `list/path/add/set/remove/fetch/logs/doctor` 八个动词。schedule 是 mirror 属性，投影 reconcile 是 `doctor --fix` 的内部动作，reference clone 是 `install` 的自动优化；不再为这些实现概念增加独立命令。`uninstall` 是机器级生命周期命令，不属于单个 mirror 的 CRUD。

约定：

- `gits repo-mirrors` 等价于 `gits repo-mirrors list`。
- 不提供单数 `repo-mirror` alias，避免文档和脚本出现两套名字。
- `path` 在普通模式下只向 stdout 输出 bare mirror 的本机绝对路径，不带 label 或其他提示，允许直接用于 shell command substitution。
- `path` 只要求 definition 存在：即使 repository 当前 missing/invalid 也返回其确定性目标路径；name 不存在时 stdout 为空并以非零状态退出。
- `list <name> --wide` 承担原 `show` 的单项详情能力，不再保留重复的 `show` 命令。
- list/fetch/doctor 未给名称时选择全部 mirror。
- set/remove 必须显式给出名称，避免无意修改全部资源。
- `add` 先按规范化 identity 对 URL 分组：同组 URL 创建一个 mirror，不同组并行创建多个 mirror。
- `--name` 和 `--alias` 只允许用于最终恰好得到一个 identity 分组的 add；`--alias` 是用户对等价仓库的显式声明，不参与自动分组。
- `--from-task` 从当前任务配置读取全部或指定 repo URL，不能与 URL 参数、`--name` 或 `--alias` 同时使用。
- URL 变更只允许操作单个 name；`--url` 设置唯一活动 fetch URL，旧活动 URL 默认保留为 alias；`--add-alias`/`--remove-alias` 可重复。
- 不能删除活动 URL；新增 alias 即使规范化 identity 不同也必须是显式参数，且不能已归属于另一个 mirror。
- `set --url` 只能选择已经配置的 URL，或与同一条命令中的 `--add-alias` 配合；禁止一个没有显式 alias 声明的新地址直接成为带 `--prune` 的 fetch 来源。
- `add` 和 `add --from-task` 必须幂等：完全已有的 URL 返回 `unchanged`，同 identity 的新传输地址补为 alias，不能让重复执行成为错误。
- `add` 表示创建资源；不使用容易和任务初始化混淆的 `init`。
- `set` 表示修改定义；不使用容易被理解为“拉取更新”的 `update`。
- 批量 add 在真正 clone 前输出将创建的 mirrors、路径、schedule 和数量；交互模式确认后执行，自动化使用 `--dry-run` 预览或显式 `--yes`。
- `remove` 默认拒绝处理仍被任务仓库借用的 mirror；`--detach-dependents` 先让这些仓库自包含并校验，`--force` 则明确绕过依赖保护。两者互斥。
- `--force` 只绕过依赖保护，不绕过 name/path 校验、managed 路径边界、per-mirror lock 或确认；`--purge` 只决定永久删除还是移入 trash，与是否强制是两个正交选项。

### 6.2 `list` 输出

默认输出优先回答“有什么、本机在哪里、是否可用、何时 fetch”，避免每次列举时重复打印长命令：

```text
$ gits repo-mirrors list
NAME        PATH                                                REPOSITORY  LAST FETCH       NEXT FETCH
frontend    /Users/alice/.gits/repo-mirrors/frontend.git         ready       2h ago · ok      in 3h 12m
sdk         /Users/alice/.gits/repo-mirrors/sdk.git              ready       yesterday · ok   off
```

说明：

- 当前 CLI 的 `command-output.ts` 是手工按 JavaScript `string.length` 计算宽度，再用 `padEnd` 拼接列；中文、emoji 和 ANSI 样式的 code-unit 长度不等于终端显示宽度，长路径也没有统一的 wrap/truncate 策略。实现 repo-mirrors 前先抽取共享 `CliTableRenderer`，用 `table` 替换这段宽度算法，并让现有 status/fetch/install 输出复用，避免新旧命令各有一套表格实现。
- 普通 `list` 使用无边框紧凑表格，保留当前“两空格分列”的视觉风格；表格 renderer 只服务人类输出，`--json` 直接序列化领域结果，绝不经过表格或 ANSI 处理。
- `NEXT FETCH` 是由保存的表达式和当前时间计算出的 calendar occurrence，不伪装成操作系统内部状态，也不把 catch-up、slot 等待或 drift 后的实际启动时间混进去。
- `--wide` 不把 URL、command 等长文本继续横向堆成十几列；它先输出同一张摘要表，再按 mirror 输出无边框的 `FIELD  VALUE` 两列表格，展示活动 fetch URL、aliases、cron、绝对 scheduled command、backend、native job、projection path、磁盘占用和 drift。
- `list <name> --wide` 直接展示该 mirror 的两列完整详情，包括最近运行、日志路径、健康详情和原生状态。
- 当前 renderer 用 `table` 统一处理 Unicode/ANSI 可见宽度、padding 和多行值，TTY 与 pipe 都使用无颜色的确定性布局，不再手写 `string.length + padEnd`。按 `process.stdout.columns` 动态隐藏非关键列可在确有窄终端反馈后补充；精确值始终以 `path`/`--json` 为准。
- 默认表格中的路径允许为适配终端而换行；需要复制或供脚本使用时以 `path`/`--json` 为准确接口。详情表中的绝对路径和命令不能截断或用 `~` 缩写，必要时只换行，保证信息不丢失。
- `logs --lines` 从最近的完成 run 文件向前聚合，`--follow` 优先跟随当前 `.active.jsonl`，没有运行中任务时先输出最后一个完成 run 再等待新文件。

专门获取路径时输出保持极简：

```text
$ gits repo-mirrors path frontend
/Users/alice/.gits/repo-mirrors/frontend.git
```

这样既可以直接检查 bare repository，也可以交给原生 Git：

```sh
git -C "$(gits repo-mirrors path frontend)" show-ref
```

JSON 不复用现有面向任务仓库的 `repos` 字段：

```json
{
  "command": "repo-mirrors list",
  "ok": true,
  "mirrors": [
    {
      "name": "frontend",
      "urls": [
        "git@code.byted.org:acme/frontend.git",
        "https://code.byted.org/acme/frontend.git"
      ],
      "fetchUrl": "git@code.byted.org:acme/frontend.git",
      "path": "/Users/alice/.gits/repo-mirrors/frontend.git",
      "fetchCommand": "/usr/bin/env HOME=/Users/alice GITS_HOME=/Users/alice/.gits GITS_GIT_EXECUTABLE=/usr/bin/git GIT_TERMINAL_PROMPT=0 PATH=/usr/bin:/bin:/usr/sbin:/sbin /Users/alice/.gits/bin/gits-repo-mirror-runner repo-mirrors fetch frontend --source scheduler",
      "fetchInvocation": {
        "executable": "/Users/alice/.gits/bin/gits-repo-mirror-runner",
        "arguments": [
          "repo-mirrors",
          "fetch",
          "frontend",
          "--source",
          "scheduler"
        ],
        "environment": {
          "HOME": "/Users/alice",
          "GITS_HOME": "/Users/alice/.gits",
          "GITS_GIT_EXECUTABLE": "/usr/bin/git",
          "GIT_TERMINAL_PROMPT": "0",
          "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"
        }
      },
      "schedule": {
        "cron": "17 1-23/6 * * *",
        "nextFetchAt": "2026-09-10T13:17:00+08:00"
      },
      "repositoryState": "ready",
      "scheduleState": "ready"
    }
  ]
}
```

### 6.3 批处理与退出语义

所有接受多个目标的命令统一调用 `IConcurrencyService`：

- 默认并发数 `min(4, 目标数)`，可用 `-j` 调整；
- 输出顺序按用户输入或配置顺序稳定，不按完成顺序跳动；
- TTY 动态进度由 Listr2 固定到各目标的任务行，子进程输出写入所属 task，不允许 worker 直接争抢 stdout/stderr；
- agent、JSON 和非 TTY 调用不输出动态进度，结构化 stdout 只包含 Incur 的最终结果；
- 每个 mirror 独立产生结果；一个失败不取消已经开始的其他操作；
- 只要任意目标失败，整体 `ok=false` 且进程退出码为 1；
- 接收到中断时停止派发新任务，并等待正在进行的原子阶段安全结束。

中断后尚未开始的项目返回 `not-run`，已经开始的 worker 仍接收项目现有的 `AbortSignal` 并完成安全收尾。不开启 `p-map` 替换：其 signal 会让外层立即拒绝，而已开始 mapper 仍在运行，与这里“等待在途原子阶段结束后返回完整 summary”的契约不同。

全局配置不能由多个 worker 各自覆写。网络和磁盘重活并行执行，但 definition reservation 和最终 config commit 在一把短时全局锁下串行完成。

`-j` 只约束当前 CLI 进程。所有 manual/scheduler fetch 还必须先获取机器级并发槽，默认总共 4 个；因此即使多个 launchd/systemd job 在同一分钟启动，机器上同时运行的 Git fetch 也不会超过该上限。

## 7. `~/.gits` 存储布局

```text
~/.gits/
├── installation-id
├── bin/
│   └── gits-repo-mirror-runner
├── config.jsonc
├── repo-mirrors/
│   ├── frontend.git/
│   └── sdk.git/
├── state/
│   ├── repo-mirrors/
│   │   ├── frontend.json
│   │   └── sdk.json
│   ├── repo-mirror-dependencies/
│   │   ├── frontend.json
│   │   └── sdk.json
│   └── operations/
├── logs/
│   └── repo-mirrors/
│       ├── frontend/
│       │   ├── 20260910T011700Z-<pid>-<run-id>.jsonl
│       │   └── 20260910T071700Z-<pid>-<run-id>.active.jsonl
│       ├── frontend.native.log
│       ├── frontend.native.log.1
│       ├── frontend.native.log.2
│       └── sdk/
├── locks/
│   ├── config
│   ├── repo-mirrors/
│   └── fetch-slots/
├── tmp/
└── trash/
```

高级用户和测试可以用绝对路径环境变量 `GITS_HOME` 覆盖根目录；默认值必须通过 `os.homedir()` 解析，不能依赖当前工作目录或 shell 展开。解析后的绝对值必须写入 scheduled invocation，不能让原生任务回退到另一个 home。

`installation-id` 是首次初始化时生成的随机 UUID，只用于让不同机器上的默认 schedule 错峰，不上传也不作为仓库身份。`bin/gits-repo-mirror-runner` 是原生任务使用的稳定、工具管理入口，不能指向包管理器中可能随升级消失的版本目录。

`state/repo-mirror-dependencies/<name>.json` 记录哪些已安装仓库仍通过 `.git/objects/info/alternates` 借用该 mirror。记录本身不是唯一事实来源：读取时还会核对依赖仓库当前的 alternates，已经移动、删除或自行 dissociate 的仓库不再阻止操作。

同一用户可能用 `GITS_HOME` 维护多套独立配置，因此还要从 `installation-id` 派生稳定的 12 位小写十六进制 `instance-key`，只用于隔离原生 job label/unit name；它是推导值，不另写配置。这样两套 home 中恰好同名的 mirror 不会覆盖彼此的 LaunchAgent/systemd unit。

### 7.1 配置示例

```jsonc
{
  "version": 1,
  "repoMirrorsSettings": {
    "maxConcurrentFetches": 4,
  },
  "repoMirrors": [
    {
      "name": "frontend",
      "urls": [
        "git@code.byted.org:acme/frontend.git",
        "https://code.byted.org/acme/frontend.git",
      ],
      "schedule": {
        "cron": "17 1-23/6 * * *",
      },
    },
    {
      "name": "sdk",
      "urls": ["https://github.com/acme/sdk.git"],
    },
    {
      "name": "manual-only",
      "urls": ["ssh://git@example.com/manual-only.git"],
    },
  ],
}
```

原则：

- `repoMirrors` 是有序数组；每个元素只持久化 `name`、非空 `urls` 和可选的最终 `schedule.cron`。
- `urls[0]` 是唯一活动 fetch URL，其他项只作为 install 匹配 aliases；不重复保存 `preferredUrl`，也不隐含自动 fallback。
- 没有 `schedule` 就是 off；v1 不再同时维护 off/paused 两种用户概念。
- `repoMirrorsSettings.maxConcurrentFetches` 是跨所有 CLI 和原生任务进程的机器级上限；`-j` 的有效值不能突破它。
- `maxConcurrentFetches` 缺省为 4，只接受 1 到 32 的整数；v1 作为高级 JSONC 配置，不增加单独的 settings 命令。
- 本机 mirror path 由 `name` 推导，不写入配置。
- `config.jsonc` 是唯一 source of truth，只保存用户意图。
- 路径、last run、next run 和 native loaded 状态不写回配置。
- 保留 JSONC 注释，使用项目现有 `jsonc-parser` 做局部编辑。
- 保存采用“同目录临时文件 -> flush -> atomic rename”；写前持有全局配置锁。
- `~/.gits` 及子目录默认权限为 `0700`，config、installation-id、state 和 log 文件默认 `0600`，stable runner 为 `0700`；mirror 内部文件即使使用 Git 自身 mode 也受私有根目录隔离。
- 拒绝保存带明文用户名密码或 token 的 HTTP(S) URL；凭据继续交给 Git credential/SSH 体系。
- 读取未知的更高 schema version 时报错并拒绝保存，不能由旧 CLI 覆盖。v1 目前没有旧 schema；将来首次引入迁移时必须在 config lock 下先备份再原子提交。

### 7.2 持久化注册表与卸载

所有机器级落盘位置统一声明在 `packages/core/src/service/gitsPersistenceRegistry.ts`。`GitsPathService`、目录初始化、stable runner、launchd/systemd projection 和 `GitsPersistenceService` 都消费同一注册表，不能各自重复硬编码路径。新增功能必须先登记持久化位置再写盘。注册表分为四类：

- `gitsPersistenceRootRegistry`：默认独占数据根名称；
- `gitsHomePersistenceRegistry`：`GITS_HOME` 下的 config、mirrors、state、logs、locks、tmp、trash 和 bin；
- `gitsManagedArtifactRegistry`：目录内的具体受管文件，例如 stable scheduler runner；
- `gitsExternalPersistenceRegistry`：必须放在操作系统固定目录中的 LaunchAgent、systemd user unit 与 timer enablement symlink。

`gits uninstall --dry-run` 输出注册表解析后的全部绝对路径、存在状态、configured mirrors 及依赖仓库，不修改磁盘。`gits uninstall --yes` 的顺序是：

1. 读取 mirror definitions 并重新核对 alternates 依赖；有 live dependents 时默认在任何删除前拒绝；
2. `--detach-dependents` 复用 mirror remove 的 repack、alternates 修改和 fsck 事务；`--force` 明确绕过依赖与 mirror 健康检查，直接进入经过 ownership 校验的独占数据根清理，因此 config、dependency state 或 bare repository 已损坏时仍可卸载；
3. 停止当前安装拥有的 launchd/systemd user jobs，并只删除通过 label/managed marker、`GITS_HOME` 和 stable runner 路径验证的投影；Linux 同时清理 `timers.target.wants` 中对应的 enablement symlink；
4. 永久删除 mirrors 及 `GITS_HOME` 内所有注册或未来遗留内容，最后删除根目录本身。

默认 `~/.gits` 是工具独占的数据根。自定义 `GITS_HOME` 在递归删除前必须包含有效的 `installation-id`，同时根目录、用户 home 或用户 home 的祖先路径永远拒绝删除。即使配置 JSONC 已损坏，用户仍可显式 `--force` 清理经过 ownership 校验的安装。任务工作区、Git checkout 和包管理器拥有的全局 binary/link 不属于此注册表，卸载不能跨目录扫描并删除它们。

## 8. 调度设计

### 8.1 默认自动调度

`add` 未传 `--schedule` 时，建议默认每 6 小时 fetch 一次，并根据本机 `installation-id` 与规范化 remote identity 做确定性错峰。只使用 identity 会让同一仓库在所有开发机上落到同一分钟，因此不能作为跨机器的错峰算法。实现内部可以把生成算法称为 `auto-v1`，但它不是用户配置字段。

```ts
minute = hash(installationId, identity, 'minute') % 60
hourOffset = hash(installationId, identity, 'hour') % 6
cron = `${minute} ${hourOffset}-23/6 * * *`
```

生成后的具体 cron 直接落盘，不保存“自动/手写”来源。后续升级 hash 实现也不会悄悄改变已有任务时间；只有用户再次执行 `set <name> --schedule auto` 时才重新生成。

这样既能把同一台机器上的多个仓库分散开，也能把同一个仓库在不同机器上的请求分散开；生成结果仍直接落盘，让 `list` 显示明确而稳定的调度，而不是含义模糊的“系统自动”。

显式 cron 仍可能让很多 mirror 撞在同一分钟。`doctor` 使用 `cron-parser` 模拟未来 24 小时的 occurrence；任一分钟的任务数超过 `maxConcurrentFetches` 时给出拥塞警告并建议改回 `--schedule auto`。机器级 slots 负责保证上限，诊断负责避免大量等待中的 Node 进程。

用户也可以：

```text
--schedule off
--schedule "11 3 * * 1-5"
```

### 8.2 便携 cron 子集

v1 只接受本机时区下的五段 cron：minute、hour、day-of-month、month、day-of-week。

允许：

- `*`；
- 十进制整数；
- 逗号列表；
- 连续范围；
- `*/n` 或 `a-b/n` 步长。

拒绝：

- 秒字段；
- `@daily` 等 macro；
- `L`、`W`、`#`、`?`；
- 未解析的 `H` 随机字段；
- 显式 IANA 时区；
- 展开后需要超过 256 个 launchd calendar entry 的表达式。

实现上先由本项目 portability validator 限定语法和五段结构，再由 `cron-parser` 校验取值并计算下一次时间。不能简单把该库接受的全部语法都承诺为跨平台契约。

传统 cron 在 day-of-month 与 day-of-week 都受限时采用 OR 语义；任一字段为 `*` 时则由另一个字段控制。launchd 原生支持前一种 OR 关系；systemd calendar 在同时限定两者时不是同一语义，因此 compiler 必须拆成两条 `OnCalendar=`，分别表达两个分支，而不能直译成一条。

### 8.3 原生文件是可重建投影

操作系统要求的路径：

```text
macOS:  ~/Library/LaunchAgents/io.gits.repo-mirror.<instance-key>.<name>.plist
Linux:  ${XDG_CONFIG_HOME:-~/.config}/systemd/user/gits-repo-mirror-<instance-key>-<name>.service
        ${XDG_CONFIG_HOME:-~/.config}/systemd/user/gits-repo-mirror-<instance-key>-<name>.timer
```

这些文件：

- 从 `${GITS_HOME}/config.jsonc` 确定性生成，默认 `GITS_HOME=~/.gits`；
- 带确定性的工具命名空间与 managed marker（launchd 使用精确 label，systemd 使用 `X-Gits-Managed=true`）；
- 不被当成配置来源；
- 正常 CRUD 只能按配置中精确推导出的路径修改，不能用宽泛前缀扫描删除；
- 由内部 reconcile service 重建或修复 drift，不再暴露独立的 `reconcile` 命令。

`list --wide` 每次从当前 definition 推导预期 backend、绝对投影路径和 job label，再比较磁盘内容与原生 manager 状态。v1 只管理当前精确路径；`XDG_CONFIG_HOME`、投影模板或 label schema 迁移时对旧投影的 ownership journal，以及孤儿扫描与清理，属于后续 hardening，不能通过宽泛前缀删除来替代。

“所有 Git 配置放在 `~/.gits`”在意图和状态层面可以做到；若要原生开机/登录自动执行，plist/unit 的投影目录是操作系统协议，不能一并搬入 `~/.gits`。

### 8.4 实际执行命令

每个原生任务只调用同一个 CLI 入口。实现时先生成结构化 execution descriptor，再由 adapter 写入各自格式：

```ts
interface ScheduledInvocation {
  executable: string
  arguments: string[]
  environment: Record<string, string>
}
```

原生任务统一指向 `~/.gits/bin/gits-repo-mirror-runner` 这一稳定入口；展示形式类似：

```text
/usr/bin/env HOME=/Users/alice GITS_HOME=/Users/alice/.gits \
  GITS_GIT_EXECUTABLE=/usr/bin/git GIT_TERMINAL_PROMPT=0 \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /Users/alice/.gits/bin/gits-repo-mirror-runner repo-mirrors fetch <name> --source scheduler
```

约束：

- executable 和参数分开写入 plist/unit，不经 `sh -c` 或 `bash -lc`；
- 使用绝对稳定 runner 路径，不依赖交互 shell 的 PATH，也不把包管理器中可能随升级消失的版本化 `dist/index.js` 直接写入 native artifact；
- runner 是随发行包提供并原子复制到 `GITS_HOME/bin` 的自包含 scheduler bundle；每次 repo-mirrors 写操作和 `doctor --fix` 都校验其版本与 hash，并在兼容的 schema 边界内更新；只有 `tsx`、临时源码入口等无法提供稳定 bundle 的开发形态才拒绝注册；
- 注册时解析 Git executable 的绝对路径，通过受控环境 `GITS_GIT_EXECUTABLE` 交给 Git gateway；`doctor` 检查，`doctor --fix` 更新失效路径；
- descriptor 必须显式携带解析后的绝对 `GITS_HOME`，保证自定义 home 在非交互环境中仍指向同一份配置和 mirror；
- descriptor 只携带明确需要的 `HOME`、`GITS_HOME`、`GITS_GIT_EXECUTABLE`、`GIT_TERMINAL_PROMPT=0` 和受控 PATH，不快照 `SSH_AUTH_SOCK`、token 等短期或敏感环境；
- plist 中不能写 `~`；
- 保持 `GIT_TERMINAL_PROMPT=0`，调度任务绝不等待交互凭据；
- `--source scheduler` 是内部标记，用于运行记录和错误提示，不改变 fetch 语义；
- 创建调度时如果当前 CLI 是 `tsx`/源码临时入口，应拒绝注册并提示先安装稳定 executable；
- `doctor` 检查 runner bundle 与 Git 的路径是否仍有效，由 `doctor --fix` 更新 runner 和投影。

`list --wide` 的“实际命令”必须包含 descriptor 的受控环境，而不能只打印 arguments。人类输出提供经 POSIX 安全转义、可复制的 `/usr/bin/env KEY=value ...` 表达；JSON 同时返回原始的 `fetchInvocation.executable/arguments/environment`，脚本不需要反向解析命令字符串。stable runner 也从自身位于 `${GITS_HOME}/bin` 的路径推导 home，并在显式 `GITS_HOME` 存在时校验两者一致，因此直接复制 runner 命令不会静默读取另一份配置。

`doctor --remote` 的认证探测必须通过 stable runner 和与 native job 相同的受控环境执行；当前交互 shell 中 `git ls-remote` 成功不能证明 launchd/systemd 环境中的 SSH key、credential helper 也可用。探测失败时提示用户配置非交互凭据，但不保存 secret，也不把当前 `SSH_AUTH_SOCK` 固化进长期任务。

### 8.5 macOS：LaunchAgent

Node 进程与 macOS 的边界只有文件系统和两个公开系统命令，不引入常驻 daemon、AppleScript、Objective-C bridge 或私有 API：

```text
gits CLI
  -> plist.build(typed job object)
  -> ~/Library/LaunchAgents/<managed-name>.plist
  -> /usr/bin/plutil -lint
  -> /bin/launchctl bootstrap/bootout/enable/print
  -> launchd 按 StartCalendarInterval 启动 ~/.gits/bin/gits-repo-mirror-runner
  -> runner 执行 repo-mirrors fetch <name>
```

生产实现直接使用 Node 内置 `process.platform` 做第一层候选路由：`darwin` 尝试 launchd adapter，`linux` 尝试 systemd adapter，其他值返回 unsupported；不增加只会再次包装该字段的平台判断依赖。这个值只说明 Node binary 的目标操作系统，不代表调度能力可用，真正结果必须来自 adapter 的 capability probe。为方便测试，读取 platform 的动作封装成可注入的窄 `PlatformInfo` port，而不是在业务代码各处直接访问全局对象。

macOS probe 再用 `process.getuid()` 构造 `gui/<uid>` domain，检查 `/bin/launchctl`、`/usr/bin/plutil`、LaunchAgents 目录可写性，并执行 `/bin/launchctl print gui/<uid>` 探测当前 GUI domain。没有已登录 GUI session 时仍可安全写入 LaunchAgents 投影，desired schedule 保留，但本次不能验证加载，状态显示 `unavailable`；下次用户登录后由 launchd 扫描该目录，再由 `doctor` 验证。所有系统命令复用现有安全进程 runner，以绝对 executable 加 argv 且 `shell: false` 执行；是否 loaded 只依据 `launchctl print gui/<uid>/<label>` 的退出码，文本输出仅作为诊断信息展示，不依赖本地化文本或未承诺稳定的排版字段。

plist 的关键字段：

- `Label=io.gits.repo-mirror.<instance-key>.<name>`；
- `ProgramArguments=[absolute-stable-runner, repo-mirrors, fetch, name, --source, scheduler]`；
- `EnvironmentVariables` 写入 execution descriptor 中经过白名单过滤的环境；
- `StartCalendarInterval` 为一个 dictionary 或 dictionary array；
- `ProcessType=Background`；
- launchd 自身的 stdout/stderr 落入 `~/.gits/logs/repo-mirrors/<name>.native.log`，用于保留 Node 启动失败和 logger 初始化前的 emergency 信息。stable runner 正常启动后丢弃 scheduled command 的成功 stdout，只把 stderr 写入同一有界文件；当前文件上限 1 MiB，并保留两个轮转备份，因此每个 mirror 的 native log 最多约 3 MiB。结构化运行结果仍由应用写入 `<name>/` 下的唯一 run 文件。

操作流程：

1. 用 `plist` 从类型化对象生成 XML 到同目录临时文件；
2. `/usr/bin/plutil -lint <temporary-plist>` 校验，失败时保留旧投影和已加载 job；
3. flush 后原子 rename 到最终 plist；
4. 对已有 job 做 `/bin/launchctl bootout gui/<uid> <plist>`，仅把“尚未加载”视为可忽略；
5. `/bin/launchctl bootstrap gui/<uid> <plist>`；
6. `/bin/launchctl enable gui/<uid>/<label>`，清除可能由旧版本遗留的 disabled override；
7. 用 `/bin/launchctl print gui/<uid>/<label>` 验证加载状态，并将绝对 plist 路径、label 和 hash 写入 state。

`set --schedule off` 只需 `bootout` 并删除投影，不调用会留下持久 override 的 `disable`；重新设置 schedule 时重新生成并 `bootstrap`。remove/doctor 仍要识别并清理由旧版本留下的 disabled 位，避免同名 mirror 重建后意外保持禁用。整个过程中不需要 root，也不修改 system domain。

Apple 文档说明 `StartInterval` 在睡眠期间会漏掉触发，而 `StartCalendarInterval` 会在唤醒后合并补触发一次，因此本设计使用 calendar 形式。[`launchd.plist(5)`](https://keith.github.io/xcode-man-pages/launchd.plist.5.html)

### 8.6 Linux：systemd user timer

service 采用 `Type=oneshot`，以 `Environment=` 写入白名单环境，`ExecStart=` 指向同一绝对 stable runner 命令。timer 的关键设置：

```ini
[Timer]
OnCalendar=...
Persistent=true
AccuracySec=1m
Unit=gits-repo-mirror-<instance-key>-<name>.service
```

操作流程：

1. 原子写入 `.service` 和 `.timer`；
2. 在可用环境运行 `systemd-analyze --user verify`；
3. `systemctl --user daemon-reload`；
4. `systemctl --user enable --now <timer>`；
5. 用 `systemctl --user show` 的机器字段验证状态。

`set --schedule off` 使用 `disable --now` 并删除投影；重新设置 schedule 时使用 `enable --now`。不解析面向人的 `list-timers` 表格作为程序状态。

`Persistent=true` 会在 user manager 停止期间错过日历事件后补触发；多次错过合并为一次。systemd 也不会在对应 service 已 active 时重复启动它。删除 timer 时必须执行 `systemctl --user clean --what=state <timer>` 清除持久 timestamp，避免同名 mirror 重建后意外补跑。[`systemd.timer(5)`](https://github.com/systemd/systemd/blob/main/man/systemd.timer.xml)

如果当前没有可用的 systemd user manager：

- mirror CRUD 和手动 fetch 仍然可用；
- schedule 状态为 `unavailable`；
- `doctor` 解释登录会话/linger 条件并给出可复制的处理建议；
- CLI 不自动开启 linger，也不偷偷降级到 crontab。

两种 backend 都是用户级调度：macOS LaunchAgent 随用户登录会话可用；Linux user timer 通常随登录启动，启用 linger 后才可在用户未登录时从开机运行。v1 不承诺系统级、无人登录身份下的 daemon 语义，但错过的 calendar 触发会在 user manager 下次可用时按平台规则合并补跑。

## 9. Mirror 生命周期

### 9.1 Add

每个规范化 identity 分组按以下阶段执行：

1. 先展开 Git `insteadOf`、规范化并按 identity 聚合整条命令的主 URL，验证名称、重复 identity、显式 aliases 和 schedule。已经完整存在的定义返回 `unchanged`，保证 `add --from-task` 可重复执行。
2. 每个分组先获取稳定的 per-mirror lock。已有 mirror 会在短时 config lock 内重新读取最新定义、合并 URL 并再次检查所有 identity 的唯一归属，避免并发 add/set 丢失更新。
3. 新 mirror 直接把 `urls[0]` clone 到 `~/.gits/tmp/<unique>.git`；clone 本身就是远端有效性检查。aliases 只参与后续 install 匹配，不在创建失败时自动重试：

   ```text
   git clone --mirror -- <selected-url> <temporary-path>
   ```

4. 在 mirror 中设置：

   ```text
   maintenance.auto=false
   gc.auto=0
   gc.autoDetach=false
   gits.repoMirror.managed=true
   ```

5. 校验 bare 状态、managed marker、`remote.origin.mirror=true`、mirror refspec、活动 origin 和“自身无 alternates”，通过后原子 rename 到最终路径。
6. 在仍持有 per-mirror lock 时短时获取 config lock，再次校验 name 与全部 URL identity 没有并发冲突，然后提交 definition；冲突或保存失败时把刚创建的目录移入 trash，而不是留下未登记 mirror。
7. 释放 config lock 后生成并应用原生 schedule 投影。平台能力不可用不会回滚已经下载的大 mirror；definition 保留 desired schedule，命令返回部分失败，之后可用 `doctor --fix` 重试。

v1 不自动复用 trash，也不承诺对进程在任意两次文件系统操作之间被 `SIGKILL` 的完整事务恢复；`doctor --fix` 可以修复已登记但 missing/invalid 的 mirror。更完整的 operation journal 与 trash restore 属于后续强化项。

### 9.2 Fetch

```text
git -C <mirror-path> fetch --prune --no-auto-maintenance origin
```

fetch 先获取一个机器级并发 slot，再尝试获取 per-mirror lock。手动 fetch 会为 slot 做短时有界等待，scheduler 在繁忙时立即记录 `skipped-locked`；per-mirror lock 正忙时两者都不会占着 slot 长时间等待。不同 mirror 可以并行，但全机并发不超过 `repoMirrorsSettings.maxConcurrentFetches`，同一 mirror 的手动任务与调度任务不能重叠。`origin` 的 URL 始终由 `urls[0]` 同步，mirror refspec 固定为 `+refs/*:refs/*`；因此 fetch 只需使用固定的 remote name，不重复拼 URL/refspec。失败时记录并提示用户用 `set --url` 切换来源，不自动尝试 aliases。这样既保持 Git 命令简洁，也避免权限范围不同的地址配合 `--prune` 意外缩减 refs。

明确传 `--no-auto-maintenance` 是必要的，因为 Git fetch 默认可能在末尾运行 auto maintenance。[`git-fetch(1)`](https://git-scm.com/docs/git-fetch) `--prune` 根据 mirror 的 refspec 删除远端已消失的 refs，但它不会直接删除不可达对象；v1 不做自动 GC，因此也不会破坏随后可能使用的引用对象。

每次运行通过 `RepoMirrorLogger` 写结构化 Pino 事件：

```ts
interface RepoMirrorLogEvent {
  event: 'repo-mirror.fetch.started' | 'repo-mirror.fetch.finished'
  runId: string
  mirror: string
  url?: string
  source: 'manual' | 'scheduler'
  startedAt: string
  finishedAt?: string
  status: 'running' | 'success' | 'failed' | 'interrupted' | 'skipped-locked'
  exitCode?: number
  durationMs?: number
  error?: { code: string; message: string }
}
```

logger 用 Pino 的 in-process destination 写入每次运行唯一的 `logs/repo-mirrors/<name>/<timestamp>-<pid>-<runId>.active.jsonl`，只记录开始、Git 命令的耗时/退出码和结束摘要，不复制完整 stdout/stderr。结束并 flush 后原子改名为 `.jsonl`，因此不同 CLI/native 进程不会共享 writer，连 `skipped-locked` 也能拥有独立的小日志。完成日志同时受三层 retention 约束：每个 mirror 最多 20 次、每个 mirror 最多 10 MiB、全部 mirror 的完成日志合计最多 256 MiB，任一上限触发都从最旧文件开始删除。`state/repo-mirrors/<name>.json` 只原子覆盖最近一次摘要，供 `list` 快速读取，不随运行次数增长。

不要记录凭据、完整环境变量或 Git 输出正文；错误摘要进入 logger 前会对 URL 中的嵌入式 HTTP 凭据脱敏并限制为 2,000 字符。短生命周期 CLI 在正常或受控错误退出前显式 flush Pino destination。SIGKILL 无法承诺 finished event，可能留下 `.active.jsonl`；文件名中的 pid 用于区分仍可能存活的 writer。无存活 writer 的 active 文件在 24 小时后清理，任何 active 文件在 7 天后强制清理。清理在新 run 启动及 run 正常结束时执行，因此强杀残留不会永久积累。

### 9.3 Lock

不依赖外部 `flock`，也不自研 lease 算法。`RepoMirrorLockService` 通过 `@bybrave/proper-lockfile2` 实现 `IRepoMirrorLockService`，复用其原子 `mkdir`、mtime heartbeat、原子 stale reclaim、retry 和 compromised-lock 检测：

- config lock 使用预先创建的稳定目标 `~/.gits/locks/config`，保护 definition 的短时读改写；不能直接锁首次启动时尚不存在且默认会被 realpath 的 `config.jsonc`；
- per-mirror lock 位于 `~/.gits/locks/repo-mirrors/<name>`，覆盖完整 add、set、fetch、reference clone、remove、repair 和 maintenance；install 短时间获取不到时直接退回普通 clone，资源变更则等待或清楚报错；
- machine slots 位于 `~/.gits/locks/fetch-slots/0..N-1`，所有 CLI 进程和 native job 都要占用一个 slot；`p-map`/`ConcurrencyService` 之类的进程内工具不能替代它；
- 上述 lock targets 都是在初始化时以 `0600` 创建的稳定空文件，库创建的 `.lock` 目录才是临时所有权标记；remove 不删除对应 target，避免旧进程与同名重建资源锁在不同 inode/path 上；
- 固定锁顺序为 fetch slot -> per-mirror -> config；config lock 下绝不等待 per-mirror lock，clone/fetch/repack/fsck 和原生调度命令不持有 config lock，从结构上避免环形等待；
- 所有调用点使用库返回的 release function 并放入 `finally`；
- stale/update/retry 参数在一个 factory 中固定，不能由各调用点各自设置；
- config lock 使用库的有界 retry；手动 fetch 对 machine slot 最多等待约 10 秒，scheduler 不等待 slot；per-mirror 操作采用 fail-fast，繁忙时返回明确状态或让 install 无损回退；
- lock heartbeat 为 10 秒、stale 阈值为 60 秒。当前 v1 使用库的 compromised/stale 行为，定制的 compromised 中止映射和休眠/SIGKILL 压力验证属于后续 hardening；
- 手动命令默认清楚提示正在运行，可在未来增加有界 `--wait`，v1 不提供危险的强制解锁。

`@bybrave/proper-lockfile2` 仍是较新的维护 fork，因此依赖固定精确版本，并增加 Node 22、macOS、Linux、系统休眠/唤醒、SIGKILL 后 stale recovery 和多进程压力测试；所有调用点必须使用相同 stale/update 参数。如果这些兼容测试不通过，再评估带原生构建成本的 `fs-ext` advisory lock，而不是回退到已知 stale reclaim 竞态或预先自研 lease。

systemd/launchd 自身能限制同一个 native job 的部分重入，但无法阻止用户同时执行手动 fetch，因此应用层锁仍然必需。

### 9.4 Set 与 Doctor

- `set --schedule off` 删除 schedule 定义和原生投影。
- `set --schedule auto|<cron>` 更新 desired definition，再 apply projection。
- v1 不提供独立 pause/resume 状态；要恢复自动 fetch，用户再次设置 `auto` 或明确 cron，避免 `off` 与 `paused` 两套近义状态。
- 所有 `set` 都在 per-mirror lock 下完成 definition 与投影/仓库配置的变更，防止与 remove、repair 或另一个 set 交错；需要写 config 时遵循 per-mirror -> config 的固定锁顺序。
- `set --url` 更新活动 fetch URL，并通过 `git remote set-url -- origin <url>` 同步 `remote.origin.url`；原活动 URL 默认保留为 alias。
- `doctor` 默认只读：检查配置、bare/managed/origin/refspec/alternates 结构与调度投影；`--remote` 用 `git ls-remote --symref <url> HEAD` 检查远端访问；`--deep` 才执行完整 `git fsck --full --no-dangling`。远端认证或网络失败只属于检查失败，不能据此把本地 mirror 判为结构损坏。
- `doctor --fix` 对 missing/structurally-invalid mirror 从活动 URL clone 到临时目录，校验后原子换入，旧目录进入 trash，并重新 apply 已配置的调度投影。修复 mirror 会更换 object database，因此存在 live dependents 时必须拒绝；涉及修复时必须交互确认，非交互要求 `--yes`。
- 孤儿 managed artifact 和过期 trash 的自动清理尚未进入 v1，属于后续 hardening；当前不会在 `doctor --fix` 中静默删除它们。active run log 的过期清理由 logger 自身完成，不依赖 doctor。
- definition 提交成功但原生 apply 失败时，命令返回部分失败；source of truth 保持 desired state，便于重试。

### 9.5 Remove

顺序为：

1. 校验明确目标和确认参数；
2. 获取 per-mirror lock，阻止新的 fetch/install/set/repair 进入；
3. 从 registry 读取候选 dependents，并逐个核对其当前 alternates。默认只要有 live dependent 就拒绝；
4. `--detach-dependents` 先保守估算磁盘空间，再对每个依赖仓库执行 `git repack -a -d`，只移除指向目标 mirror 的 alternates 行，并执行 `git fsck --full --no-dangling`；任一失败会恢复原 alternates 并停止删除；
5. `--force` 跳过第 3、4 步的保护并在结果中列出受影响路径，但不会改写它们。该操作可能令这些仓库立即无法读取借用对象；
6. 停用并移除 native job；systemd 同时清理 timer state，launchd 清理旧 disabled override；
7. 从配置原子删除 definition；
8. 默认把 bare repository 移入 `~/.gits/trash/<timestamp>-<name>.git`；只有显式 `--purge` 才立即删除。

`--force` 与 `--detach-dependents` 互斥，二者都仍要求 `--yes`/交互确认。v1 保留 state 和历史日志用于排障；trash 自动过期回收留到后续版本。

### 9.6 磁盘与 Maintenance

fetch 明确传 `--no-auto-maintenance`，普通定时任务不会隐式执行 GC。与此同时，mirror 在 refs 被 prune、远端发生 force-push 后会留下不可达对象，trash 也会继续占用空间，因此 v1 必须提供可见且受锁保护的清理路径：

- `list --wide` 展示每个 mirror 的磁盘占用；安全 detach 会根据 mirror object 体积、依赖数量和当前文件系统可用空间做保守预检；
- `fetch <name> --maintenance` 在正常 fetch 后、仍持有 per-mirror lock 时运行一次保守的 `git gc --prune=30.days.ago`；它必须由用户显式请求，不能进入默认 native schedule；
- maintenance 与 install/remove/repair 共用 per-mirror lock；即使已取得锁，只要仍有 live dependents 也拒绝 GC，避免删除它们正在借用的对象；
- trash 自动保留期、总量展示和清理命令属于后续 hardening；当前只有 `--purge` 能在 remove 时跳过 trash；
- 不承诺阻止用户绕过 CLI 对公开的本机路径直接运行 Git，但文档必须提醒直接 `git gc` 不受应用锁保护。

这既保留“定时 fetch 不隐式 GC”的安全边界，又避免产品没有任何磁盘回收路径。[`git-gc(1)`](https://git-scm.com/docs/git-gc)

## 10. 与现有 `gits install` 集成

这是 repo mirror 的主要收益，必须与最小 CRUD 一起进入第一阶段。若没有这个 consumer，用户配置的 mirror 只是一份定期更新但无人使用的缓存，不构成完整产品能力。

总体策略是“透明加速、失败开放、远端语义不变”：`gits install` 不增加必学子命令或必传 flag，只对当前判定为 missing、原本就要 clone 的任务仓库尝试 mirror；已经存在的仓库仍沿用现有 skip/conflict 行为，唯一例外是安全对齐显式配置的 `checkout` 目录。任务配置中的 URL 始终是 clone 的真实远端。默认模式下 mirror 会成为新仓库登记过的本机 object dependency，以换取更短安装时间和更低磁盘占用；显式 `dissociate: true` 才让安装结果完全自包含。

### 10.1 局部 checkout 与完整 Mirror

任务仓库可通过 `checkout` 表达只物化部分目录的稳定意图：

```jsonc
{
  "repos": {
    "meego-aio": {
      "url": "git@code.byted.org:dc/meego-aio.git",
      "branch": "feat/my-task",
      "from": "origin/main",
      "checkout": ["knowledge"],
    },
  },
}
```

- `checkout: null` 显式表示完整工作区；为兼容旧配置也接受字段缺省。目录模式必须是非空、去重的仓库相对目录数组，`gits init` 生成的模板会把 `url`、`path`、`branch`、`from`、`checkout` 和 `dissociate` 全部列出并注释，不依赖隐藏默认值。
- v1 只接受 cone-mode 目录，不接受绝对路径、`.`、`..`、空路径段、反斜杠、glob、单文件和 `.git` 管理路径。Git cone mode 会保留根级直接文件，这是原生语义，不使用已废弃且性能/兼容性较差的 non-cone patterns 模拟严格目录投影。
- 新仓库先以 `--no-checkout` clone，在临时目录设置 `git sparse-checkout set --cone --no-sparse-index`，再准备任务分支；这样不会先完整展开工作树，也避免 sparse index 给尚未兼容它的外部工具带来问题。
- 分支准备后用 `git ls-tree` 校验每个配置目录在目标 `HEAD` 中确实是 tree；缺失时返回 `checkout-path-missing`，临时仓库不会进入最终 `repos/`。
- `status` 同时读取 `core.sparseCheckout`、`core.sparseCheckoutCone` 和 `git sparse-checkout list`；模式或目录不同会产生正交的 `checkout-different` flag，并令 status 以非零状态退出，不覆盖 ahead/behind 等主状态。
- 对正确仓库且处于 `synced-local`、`ahead`、`behind` 或 `local-only` 状态的已有工作区，`install` 会对齐 checkout；任何 dirty 状态都会保守拒绝，避免改变稀疏范围时隐藏或移除用户文件。其他冲突状态仍保持原有拒绝行为。
- `switch` 在实际发生分支切换后重新设置已配置的 sparse checkout；即使已经位于目标分支，也可以修复 `checkout-different`。只有用户明确传 `--stash` 时才会在 dirty 状态下继续。
- Mirror 仍按规范化远端 URL 身份保存完整 bare repository；checkout 路径不写入 mirror definition、identity 或 dependency registry。同一远端的完整工作区与任意多个目录视图共享一个 Mirror。
- 默认非 `dissociate` clone 继续登记整个工作仓库对 Mirror 的 alternates 依赖。Sparse checkout 只减少工作区文件，不缩小可达历史；安全 detach 或显式 `dissociate: true` 仍可能复制大量对象。
- v1 不把 partial clone 与共享 Mirror 叠加。Filtered promisor repository 的按需联网、缺失对象、GC/repack 和多 consumer 语义会削弱 Mirror 作为完整本机对象源的可靠性。

因此用户无需学习新命令：编辑 `task.config.jsonc` 后运行 `gits install [repo...]`；要创建 Mirror 仍使用 `gits repo-mirrors add --from-task [repo...]`。本机已有仓库的绝对路径只能作为未来交互式发现的输入，不能写入可共享配置；配置始终保存远端 URL 和仓库内 checkout 路径。

流程：

1. `install` 在独立的容错边界中加载全局 `RepoMirrorResolver`，先用 `git ls-remote --get-url` 展开任务 URL 的 `insteadOf`，再调用已有 `normalizeGitUrl` 得到 identity。配置缺失、解析失败、权限错误或 resolver 异常都只产生警告并回退普通 clone，不能让 install 失败。
2. resolver 遍历 `~/.gits/config.jsonc` 的 mirror 数组，并与每个元素的全部 `urls` identity 比较；task repo key 与 mirror name 无需相同，SSH/SCP/HTTPS 传输形式也不必相同。若损坏或手改配置导致多个 mirror 同时命中，不任意选择，直接回退并提示 `doctor`。
3. 尝试获取 per-mirror lock；获取不到时该次 install 直接使用普通 clone。获得锁后重新检查目录存在、`git rev-parse --is-bare-repository` 为 true、managed marker、`remote.origin.mirror=true`、mirror refspec、origin identity 与活动 URL 一致且 mirror 自身没有 alternates，避免“先检查后删除”的竞态。
4. 把命中的绝对路径作为结构化 clone option 传给 Git gateway。默认生成的命令保持最短：

   ```text
   git clone --origin origin \
     --reference-if-able <mirror-path> \
     [--no-checkout] \
     -- <url> <destination>
   ```

5. Git 从 mirror 的 object database 借用已有 objects，只从任务原始远端补齐差量。分支准备成功后、最终目录原子 rename 前，CLI 解析实际 git-dir、核对 alternates 确实指向该 mirror，并把最终仓库路径写入 dependency registry。per-mirror lock 一直持有到登记和 rename 完成，remove/repair/maintenance 无法穿插。
6. 某个任务仓库在 `task.config.jsonc` 中显式设置 `dissociate: true` 时，命令才追加 `--dissociate`。Git 会把所需对象固化到新仓库并移除 alternates；CLI 不登记依赖，之后可独立删除 mirror。
7. 带 reference 的 clone 失败时，清理临时 clone、释放 mirror lock，记录 fallback 原因，再用现有普通 clone 重试一次；mirror 解析、配置、健康或锁异常同样 fail-open。fallback 后普通 clone 成功时整体仍退出 0。
8. 终端输出 mirror 名称、本机路径和是否 dissociated；JSON 结果增加可选 `mirror: { name, path, dissociated }` 与 `mirrorFallbackReason` 字段。

`install` 不会在 clone 前隐式 fetch、repair 或 maintenance mirror。一个结构健康但调度稍旧的 mirror 仍能贡献已有 objects，Git 会从任务原始远端补齐差量；若远端不可访问，仍按现有 preflight/clone 语义失败，因此 v1 的 mirror 是加速缓存而不是离线安装源。同步新鲜度由原生 schedule 或显式 `repo-mirrors fetch` 负责，避免一次 install 同时承担两套网络操作和更长的锁等待。

现有接入点很集中：`installRepository` 当前调用 `git.clone(url, temporaryRepository, options)`。将 clone options 扩展为下面的领域结构即可，不允许上层直接拼任意 Git 参数：

```ts
type GitCloneOptions = GitOperationOptions & {
  noCheckout?: boolean
  reference?: {
    path: string
    dissociate: boolean
    ifAble: true
  }
}
```

Git 官方文档明确提示：只用 `--reference` 会让新仓库依赖另一个仓库的 objects；被引用仓库清理对象可能导致借用方损坏。v1 因而把 dependency registry、per-mirror lock，以及 remove/repair/maintenance 的依赖保护作为默认模式的必要组成，而不是可选增强。`--dissociate` 会在 clone 后复制必要对象并断开这种长期依赖。[`git-clone(1)`](https://git-scm.com/docs/git-clone)

任务仓库配置缺省 `dissociate: false`；只有明确希望牺牲一次安装时间和磁盘来换取独立性时才写 true：

```jsonc
{
  "repos": {
    "api": {
      "url": "git@code.byted.org:acme/api.git",
      "branch": "feat/example",
      "from": "origin/main",
      "dissociate": true,
    },
  },
}
```

此能力应该自动发生，因此不增加 `ref clone`、`mirror clone` 等需要用户理解实现细节的命令。

v1 的加速范围仅是 Git object database，原因来自两类数据的存储边界：

- `--reference-if-able` 通过新仓库的 `.git/objects/info/alternates` 临时借用 reference repository 的 Git objects；父 mirror 能提供 commit、tree、普通 blob 和 tag 等对象。
- Git LFS 在 Git 历史中保存的是小型 pointer blob，真实大文件位于 LFS server 和各仓库独立的 `.git/lfs/objects`。bare mirror 没有 checkout，不会因普通 `git clone --mirror` 自动填满 LFS payload；Git 的 `--reference`/`--dissociate` 也不会把父 mirror 的 LFS storage 连接或复制给新仓库。因此 LFS 仍由 clone/checkout 时的 `git-lfs` filter 从其独立 endpoint 下载。
- submodule 是拥有独立历史、remote 和 object database 的另一座 Git 仓库。父仓库只保存一个指向 submodule commit 的 gitlink，以及 `.gitmodules` 中的路径/URL；父 mirror 里没有 submodule 的 commits 和 blobs，所以它不能作为 submodule clone 的 object reference。

这不是永久不支持。后续若要加速 submodule，应先解析并规范化每个 submodule URL，再让它独立命中自己的 repo mirror，并在 submodule clone/update 的生命周期中传入对应 reference。若要缓存 LFS，则需要独立设计 LFS fetch、endpoint/auth、storage ownership、容量和 prune 锁，不能复用父 mirror 的 Git object 锁后就宣称安全。v1 明确不隐式创建这些额外缓存，避免磁盘占用、凭据范围和清理语义失控。

## 11. 代码结构

项目已经迁移为“私有 Core 包 + CLI 应用”的类式模块结构。Core 不依赖 Incur，CLI 只负责命令装配、输入输出和进程退出；所有可注入 Service 都通过 `contract/interface` 中的接口 Identifier 依赖，具体类只在 `dependencies.ts` 绑定：

```text
packages/core/src/
├── contract/
│   ├── interface/             # IRepoMirror*Service 等接口与 ReDI Identifier
│   └── types/                 # repoMirror.ts 等稳定数据契约
├── service/                   # Git、文件系统、进程、并发、路径等基础 Service
├── module/
│   ├── repoMirror/service/    # 八个命令 Service 及模块内协作 Service
│   ├── task/service/
│   └── uninstall/service/
├── dependencies.ts            # [IService, { useClass: Service }]
└── index.ts

apps/cli/src/
├── contract/
│   ├── interface/             # CLI 专属接口与 Identifier
│   ├── types/
│   └── constants/
├── service/                   # CliApplication、输出、确认、进度、运行时
├── module/
│   ├── repoMirror/service/    # Incur RepoMirror 命令类
│   ├── task/service/          # Incur Task 命令类
│   └── uninstall/service/
├── bootstrap/container.ts     # 唯一 Injector 组合根
├── dependencies.ts
└── index.ts                   # 进程入口
```

核心接口保持很窄，并同时声明显式 ReDI Identifier：

```ts
export interface IRepoMirrorSchedulerService {
  apply(
    definition: RepoMirrorDefinition
  ): Promise<RepoMirrorSchedulerObservation>
  inspect(
    definition: RepoMirrorDefinition
  ): Promise<RepoMirrorSchedulerObservation>
  invocation(name: string): RepoMirrorScheduledInvocation
  remove(name: string): Promise<RepoMirrorSchedulerObservation>
}

export const IRepoMirrorSchedulerService: IdentifierDecorator<IRepoMirrorSchedulerService> =
  createIdentifier<IRepoMirrorSchedulerService>(
    'core.repoMirrorSchedulerService'
  )
```

cron 到 scheduled job 的编译、next-run 计算和 fetch command 生成留在 repoMirror 模块；操作系统命令与文件系统能力分别通过 `IProcessService` 和 `IFileSystemService` 注入。调用方只依赖 `IRepoMirrorSchedulerService`，不依赖具体实现类。

共享表格格式化集中在 `apps/cli/src/service/cliTable.ts`；`commandOutput.ts`、`repoMirrorOutput.ts` 和 `uninstallOutput.ts` 只提交 headers、cells 与列优先级，不各自计算字符宽度或拼空格。纯格式化函数返回字符串，`CliOutputService` 统一负责 stdout/stderr，因此命令类不接触输出细节。

不要把 mirror 方法全部塞进面向 working tree 的 `IGitService`。底层安全进程执行由 `IGitCommandService` 复用，bare-repository 能力则由独立的 `IRepoMirrorGitService` 暴露，避免 Task Service 被 mirror 细节污染。

并发协调统一封装为 `IConcurrencyService` / `ConcurrencyService`。它继续用小型 worker-pool 实现本项目的 abort/not-run 契约；进度展示通过 `IConcurrencyPresentationService` 注入，Core 不依赖 Listr 或 CLI。

## 12. 安全与可靠性约束

- 所有 Git、launchctl、systemctl 参数通过 argv 传递，`shell: false`。
- name 先验证再参与任何路径或 label 计算。
- 所有删除目标必须由受验证的 name 和已解析的 `GITS_HOME` 推导，并检查 realpath 仍在预期根目录内。
- URL 使用 `--` 与位置参数隔离；拒绝换行、NUL 和嵌入式 HTTP secret。
- 不继承完整交互 shell 环境；只传必要的安全环境变量。
- config、mirror、projection 的写入均先落临时文件/目录，再原子替换。
- 原生投影只管理带本工具 marker 且路径完全匹配的文件。
- scheduled invocation 固定传递绝对 `GITS_HOME`；配置、日志、状态或 mirror 根目录不因原生环境中的 HOME/PATH 差异而漂移。
- `config.jsonc` 的未知高版本拒绝保存；未来若增加旧版本迁移，必须先备份再原子提交。
- fetch 失败不更新 `lastSuccessAt`；last attempt 与 last success 分开显示。
- scheduled/manual fetch 的完成日志按“每 mirror 20 次、每 mirror 10 MiB、全局 256 MiB”三重上限清理；无存活 writer 的 active 日志 24 小时后清理，所有 active 日志最长保留 7 天。
- native emergency log 每个文件最多 1 MiB 并保留两个备份，即每个 mirror 最多约 3 MiB；scheduled command 的正常 JSON stdout 不重复写入 native log。
- install 对 mirror 子系统始终 fail-open；任何优化层错误最多变成 warning 和普通 clone。
- `doctor --remote` 才执行可能较慢的远端连通/非交互认证检查；`--deep` 才完整读取对象做 fsck，默认 doctor 只做本地、只读检查。
- 所有生成器分别按 plist XML 与 systemd unit 规则转义 `%`、换行和特殊字符，不能把 shell quoting 误用于原生格式。

## 13. 测试计划

下面既记录当前自动化覆盖，也保留发布前/后续平台 CI 矩阵；涉及休眠、SIGKILL、真实 GUI session、真实 systemd user manager、孤儿清理或 schema migration 的条目属于后续 hardening，不表示当前单元测试已经覆盖。

### 13.1 纯单元测试

- 自动调度对相同 installation-id + identity 稳定；相同仓库在不同 installation-id 上能够错峰；
- 注入的 platform 值只负责选择 darwin/linux/unsupported 候选 adapter；即使为 darwin/linux，最终状态仍由 capability probe 决定；
- `doctor` 对未来 24 小时的 occurrence 做拥塞检测，并在同一分钟超过 machine slots 时稳定告警；
- cron 允许/拒绝矩阵；
- day-of-month/day-of-week OR 到两个 backend 的等价编译；
- launchd 展开上限；
- next-run 在 DST 切换和固定时区下的行为；
- name、URL、路径和 label 转义；
- 同 identity 的 SSH/HTTPS URL 自动聚合，规范化 identity 不同的地址只有显式 alias 才能进入同一个 mirror；
- 活动 URL、alias 新增和删除操作保持非空、唯一归属与稳定顺序约束；
- `path` 只输出规范化的本机绝对路径，JSON 与 `list <name> --wide` 中的 `path` 完全一致；
- 共享表格 renderer 对 ASCII、中文全角字符、组合字符、emoji 和 ANSI 文本按可见宽度对齐；窄 TTY、非 TTY、显式多行长字段与空数据都有稳定 snapshot；
- repo-mirrors 普通 list、wide 详情和现有 command output 复用同一无边框样式，JSON 输出不受终端宽度或 ANSI 影响；
- orthogonal state 到 CLI/JSON 的映射。
- `ConcurrencyService` 保持原有保序、单项隔离、进度回调、等待在途任务和 `not-run` 契约。
- config 对未知高版本的拒绝覆写行为；出现第一个旧 schema 后再增加迁移与备份测试。

### 13.2 Adapter 契约测试

- fake scheduler 覆盖 apply/remove/inspect 和 doctor 内部 reconcile；
- golden test 比较生成的 plist/service/timer；plist renderer 还覆盖 XML 特殊字符、数组型 `StartCalendarInterval`、环境和绝对路径；
- macOS runner 用真实 `/usr/bin/plutil -lint`，并以 fake process runner 断言 `/bin/launchctl` 的 argv、调用顺序、幂等和退出码映射；
- Linux runner 用 `systemd-analyze --user verify`；
- 能力不可用、文件漂移、孤儿 managed artifact、runner 版本变化和部分 apply 失败的恢复；
- 自定义 `GITS_HOME` 被准确固化进两个平台的 scheduled invocation；
- 两套 `GITS_HOME` 的 instance-key、job label 和投影文件互不冲突；installation-id 丢失/变化后旧产物只能按 marker 和记录的 ownership 安全处置；
- `XDG_CONFIG_HOME` 或投影 schema 变化时先验证新投影，再回收 state 精确记录的旧投影，不遗留双重调度；
- 人类可复制命令与 JSON `fetchInvocation` 从同一个 descriptor 生成，argv 和白名单环境逐字段一致；
- systemd remove 清理 persistent timestamp，launchd remove 清理 disabled 位；
- `proper-lockfile2` adapter 的稳定 config target、per-mirror/global-slot 策略、release-on-error、onReclaimed recovery 和 compromised lock abort 映射；
- Pino 字段脱敏、flush、每次运行唯一文件、active 残留回收、单 mirror/全局结构化日志 retention，以及 native stderr 的单次硬截断与两级轮转。

### 13.3 Git 集成测试

沿用当前临时 bare remote 测试模式：

- add 创建真正的 mirror refspec；
- add 写入 managed marker，重复 add 返回 unchanged；trash candidate 自动复用属于后续测试与能力；
- add 只使用活动 URL clone，aliases 不会被隐式当成 fallback；
- `set --url` 只能选已有/同命令显式新增的 alias，并同步 origin；不同认证入口返回不同 refs 时不会被自动 fallback + prune；
- fetch 获得新增分支并 prune 已删除 refs；
- fetch 命令明确关闭 auto maintenance；
- 两个 mirror 依照 `-j` 并行，结果顺序保持稳定；
- 启动超过全局上限的独立 Node 进程时，同时执行的 fetch 不超过 machine slots；多进程压力与休眠恢复列为后续平台 CI；
- 手动和 scheduler 同时 fetch 时只有一方进入临界区；
- add 提交 definition 到最终 rename 期间，install 安全降级且 set/remove 无法越过 per-mirror lock；并发 set/remove/repair 不会产生定义、origin 和投影的混合状态；
- 两个独立 Node 进程争抢同一 mirror lock 时仍只有一个进入；系统休眠/唤醒和 SIGKILL 后 stale recovery 列为后续平台 CI；
- batch 中单个远端失败不阻塞其他 mirror；
- install 默认通过 mirror clone、保留并登记 alternates；显式 `dissociate: true` 时最终无 alternates；
- live dependent 会阻止 remove/repair/maintenance；`--detach-dependents` 经 repack + fsck 后解除依赖，`--force` 则保留风险和受影响路径；
- reference clone 与 remove/repair/maintenance 竞争时不会读取被移动或清理的对象；
- mirror 缺失/损坏、配置损坏、重复匹配或锁繁忙时 install 退回普通 clone，且最终成功仍退出 0；
- `doctor --deep` 发现对象损坏，`doctor --fix` 能临时重建、校验、原子替换并保留旧目录到 trash；
- 远端断网或认证失败只记录 run failure，不触发本地 mirror 重建；
- `fetch --maintenance` 在锁内运行，默认调度不会隐式触发 GC。

### 13.4 端到端验收

至少在 GitHub-hosted macOS 与 Ubuntu runner 各验证一次完整生命周期：

```text
add -> list/path -> native registration -> manual fetch -> schedule off/auto
    -> mutate remote -> scheduled/manual fetch -> doctor/doctor --fix -> remove
```

若 CI 环境没有真实 user manager，注册命令使用受控 fake，生成文件仍通过系统原生 validator；另保留一套人工 smoke checklist。

## 14. 分阶段交付

### Phase 1：可用的 mirror 闭环

- `~/.gits` layout 和 JSONC store；
- 使用 `ConcurrencyService`，并完成 Listr2 并行任务展示、`@bybrave/proper-lockfile2`、Pino 单次运行日志与 `table` 人类输出的公共 Service；
- add/list/path/set/remove/manual fetch 和 `--from-task`；
- `gits install` 自动匹配 mirror、默认 `--reference-if-able`、显式配置才 `--dissociate`，并支持无损 fallback；
- install/remove/fetch/repair/maintenance 的锁契约、machine slots、日志和 JSON contract；
- mirror 快速健康检查、`doctor --deep/--fix` 重建、磁盘占用与显式 maintenance；
- 未知更高 config version 拒绝覆写，以及 fail-open resolver。

### Phase 2：原生 scheduler

- portable cron compiler；
- launchd adapter；
- systemd user adapter；
- 稳定 scheduler runner、`GITS_HOME` 固化和原生日志隔离；
- set schedule off/auto、doctor 内部 reconcile、logs；
- 平台 CI、持久 state/orphan 清理与 drift recovery。

### Phase 3：强化与运维

- 可选的调度失败通知与连续失败退避策略；
- 更细粒度的磁盘 quota 和自动 maintenance 策略；
- mirror 命中率、clone 性能与普通 clone 降级原因统计；
- LFS/submodule 的独立缓存能力评估。

分阶段是为了把 Git 数据正确性和 native scheduler 风险隔离。Phase 1 在内部已经形成“创建 mirror -> install 自动使用”的闭环；第一个正式发布版本仍建议包含 Phase 1 + Phase 2，避免对外出现会保存 schedule 却不执行的中间状态。

## 15. 建议评审确认的产品决策

以下是本提案给出的默认值，而不是技术硬限制：

1. **新 mirror 默认每 6 小时按 installation-id + identity 错峰 fetch。** 推荐保留；否则用户创建后很容易忘记配置同步，且仅按 identity 会让同一仓库在所有机器上同时请求。
2. **v1 只支持机器本地时区。** 推荐保留；显式时区跨 launchd/systemd 的 DST 语义和投影复杂度明显更高。
3. **launchd 展开上限 256。** 推荐保留；可以在真实使用数据出现后调整。
4. **remove 默认移入 trash，而非立即永久删除。** 推荐保留；bare mirror 往往体积大、重建慢，误删成本高。
5. **一个 mirror 只允许一个 schedule。** 推荐保留；多 schedule 对 fetch 没有业务收益，只会增加重入和解释成本。
6. **一个 mirror 只有一个活动 fetch URL，其余 URL 只用于匹配。** 推荐保留；自动 fallback 与 prune 结合时很难保证不同认证入口暴露完全相同的 refs。
7. **v1 不提供 pause/resume 子命令。** 推荐保留；`set --schedule off|auto|<cron>` 已覆盖核心需求并减少近义状态。
8. **install 默认保留 alternates，任务仓库显式配置才 dissociate。** 已确认；默认路径优先减少安装耗时与重复对象占用，同时以 dependency registry 和 destructive-operation guard 保证安全。
9. **`gits uninstall` 只卸载 gits 自有机器数据，不代替包管理器。** 推荐保留；CLI 能可靠识别自己的数据和原生调度投影，却不应猜测 pnpm/npm/Homebrew 的安装位置或删除其全局链接。
10. **局部 checkout 是 consumer 属性，Mirror 始终完整。** 已确认；这样同一远端的不同目录视图可以复用一个可靠的本机对象源，也不会把 promisor/partial-clone 复杂性扩散到依赖保护与 GC。

## 16. 完成标准

当以下条件全部满足，可以认为该能力完成：

- 命令文档中只出现复数 `repo-mirrors` 资源名；
- 用户能批量 CRUD/fetch，并控制 `-j`；
- 一个 mirror 可保存一个活动 fetch URL 和多个显式 aliases，并可用任一已配置 SSH/HTTPS 地址完成 install 匹配；
- 默认 `list` 可见本机绝对 mirror path；`list --wide` 可见所有 URL、cron、next fetch、绝对 fetch command、backend、磁盘占用和 drift；
- 人类 list 使用统一、Unicode/ANSI-aware 的紧凑表格；`path` 和 JSON 保持精确、稳定；
- 人类 TTY 下并行仓库任务使用固定任务行且 Git 输出不交错；agent、JSON 与 pipe 输出不包含动态渲染控制字符；
- `path` 可将唯一的绝对路径直接传给其他 Git/shell 命令；
- 所有稳定配置与镜像数据位于 `~/.gits`，OS 目录中只有可重建投影；
- 所有机器级持久化路径来自同一 typed registry；新增路径未登记就不能进入通用初始化与卸载清单；
- CLI 退出和重新登录/重启后，支持平台的任务仍存在；
- macOS 与 Linux 的 calendar 语义通过同一组契约测试；
- 同一 mirror 不会被 add、set、fetch、reference clone、remove、repair 或 maintenance 以危险方式并发访问，且独立 native job 的全机 fetch 并发有明确上限；
- fetch 不触发隐式 maintenance/GC；
- 用户可显式在应用锁内执行 maintenance，并能看到单个 mirror 占用；trash 统计和过期回收列入后续 hardening；
- 原生调度不可用或已配置投影漂移时有明确状态，并可由 `doctor --fix` 修复；孤儿扫描列入后续 hardening；
- 自定义 `GITS_HOME` 会固化进 native invocation，同一用户的多套 `GITS_HOME` 不争用 job identity；package-manager 特殊升级路径仍需平台发布验证；
- 现有任务命令的输出和行为没有非预期变化；
- install 默认留下已登记、受保护的 alternates 依赖，显式 `dissociate: true` 时不留下；mirror/config/lock 故障或命中歧义时能正常降级且不改变成功退出语义。
- `checkout: null` 保持完整工作区（兼容旧配置缺省字段）；非空目录列表使用 cone-mode sparse-checkout，新安装不先物化完整工作树，配置漂移可由 status 发现并由 install/switch 安全对齐。
- checkout 目录在目标 HEAD 缺失时不会留下半安装目录；dirty 工作区不会被 install 隐式收窄，checkout 路径也不会污染 mirror identity 或形成重复 Mirror。
- remove/repair/maintenance 不会破坏已登记的 live dependents；用户可选择安全 detach，或以 `--force` 明确承担风险并看到受影响仓库。
- `uninstall --dry-run` 不写盘并能列出数据根、注册项、未来遗留项、受管原生投影、mirrors 和 live dependents；
- 默认卸载在 live dependents 存在时零删除，`--detach-dependents` 完成 repack/fsck 后清理，`--force` 明确绕过保护；
- 卸载只移除 ownership 校验通过的 LaunchAgent/systemd units，并最终删除独占 `GITS_HOME`；危险根路径及无 installation-id 的自定义根始终拒绝递归删除。

## 17. 主要资料

- [`cron-parser` 官方仓库](https://github.com/harrisiirak/cron-parser)
- [`p-map` 官方仓库](https://github.com/sindresorhus/p-map)
- [`@bybrave/proper-lockfile2` 官方仓库](https://github.com/bybraveHQ/proper-lockfile2)
- [`git-sparse-checkout(1)`](https://git-scm.com/docs/git-sparse-checkout)
- [Git Partial Clone 设计文档](https://git-scm.com/docs/partial-clone)
- [`proper-lockfile` 原项目](https://github.com/moxystudio/node-proper-lockfile)
- [`fs-ext` 官方仓库](https://github.com/baudehlo/node-fs-ext)
- [`pino` 官方仓库](https://github.com/pinojs/pino)
- [`listr2` 官方仓库](https://github.com/listr2/listr2)
- [`pino-roll` 官方仓库](https://github.com/mcollina/pino-roll)
- [`table` 官方仓库](https://github.com/gajus/table)
- [`cli-table3` 官方仓库](https://github.com/cli-table/cli-table3)
- [`@oclif/table` 官方仓库](https://github.com/oclif/table)
- [`plist` 官方仓库](https://github.com/TooTallNate/plist.js)
- [Node.js `process.platform` 文档](https://nodejs.org/api/process.html#processplatform)
- [Apple `launchd.plist(5)`](https://keith.github.io/xcode-man-pages/launchd.plist.5.html)
- [Apple `launchctl(1)`](https://keith.github.io/xcode-man-pages/launchctl.1.html)
- [Apple Daemons and Services Programming Guide：Scheduling Timed Jobs](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html)
- [systemd `systemd.timer(5)` 源文档](https://github.com/systemd/systemd/blob/main/man/systemd.timer.xml)
- [Git `clone` 文档](https://git-scm.com/docs/git-clone)
- [Git submodule 文档](https://git-scm.com/docs/gitsubmodules)
- [Git LFS 主命令文档](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs.adoc)
- [Git LFS pointer/storage 规范](https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md)
- [Git `fetch` 文档](https://git-scm.com/docs/git-fetch)
- [Git `ls-remote --get-url` 文档](https://git-scm.com/docs/git-ls-remote)
- [Git `fsck` 文档](https://git-scm.com/docs/git-fsck)
- [Git `maintenance` 文档](https://git-scm.com/docs/git-maintenance)
- [Git `gc` 文档](https://git-scm.com/docs/git-gc)
- [`unitup` 官方仓库](https://github.com/litepacks/unitup)
- [`opencode-scheduler` 官方仓库](https://github.com/different-ai/opencode-scheduler)
- [`@minagents/wua` 官方仓库](https://github.com/minhvoio/wua_wake-up-ai)
