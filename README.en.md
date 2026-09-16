# gits

[English](README.en.md) | [简体中文](README.md)

`gits` is a task-workspace CLI for development work that spans multiple Git repositories. It organizes those repositories as a Task Branch Set and provides a single workflow for preparing, inspecting, switching, fetching, and safely pushing them.

`task.config.jsonc` stores only stable intent: repository identity, task branch, the remote baseline used when the branch is first created, and an optional working-tree scope. The current branch, working-tree changes, upstream, effective sparse checkout, and commit state always come from Git itself.

The repository is a modular monolith composed of `packages/core` and `apps/cli`. Core contains the business services; CLI handles Incur arguments, interaction, and output. Every command uses ReDI constructor injection and explicit registration instead of file-system route scanning. The two workspaces are published as `@gits/core` and `@gits/cli` with the same version, while the installed command remains `gits`.

## Installation

```sh
pnpm add --global @gits/cli
gits --help
```

To reuse only the underlying services and contracts:

```sh
pnpm add @gits/core
```

## Requirements

- Node.js 22.18.0 or later (published packages support 22.17.1 or later at runtime)
- pnpm 9.15.9 or later
- Git installed and available on `PATH`

To let Node manage the pnpm version, enable Corepack first:

```sh
corepack enable
```

## Development and builds

Run these commands from the repository root:

```sh
pnpm install
pnpm build
pnpm start -- --help
```

`pnpm build` uses tsdown/Rolldown to build Core and CLI as Node.js ESM. `tsc` performs `--noEmit` type checking only and does not generate runtime artifacts. Inside this repository, `tsx` loads the TypeScript sources directly, so routine development does not require a prior build.

Run the same complete gate used by CI before committing:

```sh
pnpm check
```

Code quality is configured directly through Oxlint and Oxfmt. Oxlint enables the core correctness, suspicious, and performance categories plus a small set of project rules. Oxfmt uses single quotes and no semicolons. Lefthook runs both checks during `pre-commit` and uses Commitlint to enforce Conventional Commits during `commit-msg`. Installing dependencies registers these Git hooks automatically.

Relizy manages releases in unified mode, so the root package, `@gits/cli`, and `@gits/core` always move to the same version. Maintainers can preview a release with `pnpm release:check` and publish with `pnpm release`.

Run the CLI directly from TypeScript source:

```sh
pnpm dev -- --help
```

To rebuild continuously, use a second terminal:

```sh
pnpm build:watch
```

After packaging or installation, the executable name is `gits`.

### Global development link

From the repository root:

```sh
pnpm link:global
gits --help
```

`link:global` registers the development CLI globally as `gits`. That entry point uses the repository's installed `tsx` to load CLI and Core sources, so source edits require neither a rebuild nor a global `tsx` installation. In a published tarball, `publishConfig` rewrites the executable entry to `dist/index.js`, which runs with native Node.js.

## Quick start

Create a task directory and generate its initial scaffold:

```sh
mkdir -p /tmp/gits-demo
pnpm start -- -C /tmp/gits-demo init
```

The directory will contain:

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

Scaffdog generates these files from [`packages/core/templates/taskScaffold.md`](packages/core/templates/taskScaffold.md). Developers can edit that template to maintain the defaults for new tasks. The four `AGENTS.md` files explain the task workspace, documentation, automation scripts, and multi-repository container so later agents can reuse accumulated context and tools. Re-running `init` fills in missing files without overwriting existing content.

The generated `task.config.jsonc` explicitly lists and documents every supported repository option. Replace the placeholders and change values as needed:

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

Then prepare and inspect the repositories:

```sh
pnpm start -- -C /tmp/gits-demo install
pnpm start -- -C /tmp/gits-demo status
```

To reuse the task context from an existing task directory:

```sh
mkdir -p /tmp/gits-demo-copy
pnpm start -- -C /tmp/gits-demo-copy init \
  --scan /Users/bytedance/Desktop/tasks/task-save-btn-state
```

`--scan` recursively copies every file and directory from the source task except the source `repos/` tree. The target task installs its own repository workspaces from the imported `task.config.jsonc`. Scanning does not recursively search for other task configurations, access remotes, or modify the source directory.

### Checking out only part of a repository

Use the optional `checkout` array to limit which directories are materialized in a working tree. The following still creates a complete Git repository that can be edited, committed, and pushed, but only expands `knowledge/` in the working tree:

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

`checkout: null` means a full checkout. An array must contain at least one repository-relative directory. Existing configurations may omit this field for compatibility, but `gits init` no longer relies on that implicit form. Version 1 uses Git cone-mode sparse checkout and rejects absolute paths, `..`, backslashes, globs, individual files, and `.git` management paths. Cone mode keeps direct files at the repository root but does not materialize unrelated subdirectories.

```sh
gits install meego-aio
gits status meego-aio
```

`install` installs missing repositories and safely reconciles existing ones. After changing `checkout`, run `install` again to apply it. If the working tree contains uncommitted or untracked changes, the CLI refuses to change the checkout scope. `status` reports configuration drift as `checkout-different`, and `switch` reapplies the configured sparse checkout after changing the task branch. If a configured path is absent from the target `HEAD`, installation fails with `checkout-path-missing` and leaves no new repository behind.

Sparse checkout and repository mirrors are independent features. A mirror always stores a complete bare repository keyed by normalized remote identity. `checkout` is not part of the mirror key, so multiple working-tree views of the same remote share one mirror:

```sh
gits repo-mirrors add --from-task meego-aio --yes
gits install meego-aio
```

By default, non-dissociated installations continue to borrow mirror objects through alternates. Sparse checkout reduces materialized files in the task working tree; it does not reduce the complete mirror's object storage or automatically enable partial clone.

## Commands

```sh
gits init [--scan <source-task-dir>]
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

Task commands search upward from the current directory for the nearest `task.config.jsonc`. Use Git-style `-C` to operate on a task from another directory:

```sh
gits -C tasks/task-template-import status --json
```

The `--json` output for task commands has a stable `{ command, ok, repos }` shape; mirror commands return `{ command, ok, mirrors }`. Incur also provides command schemas, shell completion, `--llms`, MCP, and suggested next actions (CTA).

## Uninstall

Preview every persistent gits path that will be removed:

```sh
gits uninstall --dry-run
```

After confirmation, uninstall stops and removes the LaunchAgent or systemd user timer owned by the current `GITS_HOME`, including Linux timer enablement symlinks. It permanently deletes mirrors, configuration, state, logs, locks, temporary files, trash, and finally `GITS_HOME` itself:

```sh
gits uninstall --yes
```

If task repositories still borrow mirror objects through alternates, uninstall refuses by default. Prefer safely copying the required objects and validating each repository. Use `--force` only when you explicitly accept that dependent repositories may be damaged. Force mode still validates dangerous paths and ownership, but bypasses dependency and mirror-health checks, so a damaged config, dependency state, or bare repository cannot prevent final cleanup:

```sh
gits uninstall --detach-dependents --yes
gits uninstall --force --yes
```

The CLI removes only runtime data and native scheduler projections that it owns. It does not traverse or delete task workspaces, package-manager-installed executables, or global links. Remove the package itself with the tool that installed it.

All machine-level persistent paths are registered in `packages/core/src/service/gitsPersistenceRegistry.ts`, including the default data root, managed files and directories beneath it, and scheduler files projected into operating-system locations. New features must register and reuse persistent paths instead of hard-coding them. `uninstall --dry-run` and the real cleanup then share the same inventory.

## Repository mirrors

`repo-mirrors` manages machine-level Git object mirrors. Once a mirror exists, the normal `gits install` flow automatically matches it by normalized remote URL; no additional install option is required:

```sh
gits repo-mirrors add git@host:team/api.git --name api --yes
gits repo-mirrors add --from-task --yes
gits repo-mirrors list --wide
gits install
```

A mirror is a bare repository created with `git clone --mirror`. It contains Git objects, refs, and configuration but no editable checkout. Data and configuration live under `~/.gits` by default:

```text
~/.gits/
├── config.jsonc
├── repo-mirrors/<name>.git/
├── state/repo-mirror-dependencies/<name>.json
├── logs/repo-mirrors/<name>/*.jsonl
├── locks/
├── bin/gits-repo-mirror-runner
├── tmp/
└── trash/
```

`repoMirrors` is an array in `~/.gits/config.jsonc`. Each element's `name` is its stable primary key. `urls` is also a non-empty array: `urls[0]` is the active fetch URL, and the remaining URLs are aliases used for automatic matching. SSH and HTTPS URLs for the same repository can therefore share one mirror:

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

Mirror logs are bounded. Each mirror retains at most 20 completed logs totaling 10 MiB, and all mirrors share a 256 MiB cap for completed logs. Active logs left by abnormal exits are removed after the writer is confirmed dead and 24 hours have elapsed, with an absolute maximum lifetime of seven days. Each launchd/systemd emergency log is capped at 1 MiB with two backups, or about 3 MiB per mirror.

A new mirror without `--schedule` refreshes roughly every six hours with a stable per-mirror offset. macOS uses a user LaunchAgent; Linux uses a `systemd --user` timer. `~/.gits/config.jsonc` remains the source of truth, while operating-system directories contain only rebuildable scheduler projections. `list --wide` shows the local path, active URL, aliases, cron expression, next run, native job, and generated fetch command. You can also run:

```sh
gits repo-mirrors path api
gits repo-mirrors fetch api
gits repo-mirrors set api --schedule off
gits repo-mirrors logs api --lines 200
gits repo-mirrors doctor api --deep
```

Installation uses `git clone --reference-if-able` by default and keeps alternates. This is faster and consumes less additional disk space, but the new repository borrows Git objects from the mirror. The CLI records and protects that dependency, preventing unsafe mirror removal, repair, or garbage collection. To give a task repository an independent object database, opt in through its `task.config.jsonc`:

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

Removal behavior is explicit:

```sh
gits repo-mirrors remove api --yes                       # move to trash when unused
gits repo-mirrors remove api --detach-dependents --yes   # repack and verify dependents first
gits repo-mirrors remove api --force --yes               # bypass protection; dependents may break
gits repo-mirrors remove api --purge --yes               # permanently delete without trash
```

`--force` and `--detach-dependents` are mutually exclusive, and neither bypasses active locks or path validation. LFS payloads and submodules have independent storage and remotes, so a parent repository mirror does not accelerate them automatically.

## Key behavior

- `init` is idempotent: it fills in missing scaffold files without overwriting existing content.
- Placeholder values such as `<...>` prevent `install`, `status`, `fetch`, `switch`, and `push` from running.
- `init --scan <source-task-dir>` imports all task content except `repos/` from the source root. It does not search recursively for other task configurations, access remotes, or read or modify Git repositories in the source directory.
- Import replaces only default scaffold content in the target. It fails instead of overwriting customized target files.
- `install` clones into a tool-managed temporary directory and atomically moves the repository into place only after sparse checkout and branch preparation succeed. For an existing repository, it safely reconciles `checkout` without changing unrelated Git state.
- `install` transparently tries to use a healthy matching mirror. Invalid configuration, mirror health, or locks cause a lossless fallback to a normal clone.
- Mirror-backed installs keep protected alternates by default. Only repositories with explicit `dissociate: true` in `task.config.jsonc` copy objects and sever the dependency.
- `install`, `fetch`, and missing-branch preparation support concurrency. In a TTY, Listr2 keeps a stable row for each repository and its Git output; JSON, agent, and pipe modes emit no dynamic terminal control sequences.
- `switch` stashes a dirty working tree only when `--stash` is explicitly supplied, and it never restores that stash automatically.
- `checkout` controls only the working-tree view. Path lists do not enter mirror definitions, so full and sparse checkouts of the same remote share a mirror.
- `push` is the only command that writes to a remote. It never force-pushes, deletes branches, or automatically merges or rebases.
- SSH, SCP, and HTTPS forms of the same host/path repository are recognized as the same repository and reported as `url-different` when their spelling differs.

## Project layout

```text
apps/cli/src/
├── contract/        # CLI types, constants, and injectable interfaces
├── service/         # CLI startup, interaction, errors, output, and progress
├── module/          # Task, RepoMirror, and Uninstall command classes
├── bootstrap/       # the single Injector composition root
├── dependencies.ts  # default CLI bindings
└── index.ts         # process entry point

packages/core/src/
├── contract/        # cross-package types and injectable interfaces/Identifiers
├── service/         # foundational Git, file, process, and concurrency services
├── module/          # Task, RepoMirror, and Uninstall business services
├── dependencies.ts  # default Core bindings
└── index.ts         # public Core surface consumed by CLI
```

The rule is “depend on interfaces, register implementations.” Constructors inject only `I...Service` Identifiers; `dependencies.ts` binds concrete implementations through `{ useClass }`. Each CLI invocation creates exactly one Injector.

TypeScript uses Bundler module resolution. Relative source imports omit file extensions, for example `import './Foo'`. tsdown resolves the `.ts` modules and generates ESM that Node.js can execute directly, so source files do not pretend to import `.js` files and the repository contains no handwritten JavaScript source.

The Core package uses pnpm's `publishConfig` manifest-rewrite strategy, without custom conditions or `--conditions`. The development manifest exports `src/index.ts` so TypeScript and `tsx` both consume live source. During `pnpm pack` or `pnpm publish`, pnpm rewrites `exports` and `types` to `dist/index.js` and `dist/index.d.ts`. `files` contains only `dist`, so the tarball is created from the package root with its root `package.json` and build artifacts; no `dist/package.json` is required. This relies on pnpm behavior, so packages must not be published with `npm publish`.

## Validation

```sh
pnpm check
```

This command checks formatting, lint, types, architecture boundaries, tests, packages, and builds. CLI integration tests use isolated local bare Git remotes and cover scaffolding, `-C`, template import, configuration placeholders, installation, status, push, and `switch --stash`. Concurrency tests cover limits, stable result ordering, independent failures, and interruption semantics with Listr2 presentation enabled.
