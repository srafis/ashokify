# Local MVP implementation

The local preparation workflow is implemented. The CLI reads one application, confirms deployment settings, renders and validates a proposed file set, applies the reviewed changes and offers one local commit.

The scope and architecture remain in [SCOPE.md](SCOPE.md) and [HLD.md](HLD.md). Cloud resource setup and pipeline execution are later workflows.

## Implementation decisions

| Area                  | Current behavior                                                                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime               | Node 22 or later for the distributed executable; Bun for development, tests and bundling.                                                                                                                        |
| Entry point           | `ashokify`, with `--cwd`, `--help` and `--version`. Interactive setup requires a terminal.                                                                                                                       |
| Configuration         | `ashokify.config.json`, schema version 1 and template version 1. Unknown fields fail validation.                                                                                                                 |
| Managed files         | `.ashokify/manifest.json` records paths and generated SHA-256 hashes. The manifest excludes its own hash.                                                                                                        |
| Template distribution | Pure TypeScript renderers bundled into the executable. Users need no separate template checkout.                                                                                                                 |
| Detection             | Static checks adapted from the pinned shadcn source in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md), plus build, lockfile, engine, workspace and environment inspection.                                  |
| Node build versions   | Prefer `22.23.2`, then `24.20.0` when the engine range requires it. A compatible concrete Node 22 or 24 version can be entered manually.                                                                         |
| Package managers      | Reproducible installs using `npm ci`, pnpm/Bun frozen lockfiles, Yarn 1 frozen lockfiles or modern Yarn immutable installs. The selected version is explicit.                                                    |
| Frontend variables    | Explicitly approved `VITE_*` names with uppercase letters, digits and underscores. Public files provide defaults; a configured secure override takes precedence. Values are parsed as data, never shell-sourced. |
| Serving               | Static artifact export or a configured container. Nginx, SPA fallback and proxy configuration require explicit choices.                                                                                          |
| Cloud readiness       | Generated `DEPLOYMENT.md` names external prerequisites. Local success does not establish Azure permissions or host readiness.                                                                                    |

The pinned Node defaults come from the [Node.js release index](https://nodejs.org/dist/index.json). They are saved in configuration so a rerun does not silently change the build version. Updating them is a deliberate code change and requires fixture verification.

Paths, branch names, resource references and commands use conservative validation rules. Unsupported characters produce a field-specific error. Use a package-manager build command and put compound shell logic in the application's package script. A root workspace must select a standalone application with `--cwd`; builds that depend on another workspace are unsupported.

## Verification

Run the local checks with:

```sh
bun run check
bun run format:check
bun run verify:package
bun run verify:docker
```

The test suite uses temporary Git repositories to check dirty worktrees, submodules, unresolved conflicts, cancellation, custom file adoption, removed environments, concurrent changes, failed hooks, exact commit contents and identical reruns. Configuration and renderer tests cover branch mapping, static/SSR detection, engine constraints, environment handling and generated document validation.

The package check builds an npm archive and drives its executable through an npm-style bin symlink in an actual terminal. Only Node and Git are available on that process's PATH. It checks help, version, interactive generation and a declined commit. `ASHOKIFY_TEST_NODE` can point to another Node binary for minimum-version testing.

The Docker verification creates its own fixture directories, images, containers and network. It removes those resources when the run finishes. It requires Docker, Compose, Buildx and network access for public images and fixture dependencies.

| Fixture           | Verified package-manager version | Serving                                           |
| ----------------- | -------------------------------- | ------------------------------------------------- |
| React static Vite | npm 10.8.2                       | Node serving container and static artifact export |
| Vue static Vite   | pnpm 9.15.9                      | Explicit Nginx configuration                      |
| React static Vite | Yarn 1.22.22                     | Node serving container                            |
| Vue static Vite   | Yarn 4.9.2                       | Explicit Nginx configuration                      |
| React static Vite | Bun 1.4.2                        | Node serving container                            |

These fixtures use Vite 6.1.0, a custom `site` output directory and a secure-file override for an unresolved public value. The checks verify real builds, an install hook that requires source files, SPA routes, private-file exclusion from the build stage and the absence of private values in published assets. Two generated Compose projects also run together on a shared network, with an explicitly selected Nginx proxy between them.

Other toolchain versions require their own build validation. Structural validation does not establish that a requested package version or container tag exists.

## Release boundaries

The npm archive is prepared and tested locally. Publishing the package is a separate action.

Azure YAML is parsed and checked locally. No Azure resources were created and no remote pipeline run was used to verify this implementation. Service connection authorization, secure-file permissions, host reachability and target application health must be verified before the first real deployment.

Host provisioning, bootstrap, resource discovery and resumable cloud execution remain unchecked in [ROADMAP.md](../ROADMAP.md).
