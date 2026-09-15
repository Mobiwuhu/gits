# 发布指南

本仓库使用 Relizy 的 `unified` 模式发布 `@gits/cli` 与 `@gits/core`。一次发布只产生一个 `vX.Y.Z` Git tag，根 `package.json` 和两个公开包始终使用相同版本。

## 一次性配置

1. 在 npm 创建或确认当前账号拥有公开 scope `@gits`。未限定 scope 的 `gits` 已属于其他维护者，因此 CLI 的 npm 包名是 `@gits/cli`，但二进制仍叫 `gits`。
2. 将仓库推送到 GitHub，并将默认分支设为 `main`。当前本地仓库尚未配置 remote，配置前 GitHub Actions 不会运行。
3. 在 GitHub 创建名为 `npm` 的 Environment。建议启用 required reviewers，避免误触发布。
4. 在该 Environment 中创建 `NPM_TOKEN` secret。Token 必须能首次创建并公开发布 `@gits/cli` 和 `@gits/core`。
5. 确认 Actions 的 `GITHUB_TOKEN` 可以向 `main` 推送版本提交和 tag。若分支保护禁止该身份绕过规则，请使用允许发布机器人写入的规则或按组织策略替换发布凭据。

仓库没有擅自声明开源许可证。正式公开前应补充经项目所有者确认的 `LICENSE` 和 package `license` 字段。

## 本地预检

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm release:check
```

`pnpm check` 会执行 Ultracite、架构约束、TypeScript 类型检查、测试、构建，以及真实 tarball 验收。tarball 验收会检查统一版本、公开访问级别、CLI 对 Core 的精确依赖和发布文件清单，随后在临时项目中安装两个包，运行 `gits --version` 并导入 `@gits/core`。

`pnpm release:check` 以 patch 版本执行 Relizy dry-run，且明确关闭 publish、push、commit 和 GitHub Release，用于验证发布配置而不改变仓库或 registry。

首次发布尚无 `vX.Y.Z` tag 时，仓库的 Relizy 启动器会自动以 Git 首提交为基线，规避 Relizy 1.4.9 对首提交父引用的兼容问题；存在版本 tag 后完全交回 Relizy 的标准 tag 解析。该检查仍要求仓库已配置可识别的 GitHub `origin`。

通常 `pnpm install` 会自动安装 Lefthook。如果用户已有自定义 `core.hooksPath`，安装脚本不会覆盖它；只有检测到该 hook manager 明确链式调用仓库 `.git/hooks` 时，才会安全地把 Lefthook 安装到仓库本地目录，否则会输出接入提示。CI 始终独立运行 Commitlint，不依赖开发机 hook。

## GitHub 发布

在 Actions 页面手动运行 **Release** workflow，并选择 `patch`、`minor` 或 `major`。流水线会先在干净 checkout 中执行完整检查，然后 Relizy 会：

1. 同步升级根包和两个公开包的版本；
2. 生成 changelog；
3. 在新版本上下文中再次执行 `pnpm check`；
4. 按依赖拓扑先发布 `@gits/core`，再发布 `@gits/cli`；
5. 创建版本提交、`vX.Y.Z` tag、推送并创建 GitHub Release。

不要从开发机直接运行 `pnpm release`，除非是在恢复或调试流水线，并且已经确认 npm 与 Git 权限。发布到 npm 本身不可原子回滚；若后一个包失败，先保留日志并修复根因，再依据 npm 的版本不可覆盖规则选择恢复方式，不要重复发布同一个已存在版本。
