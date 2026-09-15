# `task.config.jsonc`

```jsonc
{
  // 仓库定义。每个 key 都是稳定的仓库名称，可用于
  // "gits install example-repo"、"gits status example-repo" 等命令。
  "repos": {
    "example-repo": {
      // 运行 gits install 前请替换所有 <...> 占位符。
      // Git 远端地址，会被记录为 origin；SSH 和 HTTPS 地址均可。
      "url": "git@<host>:<group>/<repo>.git",

      // 相对当前 Task 目录的本地工作区路径，必须位于 repos/ 之下。
      "path": "repos/example-repo",

      // 本地任务分支；不存在时由 gits 创建，之后保持检出该分支。
      "branch": "<task-branch>",

      // 仅在任务分支需要创建时使用的远端起点，格式必须是 origin/<branch>。
      "from": "origin/<base-branch>",

      // 工作区范围：null 表示完整检出；要局部检出则改为非空目录数组，
      // 例如 ["knowledge", "docs/guides"]。目录相对仓库根，根目录文件仍会保留。
      "checkout": null,

      // Mirror 对象策略：false 保留更快、更省空间的共享对象依赖；
      // true 会复制对象，使工作仓库不再依赖 Mirror，但安装更慢且占用更多磁盘。
      "dissociate": false,
    },
  },
}
```

# `AGENTS.md`

```markdown
# 任务工作区

当前目录是面向单个功能、缺陷、调研或其他工作项的临时任务工作区，用于协调一个或多个仓库中的工作；它本身不是业务仓库。

- `task.config.jsonc`：声明本任务涉及的仓库。
- `repos/`：存放相互独立的 Git 仓库。
- `docs/`：存放计划、决策、调研结果、测试记录和交接说明等任务上下文。
- `scripts/`：存放环境准备、数据构造、测试和部署等可复用的任务脚本。

- 开始工作前阅读 `task.config.jsonc` 和目标路径下适用的 `AGENTS.md`。
- 将可复用的发现和决策写入 `docs/`，将重复流程沉淀到 `scripts/`，供后续智能体和子智能体直接使用。
- 将本任务特有的约束、工具和风险边界补充到本文件。
- 这里的内容只服务于当前任务；只有明确属于交付物时才移入业务仓库。
```

# `docs/AGENTS.md`

```markdown
# 任务文档

当前目录用于持久化任务范围内的知识，供工作区中的所有智能体共享和复用。

- 在这里记录目标、验收标准、计划、架构决策、调研结果、测试证据和交接说明。
- 记录明确的仓库路径、命令、链接和验证结果，并标出未解决的问题。
- 优先更新已有文档，避免重复记录同一上下文。
```

# `scripts/AGENTS.md`

```markdown
# 任务自动化

当前目录存放供本任务所有智能体共享的可复用自动化脚本，例如环境准备、跨仓库检查、测试数据加载、端到端测试和测试环境部署。

- 脚本应尽量小而可组合，并在适用时保持幂等。
- 写清用法、前置条件、输入以及影响的仓库或服务。
- 将环境差异放在参数或环境变量中，验证脚本后再将其作为共享流程。
```

# `repos/AGENTS.md`

```markdown
# 任务仓库

当前目录存放本任务涉及的独立 Git 仓库。

- 修改仓库前先阅读仓库自身及目标路径下的 `AGENTS.md`，更具体的指令优先。
- 在对应仓库中执行命令并保持仓库边界。
- 跨仓库的约定、流程和验证记录在任务级 `docs/` 与 `scripts/` 中。
```
