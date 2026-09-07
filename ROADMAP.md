# Ashokify roadmap

The local MVP prepares Vite static frontend repositories for Azure DevOps deployment. It detects the project, collects deployment settings, previews and validates generated files, and offers one local commit. Cloud setup and pipeline execution follow in later releases.

This roadmap follows [the MVP scope](docs/SCOPE.md) and [the high-level design](docs/HLD.md). Milestones are ordered by dependency, without committed release dates. Unchecked items are planned work.

## Current state

- [x] Document the MVP scope and read-only deployment audit.
- [x] Document the architecture, configuration model and delivery requirements.
- [x] Add the initial Bun/TypeScript project files and Clack dependency declaration.
- [x] Implement and verify the local CLI, including the Node-compatible npm archive. See [implementation and verification notes](docs/IMPLEMENTATION.md).

## MVP: local repository preparation

Implementation and local verification are complete. The npm archive is prepared; package publication and the first real Azure deployment remain separate actions.

### 1. CLI foundation and Git preflight

- [x] Establish the CLI, workflow, inspection, configuration, rendering and adapter modules described in the HLD.
- [x] Add the interactive entry point, `--cwd`, `--help`, `--version`, cancellation handling and useful exit codes.
- [x] Develop and test with Bun; configure built JavaScript, bundled templates and an npm `bin` entry for Node-compatible distribution.
- [x] Locate the Git root and selected application directory. Reject staged, unstaged, conflicted, non-ignored untracked and submodule changes across the repository, with the blocking paths listed.
- [x] Capture the initial HEAD, index and worktree state for later concurrency checks.

Completion criteria: the CLI starts in a clean fixture repository, rejects each dirty-worktree case and leaves files unchanged when cancelled. Help and version work without starting setup.

### 2. Project inspection and confirmed configuration

- [x] Adapt the narrow shadcn detection logic behind an internal interface. Pin the upstream revision and preserve its license and attribution.
- [x] Detect Vite, package metadata, scripts, lockfiles and output settings without executing application configuration or installing dependencies.
- [x] Confirm static output, reject known server-dependent builds and support manual correction. Require one application directory for ambiguous monorepos; report unsupported shared-workspace builds.
- [x] Implement the scope's prompt sequence with Azure DevOps enabled and AWS and unsupported application types visibly disabled.
- [x] Default trigger branches to `main`, `staging` and `develop`; accept custom branches, deduplicate and require at least one. Map full branch names to unique environment identifiers and reject normalization collisions.
- [x] Confirm project name, registry hostname, image repository and registry connection separately. Prefer saved settings on reruns and preserve the target project's package manager.
- [x] Resolve the application's Node engine constraint to a concrete compatible build version, using Node 22 when absent. Confirm the build command, output directory and target architecture.
- [x] Collect the serving choice, applicable host connections, ports, networks and optional Tailscale requirements without assigning shared host resources implicitly.
- [x] Discover and confirm frontend variable names and exact secure-override references without copying private local values.
- [x] Define and validate the versioned, nonsecret `ashokify.config.json` schema, package-manager support and serving-input rules.

Completion criteria: React and Vue static Vite fixtures produce the same recipe with editable, evidence-backed settings. Unknown stacks, conflicting lockfiles, invalid engine constraints and branch collisions stop generation until resolved.

### 3. Build recipes and Azure pipeline generation

- [x] Create versioned templates and deterministic renderers driven by the validated configuration.
- [x] Generate an artifact workflow for external or deferred serving. Publish static output and describe the remaining delivery and serving work.
- [x] Generate a container workflow for a fully configured serving container, including Docker build configuration, runtime Compose and an explicit build override.
- [x] Add Nginx files and Dockerfile content only when explicitly selected and requested. Preserve other applications' serving and proxy configuration.
- [x] Use one branch mapping for triggers, environment files, resource references and deployment conditions, matching full branch refs.
- [x] Publish uniquely identified images and deploy the exact published reference. Keep build overrides out of runtime deployment and disable rebuilding there.
- [x] Scope Compose projects and networks to the application and environment; require explicit shared networks and host port bindings.
- [x] Generate public environment templates, merge required ignore rules and pass only approved frontend keys into builds. Define secure-override precedence and fail clearly when required values or files are missing.
- [x] Emit secure-file and VPN tasks only when configured. Exclude private environment files and credentials from Docker context and release artifacts.
- [x] Generate `DEPLOYMENT.md` with the selected behavior, exact external resource names, validation results and outstanding prerequisites.

Completion criteria: generated YAML parses and every selected branch has consistent build and deployment configuration. Default output contains no Nginx setup. Artifact mode makes no claim of a running frontend; container mode deploys the image it published.

### 4. Preview, controlled writes and optional commit

- [x] Plan creates, updates, unchanged files, conflicts and proposed deletions with expected content hashes and readable diffs.
- [x] Track managed paths, template version and last generated hashes in `.ashokify/manifest.json`.
- [x] Preserve unrelated content and existing quality gates. Require explicit review before adopting or replacing custom deployment files; merge ignore patterns without duplicates.
- [x] Validate proposed files in temporary copies before applying the reviewed change set. Report checks as passed, failed or not run.
- [x] Recheck HEAD, index and worktree before writing, then check expected content as each file is applied. Recover from partial failure without overwriting concurrent user edits.
- [x] Offer one commit after successful generation and validation. Stage only reviewed paths; stop automatic committing if unrelated changes or a changed HEAD appear.
- [x] Leave changes unstaged when the commit is declined. Preserve generated work and report the actual index state after identity or hook failures.
- [x] Make identical inputs and template versions produce identical bytes. An identical rerun after committing must produce no diff or empty commit.

Completion criteria: fixture tests cover cancellation, existing-file conflicts, partial write failures, concurrent edits, exact commit contents, declined commits, hook failures and unchanged reruns. No automatic stash, reset or push occurs.

### 5. Release verification and documentation

- [x] Add Bun tests and representative fixtures for React/Vue static builds, supported package managers, Node constraints, custom output directories and default/custom branch combinations.
- [x] Validate generated YAML and Compose with nonsecret fixture values, and perform real Docker builds for supported frontend recipes.
- [x] Verify the selected serving setup, including SPA fallback and proxy behavior where applicable. Check that two projects can use distinct Compose identities, ports and networks without modifying shared configuration.
- [x] Verify optional and required secure overrides, public/private variable separation and the absence of credentials in generated files, logs and published artifacts.
- [x] Run the packed executable using Node alone, without Bun or a TypeScript compilation step on the user's machine. Verify bundled templates and published package contents.
- [x] Add automated type checks, tests and package verification to CI.
- [x] Expand the README with installation, supported inputs, a setup walkthrough, rerun/conflict behavior and deployment handoff instructions.
- [x] Prepare the first package release after the MVP completion criteria in `docs/SCOPE.md` pass.

Completion criteria: a developer can prepare a supported repository using the packaged CLI without Azure authentication, inspect the generated changes and optionally commit them. Documentation distinguishes local validation from cloud readiness and records any checks not run.

## After the MVP

### 6. Azure DevOps setup using an existing host

- [ ] Add a separate cloud workflow that consumes the saved configuration and records nonsecret resource IDs, configuration fingerprints and step outcomes for resumption.
- [ ] Check Azure CLI tooling and access to the explicit organization/project through DevOps reads. Distinguish authentication, permissions, resource visibility and network failures.
- [ ] Discover resources and verify identity and configuration before reuse. Check existing host reachability, architecture, authenticated Docker access and application resource ownership when container deployment is selected.
- [ ] Preview and confirm cloud mutations, then create or reuse registry/host connections and upload selected private files under their confirmed Azure names.
- [ ] Register or reuse the pipeline without triggering a run, then authorize its specific connections, secure files and required agent pool.
- [ ] Verify the remote branch and revision contain the generated files before offering pipeline execution. Keep pushing a separate action.
- [ ] Report the run URL and stage failures. Reconcile saved progress with cloud state on retry and block steps whose prerequisites remain incomplete.

Completion criteria: a separately authorized integration run completes the selected workflow and resumes after an interrupted step without duplicating resources or deleting shared infrastructure. Artifact workflows omit host-specific steps.

### 7. Host provisioning and bootstrap

- [ ] Establish and document the missing certificate/bootstrap procedure. The audited Docker installation script does not configure authenticated remote Docker access.
- [ ] Add a host adapter independent of the pipeline provider, with AWS EC2 as a later implementation.
- [ ] Collect and preview account, region, machine architecture, network and resource choices before provisioning.
- [ ] Implement the supported host bootstrap, authenticated Docker access, firewall/network requirements and optional Tailscale configuration. Verify access from the deployment agent.
- [ ] Check port availability and ownership while preserving other projects' containers, Nginx configuration, certificates and shared routing.
- [ ] Create host connections only after the endpoint and authentication material exist. Retain completed resources and provide a resumable path after failures.

Completion criteria: an explicitly authorized integration test provisions and verifies a host, connects it to the Azure workflow and deploys a fixture alongside an existing project without changing that project's configuration.

## Deferred scope

SSR applications, backend recipes, shared-workspace builds, additional pipeline providers and arbitrary artifact transfer need separate scope and design work. A public plugin framework, hosted backend and database are outside the current plan. Keep unsupported choices disabled until their complete workflows and verification exist.
