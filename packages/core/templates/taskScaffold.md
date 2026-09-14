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

```

# `docs/AGENTS.md`

```markdown

```

# `scripts/AGENTS.md`

```markdown

```
