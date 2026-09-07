# ashokify

Prepare a Vite static frontend repository for deployment through Azure DevOps. Ashokify detects the build setup, asks for deployment settings, shows the proposed files and offers one local commit after validation.

The CLI is a one-time deployment file generator. Answers stay in memory during setup; it writes no Ashokify configuration or tracking files. Creating cloud resources, uploading secure files, registering pipelines and running deployments remain separate steps described in the generated `DEPLOYMENT.md`.

## Run from this repository

Use Bun 1.4.2 or later for development:

```sh
bun install --frozen-lockfile
bun run dev --cwd /path/to/frontend
```

To build and test the distributed executable:

```sh
bun run build
node dist/cli.js --help
node dist/cli.js --cwd /path/to/frontend
```

The built CLI requires Node 22 or later and Git. It does not require Bun, Azure CLI or Azure authentication on the user's machine. Setup requires an interactive terminal.

The package is prepared for npm distribution; this repository change does not publish it. After publication, the intended invocation is `npx ashokify`. To test a local package archive before publication, run `bun pm pack` and install that archive in a separate test environment.

## Supported applications

- Static Vite applications, including React and Vue. Both use the same deployment recipe.
- One application per invocation. Use `--cwd apps/web` for a standalone application inside a larger repository.
- npm, pnpm, Yarn and Bun projects with a committed lockfile and a confirmed package-manager version. Ashokify keeps the application's package manager.
- A Node build version compatible with the application's `engines.node`, with Node 22 as the fallback when that field is absent. This is separate from the Node version running Ashokify.
- Exact Git branches, including names containing slashes, mapped to distinct environment identifiers.

SSR applications, backends and builds that need shared workspace dependencies are outside the MVP. Detection reads project files without running scripts or importing executable configuration. Ashokify detects static Vite builds automatically. If it cannot determine the build type, it explains what to fix before continuing. Unknown output folders and package managers are resolved at their respective prompts.

## Setup walkthrough

Start with a clean Git worktree and index. Staged files, unstaged edits, unresolved conflicts, non-ignored untracked files and submodule changes anywhere in the repository block setup. Ignored private environment files can remain.

1. Select Azure DevOps. Ashokify checks that the app has a supported static Vite build.
2. Choose trigger branches. `main`, `staging` and `develop` start selected; custom branches are optional.
3. Enter the app name and container registry hostname. Ashokify derives the deployment and image names from the app name, and uses the registry hostname as the Azure DevOps service connection name. The registry defaults to `sifars.azurecr.io`.
4. Confirm package manager, concrete versions, build command, output directory and target architecture.
5. Choose external/deferred serving or configure a serving container. Nginx is an explicit option with no default selection. Container serving requires an image, asset destination, port and per-environment Docker-host connection names. Host port bindings, shared networks and Tailscale are optional.
6. Confirm public frontend variable names and any required Azure Secure File references.
7. Review every addition, edit, conflict and deletion. Accept the file changes, then choose whether to commit them.

Use a package-manager command such as `npm run build` for the build command. Keep shell pipelines and compound build logic in the application's package script.

Cancellation before applying the reviewed changes leaves the repository unchanged. Declining the commit leaves generated files unstaged. Setup never pushes the repository.

Terminal previews redact environment values and recognizable credential assignments. The generated files retain their reviewed public values.

## Generated deployment files

Ashokify writes `azure-pipelines.yml`, a Dockerfile, public environment templates, ignore rules and `DEPLOYMENT.md` inside the selected application directory. Container serving also gets runtime Compose and an explicit build override. Nginx configuration appears only when requested.

External or deferred serving produces a static artifact workflow. You still need a way to deliver and serve that artifact. A configured serving container produces an image build/publish workflow and deployment steps that use the exact published image. Resource connections and host readiness must be established before running the pipeline.

Public environment files contain placeholders for unresolved values. Supply intentional public values or the configured secure overrides before building. Vite exposes frontend values in browser code, even when their source is an Azure Secure File. Registry credentials, VPN keys and other deployment credentials must stay out of frontend configuration.

Generated pipelines use the full branch-to-environment mapping. Application/environment Compose names keep projects separate on a shared host; configured ports and existing networks still need a host-level availability check.

## Maintaining deployment files

Edit the generated files directly after setup. Use `Dockerfile` for build versions and commands, `azure-pipelines.yml` for branches and Azure connections, and `docker-compose.yml` for ports and networks. Keep related names consistent across the files. `DEPLOYMENT.md` describes the generated setup and remaining deployment steps.

If you run Ashokify again, it inspects the app and asks for new answers. It does not restore previous answers, track ownership or delete files from earlier runs. Any existing deployment file with different content requires explicit review before replacement. Ignore rules and existing public environment values are merged.

Files that already match the output remain unchanged, and no empty commit is created. A new invocation still requires a clean Git working tree. Commit-hook and Git identity failures retain the generated work and report the index state.

Older `ashokify.config.json` and `.ashokify/manifest.json` files are ignored and left untouched. They are no longer needed by Ashokify and can be removed from projects that used an earlier version.

Ashokify checks for concurrent changes before writing and committing. If an interrupted write needs recovery, it restores only files that still match the content it wrote and reports any remaining work.

## Validation and development

Setup performs structural validation before writing. When Docker Compose is available, container configurations are also checked in a temporary copy. Setup does not run application scripts or claim that an unbuilt image passed a Docker build. Cloud readiness remains separate from local checks.

```sh
bun run check
bun run format:check
bun run verify:package
bun run verify:docker
```

`verify:package` packs the executable and exercises help, version and interactive generation with only Node and Git on the test process's PATH. It uses Python's standard library to drive a terminal.

`verify:docker` requires a running Docker daemon, Buildx and network access for build images and fixture dependencies. It exercises real static frontend builds and the selected serving behavior in isolated fixtures. The CI workflow runs both verification commands.

See [ROADMAP.md](ROADMAP.md) for milestones, [docs/SCOPE.md](docs/SCOPE.md) for requirements and audit evidence, and [docs/HLD.md](docs/HLD.md) for architecture and future cloud integration.
