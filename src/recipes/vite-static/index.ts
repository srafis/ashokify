import type { DeploymentConfig, GeneratedFiles } from "../../config/types.ts"
import { validateConfig as validateSharedConfig } from "../../config/index.ts"
import { renderAzurePipeline } from "../../providers/azure-devops/index.ts"

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const PIPELINE_EXPRESSION = /\$\([^)]*\)/
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]*$/
const ENVIRONMENT_KEY = /^[A-Z][A-Z0-9_]*$/
const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/
const COMMAND = /^[A-Za-z0-9_./:@%+=,-]+(?: [A-Za-z0-9_./:@%+=,-]+)*$/

type Environment = DeploymentConfig["environments"][number]
type ContainerServing = Extract<
	DeploymentConfig["serving"],
	{ mode: "container" }
>

const PUBLIC_PLACEHOLDER = "<set-public-value>"
const SECURE_PLACEHOLDER = "<set-in-Azure-secure-file>"

function fail(message: string): never {
	throw new Error(message)
}

function stringValue(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0)
		fail(`${label} must be a non-empty string.`)
	if (CONTROL_CHARACTERS.test(value))
		fail(`${label} cannot contain control characters.`)
	if (PIPELINE_EXPRESSION.test(value))
		fail(`${label} cannot contain an Azure pipeline expression.`)
	return value
}

function safeRelativePath(
	value: unknown,
	label: string,
	allowDot = false,
): string {
	const path = stringValue(value, label)
	if (path.includes("\\") || path.startsWith("/") || path.includes("//"))
		fail(`${label} must be a relative POSIX path.`)
	const parts = path.split("/")
	if (
		parts.some(
			part => part === ".." || part === "" || (!allowDot && part === "."),
		)
	)
		fail(`${label} cannot contain empty or parent path segments.`)
	if (allowDot && path !== "." && parts.some(part => part === "."))
		fail(`${label} cannot contain dot path segments.`)
	return path
}

function shellSafeCommand(value: unknown, label: string): string {
	const command = stringValue(value, label)
	if (!COMMAND.test(command))
		fail(
			`${label} contains shell syntax. Use a package-manager command without shell operators.`,
		)
	return command
}

function safeReference(value: unknown, label: string): string {
	const reference = stringValue(value, label)
	if (reference.includes("\\")) fail(`${label} cannot contain backslashes.`)
	return reference
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`
}

function yamlQuote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`
}

function branchRef(branch: string): string {
	return branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`
}

function validateBranch(branch: unknown, index: number): string {
	const value = stringValue(branch, `environments[${index}].branch`)
	const name = value.startsWith("refs/heads/")
		? value.slice("refs/heads/".length)
		: value
	if (
		!BRANCH_NAME.test(name) ||
		name.includes("..") ||
		name.includes("//") ||
		name.endsWith("/") ||
		name.endsWith(".")
	) {
		fail(`environments[${index}].branch is not a safe Git branch name.`)
	}
	return name
}

function validateEnvironment(
	environment: Environment,
	index: number,
): Environment {
	const branch = validateBranch(environment.branch, index)
	if (!IDENTIFIER.test(environment.id))
		fail(
			`environments[${index}].id must be a lowercase deployment identifier.`,
		)
	const publicFile = safeRelativePath(
		environment.publicFile,
		`environments[${index}].publicFile`,
	)
	if (!publicFile.startsWith(".env.build."))
		fail(`environments[${index}].publicFile must be an .env.build.* file.`)
	const next: Environment = { branch, id: environment.id, publicFile }
	if (environment.secureFile !== undefined)
		next.secureFile = safeReference(
			environment.secureFile,
			`environments[${index}].secureFile`,
		)
	if (environment.hostConnection !== undefined)
		next.hostConnection = safeReference(
			environment.hostConnection,
			`environments[${index}].hostConnection`,
		)
	return next
}

function validateConfig(config: DeploymentConfig): DeploymentConfig {
	if (config.schemaVersion !== 1 || config.templateVersion !== 1)
		fail("Only schema version 1 and template version 1 are supported.")
	if (config.build.recipe !== "vite-static")
		fail("The Vite static recipe is required.")
	const applicationDirectory = safeRelativePath(
		config.application.directory,
		"application.directory",
		true,
	)
	const applicationName = stringValue(
		config.application.name,
		"application.name",
	)
	if (!IDENTIFIER.test(config.application.id))
		fail("application.id must be a lowercase deployment identifier.")
	const packageManager = config.build.packageManager
	if (!["npm", "pnpm", "yarn", "bun"].includes(packageManager))
		fail("Unsupported package manager.")
	const packageManagerVersion = stringValue(
		config.build.packageManagerVersion,
		"build.packageManagerVersion",
	)
	if (!/^[A-Za-z0-9][A-Za-z0-9.+/_-]*$/.test(packageManagerVersion))
		fail("build.packageManagerVersion is not safe to put in a build image.")
	const lockfile = safeRelativePath(config.build.lockfile, "build.lockfile")
	const nodeVersion = stringValue(
		config.build.nodeVersion,
		"build.nodeVersion",
	)
	if (!/^[0-9]+(?:\.[0-9]+){0,2}(?:-[A-Za-z0-9.-]+)?$/.test(nodeVersion))
		fail("build.nodeVersion must be a concrete Node version.")
	const command = shellSafeCommand(config.build.command, "build.command")
	const outputDirectory = safeRelativePath(
		config.build.outputDirectory,
		"build.outputDirectory",
	)
	if (!["linux/amd64", "linux/arm64"].includes(config.build.architecture))
		fail("Unsupported target architecture.")
	if (config.pipeline.provider !== "azure-devops")
		fail("Only Azure DevOps is supported by this recipe.")
	const registryConnection = safeReference(
		config.pipeline.registryConnection,
		"pipeline.registryConnection",
	)
	const hostname = stringValue(config.registry.hostname, "registry.hostname")
	if (!/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?$/.test(hostname))
		fail("registry.hostname must be a registry host without a URL scheme.")
	const repository = stringValue(
		config.registry.repository,
		"registry.repository",
	)
	if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(repository))
		fail("registry.repository is not a valid image repository.")
	if (!Array.isArray(config.environments) || config.environments.length === 0)
		fail("At least one deployment environment is required.")
	const environments = config.environments.map(validateEnvironment)
	const branches = new Set<string>()
	const ids = new Set<string>()
	const publicFiles = new Set<string>()
	for (const environment of environments) {
		if (branches.has(branchRef(environment.branch)))
			fail(`Duplicate environment branch: ${environment.branch}`)
		if (ids.has(environment.id))
			fail(`Duplicate environment identifier: ${environment.id}`)
		if (publicFiles.has(environment.publicFile))
			fail(`Duplicate environment file: ${environment.publicFile}`)
		branches.add(branchRef(environment.branch))
		ids.add(environment.id)
		publicFiles.add(environment.publicFile)
	}
	const frontendVariables = [...config.frontendVariables]
	if (new Set(frontendVariables).size !== frontendVariables.length)
		fail("frontendVariables cannot contain duplicates.")
	for (const key of frontendVariables) {
		if (!ENVIRONMENT_KEY.test(key))
			fail(`Frontend variable ${key} is not an approved public key.`)
	}
	if (config.serving.mode === "artifact") {
		stringValue(config.serving.destination, "serving.destination")
	} else {
		const serving = config.serving as ContainerServing
		if (
			!IMAGE_REFERENCE.test(serving.image) ||
			!serving.image.includes(":")
		)
			fail(
				"serving.image must be a tagged or digest-pinned image reference.",
			)
		if (
			!Array.isArray(serving.command) ||
			serving.command.some(
				item =>
					typeof item !== "string" || CONTROL_CHARACTERS.test(item),
			)
		)
			fail("serving.command must contain single-line strings.")
		if (!safeContainerPath(serving.assetPath))
			fail(
				"serving.assetPath must be an absolute path without parent segments.",
			)
		if (
			!Number.isInteger(serving.containerPort) ||
			serving.containerPort < 1 ||
			serving.containerPort > 65535
		)
			fail("serving.containerPort must be a valid TCP port.")
		if (
			serving.hostPort !== undefined &&
			(!Number.isInteger(serving.hostPort) ||
				serving.hostPort < 1 ||
				serving.hostPort > 65535)
		)
			fail("serving.hostPort must be a valid TCP port.")
		if (serving.network !== undefined && !IDENTIFIER.test(serving.network))
			fail("serving.network must be a lowercase identifier.")
		if (serving.nginx) {
			if (!serving.image.toLowerCase().includes("nginx"))
				fail("Nginx settings require an Nginx serving image.")
			if (
				serving.nginx.proxyPath !== undefined ||
				serving.nginx.proxyTarget !== undefined
			) {
				if (!serving.nginx.proxyPath || !serving.nginx.proxyTarget)
					fail(
						"Nginx proxyPath and proxyTarget must be provided together.",
					)
				if (
					!/^\/[A-Za-z0-9._/-]*$/.test(serving.nginx.proxyPath) ||
					serving.nginx.proxyPath.includes("..")
				)
					fail("nginx.proxyPath is not a safe URL path.")
				if (
					!/^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/?$/.test(
						serving.nginx.proxyTarget,
					)
				)
					fail("nginx.proxyTarget must be an HTTP or HTTPS origin.")
			}
		}
		for (const environment of environments)
			if (!environment.hostConnection)
				fail(
					`A Docker-host connection is required for ${environment.branch}.`,
				)
	}
	if (config.connectivity.tailscaleSecureFile !== undefined)
		safeReference(
			config.connectivity.tailscaleSecureFile,
			"connectivity.tailscaleSecureFile",
		)
	return {
		schemaVersion: 1,
		templateVersion: 1,
		application: {
			directory: applicationDirectory,
			name: applicationName,
			id: config.application.id,
		},
		build: {
			recipe: "vite-static",
			packageManager,
			packageManagerVersion,
			lockfile,
			...(config.build.nodeConstraint
				? {
						nodeConstraint: stringValue(
							config.build.nodeConstraint,
							"build.nodeConstraint",
						),
					}
				: {}),
			nodeVersion,
			command,
			outputDirectory,
			architecture: config.build.architecture,
		},
		pipeline: { provider: "azure-devops", registryConnection },
		registry: { hostname, repository },
		environments,
		serving:
			config.serving.mode === "artifact"
				? { mode: "artifact", destination: config.serving.destination }
				: config.serving,
		frontendVariables,
		connectivity: config.connectivity.tailscaleSecureFile
			? { tailscaleSecureFile: config.connectivity.tailscaleSecureFile }
			: {},
	}
}

function safeContainerPath(value: string): boolean {
	return (
		typeof value === "string" &&
		/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(value) &&
		!value.split("/").includes("..")
	)
}

function packageCommands(config: DeploymentConfig): {
	image: string
	install: string
	executable: string
} {
	const { packageManager, packageManagerVersion } = config.build
	if (packageManager === "bun")
		return {
			image: `node:${config.build.nodeVersion}-bookworm-slim`,
			install: `npm install --global bun@${packageManagerVersion} && bun install --frozen-lockfile`,
			executable: "bun",
		}
	if (packageManager === "pnpm")
		return {
			image: `node:${config.build.nodeVersion}-bookworm-slim`,
			install:
				"corepack enable && corepack install --global pnpm@" +
				packageManagerVersion +
				" && pnpm install --frozen-lockfile",
			executable: "pnpm",
		}
	if (packageManager === "yarn") {
		const installFlag = packageManagerVersion.startsWith("1.")
			? "--frozen-lockfile"
			: "--immutable"
		return {
			image: `node:${config.build.nodeVersion}-bookworm-slim`,
			install: `corepack enable && corepack install --global yarn@${packageManagerVersion} && yarn install ${installFlag}`,
			executable: "yarn",
		}
	}
	return {
		image: `node:${config.build.nodeVersion}-bookworm-slim`,
		install: `npm install --global npm@${packageManagerVersion} && npm ci`,
		executable: "npm",
	}
}

function copyInputs(): string {
	return "COPY . ."
}

function frontendArgs(config: DeploymentConfig): string {
	return config.frontendVariables
		.map(key => `ARG ${key}\nENV ${key}=$${key}`)
		.join("\n")
}

function dockerfile(config: DeploymentConfig): string {
	const packages = packageCommands(config)
	const args = frontendArgs(config)
	const build = shellSafeCommand(config.build.command, "build.command")
	const output = config.build.outputDirectory
	const buildStage = [
		"# syntax=docker/dockerfile:1.7",
		`FROM ${packages.image} AS build`,
		"WORKDIR /workspace",
		copyInputs(),
		`RUN ${packages.install}`,
		args,
		`RUN ${build}`,
	]
		.filter(Boolean)
		.join("\n")
	if (config.serving.mode === "artifact") {
		return `${buildStage}\n\nFROM scratch AS artifact\nCOPY --from=build /workspace/${output}/ /\n`
	}
	const serving = config.serving as ContainerServing
	const nginxCopy = serving.nginx
		? "\nCOPY nginx.conf /etc/nginx/conf.d/default.conf"
		: ""
	const command = serving.command.length
		? `\nCMD ${JSON.stringify(serving.command)}`
		: ""
	return `${buildStage}\n\nFROM ${serving.image} AS runtime\nWORKDIR ${serving.assetPath}\nCOPY --from=build /workspace/${output} ${serving.assetPath}${nginxCopy}${command}\n`
}

function envContent(keys: string[], branch: string): string {
	return `# Public Vite values for ${branch}. Values are bundled into browser code.\n${keys.map(key => `${key}=${PUBLIC_PLACEHOLDER}`).join("\n")}\n`
}

function exampleEnv(keys: string[]): string {
	return `# Public Vite values. Replace each placeholder before a build.\n${keys.map(key => `${key}=${PUBLIC_PLACEHOLDER}`).join("\n")}\n`
}

function dockerIgnore(config: DeploymentConfig): string {
	const publicFiles = config.environments
		.map(environment => `!${environment.publicFile}`)
		.join("\n")
	return `# Ashokify deployment exclusions\n.git\n.git/**\nnode_modules\n${config.build.outputDirectory}\n.npmrc\n.npmrc.*\n.env\n.env.*\n!.env.example\n${publicFiles}\n.env.build.*.override\n.env.build.*.override.local\n`
}

function gitIgnore(config: DeploymentConfig): string {
	const publicFiles = config.environments
		.map(environment => `!${environment.publicFile}`)
		.join("\n")
	return `# Ashokify deployment exclusions\n.env\n.env.*\n!.env.example\n${publicFiles}\n.env.build.*.override\n.env.build.*.override.local\n`
}

function composeRuntime(config: DeploymentConfig): string {
	if (config.serving.mode !== "container") return ""
	const serving = config.serving as ContainerServing
	const serviceName = config.application.id
	const lines = [
		"# Runtime file. The build override is intentionally not included during deployment.",
		"name: \${ASHOKIFY_COMPOSE_PROJECT:?ASHOKIFY_COMPOSE_PROJECT is required}",
		"services:",
		`  ${serviceName}:`,
		"    image: \${ASHOKIFY_IMAGE:?ASHOKIFY_IMAGE is required}",
		`    platform: ${yamlQuote(config.build.architecture)}`,
		"    restart: unless-stopped",
	]
	if (serving.command.length)
		lines.push(`    command: ${JSON.stringify(serving.command)}`)
	if (serving.hostPort !== undefined)
		lines.push(
			"    ports:",
			`      - \"${serving.hostPort}:${serving.containerPort}\"`,
		)
	if (serving.network)
		lines.push(
			"    networks:",
			`      - ${serving.network}`,
			"networks:",
			`  ${serving.network}:`,
			"    external: true",
		)
	return `${lines.join("\n")}\n`
}

function composeBuild(config: DeploymentConfig): string {
	if (config.serving.mode !== "container") return ""
	const args = config.frontendVariables
		.map(key => `        ${key}: ` + "${" + key + ":-}\n")
		.join("")
	return (
		[
			"# Local or build-stage inputs only. Deployment uses docker-compose.yml alone with --no-build.",
			"services:",
			`  ${config.application.id}:`,
			`    platform: ${yamlQuote(config.build.architecture)}`,
			"    build:",
			"      context: .",
			"      dockerfile: Dockerfile",
			"      target: runtime",
			"      args:",
			`        NODE_VERSION: ${yamlQuote(config.build.nodeVersion)}`,
			args.trimEnd(),
			"",
		]
			.filter(Boolean)
			.join("\n") + "\n"
	)
}

function nginxConfig(config: DeploymentConfig): string | undefined {
	if (config.serving.mode !== "container" || !config.serving.nginx)
		return undefined
	const nginx = config.serving.nginx
	const serving = config.serving as ContainerServing
	const lines = [
		"server {",
		`  listen ${serving.containerPort};`,
		"  server_name _;",
		`  root ${serving.assetPath};`,
		"  index index.html;",
		"",
		"  location / {",
		nginx.spaFallback
			? "    try_files $uri $uri/ /index.html;"
			: "    try_files $uri $uri/ =404;",
		"  }",
	]
	if (nginx.proxyPath && nginx.proxyTarget)
		lines.push(
			"",
			`  location ${nginx.proxyPath} {`,
			`    proxy_pass ${nginx.proxyTarget};`,
			"    proxy_set_header Host $host;",
			"    proxy_set_header X-Real-IP $remote_addr;",
			"  }",
		)
	lines.push("}")
	return `${lines.join("\n")}\n`
}

function frontendEnvScript(config: DeploymentConfig): string {
	const keys = config.frontendVariables
	const keyLines = keys.length
		? keys.map(key => `  ${shellQuote(key)}`).join("\n")
		: ""
	return `#!/usr/bin/env bash
set -euo pipefail

# Parse only the approved public frontend keys. This script never sources an env file.
public_file="\${1:-}"
override_file="\${2:-}"
if [[ "\${3:-}" != "--" || "$#" -lt 4 ]]; then
  echo "usage: $0 PUBLIC_FILE [SECURE_OVERRIDE_FILE] -- COMMAND [ARGS...]" >&2
  exit 64
fi
shift 3
declare -a allowed_keys=(
${keyLines}
)
declare -A values=()

read_values() {
  local file="$1"
  [[ -n "$file" && -f "$file" ]] || { echo "Required frontend environment file is missing: $file" >&2; exit 1; }
  declare -A file_keys=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="\${line%$'\\r'}"
    [[ "$line" =~ ^[[:space:]]*$ || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Z][A-Z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      key="\${BASH_REMATCH[2]}"
      value="\${BASH_REMATCH[3]}"
    else
      echo "Invalid environment line in $file" >&2
      exit 1
    fi
    # Trim dotenv whitespace around unquoted values before handling quotes/comments.
    value="\${value#"\${value%%[![:space:]]*}"}"
    value="\${value%"\${value##*[![:space:]]}"}"
    if [[ "$value" == \\"* ]]; then
      if [[ "$value" =~ ^\\"(([^\\"\\\\]|\\\\.)*)\\"[[:space:]]*(#.*)?$ ]]; then
        value="\${BASH_REMATCH[1]}"
        decoded=""
        escaped=false
        for ((i=0; i<\${#value}; i++)); do
          char="\${value:i:1}"
          if [[ "$escaped" == true ]]; then
            case "$char" in
              '"'|\\\\) decoded+="$char" ;;
              n) decoded+=$'\\n' ;;
              r) decoded+=$'\\r' ;;
              t) decoded+=$'\\t' ;;
              *) decoded+="\\\\$char" ;;
            esac
            escaped=false
          elif [[ "$char" == "\\\\" ]]; then
            escaped=true
          else
            decoded+="$char"
          fi
        done
        [[ "$escaped" == false ]] || { echo "Malformed quoted environment value in $file (multi-line values are unsupported)" >&2; exit 1; }
        value="$decoded"
      else
        echo "Malformed quoted environment value in $file (multi-line values are unsupported)" >&2
        exit 1
      fi
    elif [[ "$value" == \\'* ]]; then
      if [[ "$value" =~ ^\\'([^\\']*)\\'[[:space:]]*(#.*)?$ ]]; then
        value="\${BASH_REMATCH[1]}"
      else
        echo "Malformed quoted environment value in $file (multi-line values are unsupported)" >&2
        exit 1
      fi
    elif [[ "$value" =~ ^(.*[^[:space:]])[[:space:]]+#.*$ ]]; then
      value="\${BASH_REMATCH[1]}"
    fi
    for allowed in "\${allowed_keys[@]}"; do
      if [[ "$key" == "$allowed" ]]; then
        [[ -z "\${file_keys[$key]+present}" ]] || { echo "Duplicate approved frontend key in $file: $key" >&2; exit 1; }
        file_keys["$key"]=1
        values["$key"]="$value"
      fi
    done
  done < "$file"
}

read_values "$public_file"
if [[ -n "$override_file" ]]; then read_values "$override_file"; fi
for key in "\${allowed_keys[@]}"; do
  [[ -n "\${values[$key]+present}" ]] || { echo "Missing approved public frontend value: $key" >&2; exit 1; }
  [[ -n "\${values[$key]}" && "\${values[$key]}" != '<set-public-value>' && "\${values[$key]}" != '<set-in-Azure-secure-file>' ]] || { echo "Unresolved public frontend value: $key" >&2; exit 1; }
  export "$key=\${values[$key]}"
done
exec "$@"
`
}

function deploymentDoc(config: DeploymentConfig): string {
	const mode =
		config.serving.mode === "artifact"
			? "static artifact"
			: "container image"
	const buildTarget =
		config.serving.mode === "artifact" ? "artifact" : "runtime"
	const buildOutput =
		config.serving.mode === "artifact"
			? " --output type=local,dest=./ashokify-artifact"
			: ` --tag ${config.registry.hostname}/${config.registry.repository}:local`
	const lines = [
		`# ${config.application.name} deployment`,
		"",
		"This file was generated by Ashokify from the versioned Vite static recipe.",
		"",
		`The Azure DevOps pipeline builds and publishes a ${mode}. Local structural checks run before files are applied. Docker builds and cloud access still require a later verification run.`,
		"",
		"## Application",
		"",
		`- Application directory: \`${config.application.directory}\``,
		`- Deployment identifier: \`${config.application.id}\``,
		`- Package manager: \`${config.build.packageManager}@${config.build.packageManagerVersion}\``,
		`- Node build version: \`${config.build.nodeVersion}\``,
		`- Build command: \`${config.build.command}\``,
		`- Static output: \`${config.build.outputDirectory}\``,
		"",
		"## Branch mapping",
		"",
		"| Git branch | Environment id | Public file | Secure override | Docker host |",
		"| --- | --- | --- | --- | --- |",
	]
	for (const environment of config.environments)
		lines.push(
			`| \`${environment.branch}\` | \`${environment.id}\` | \`${environment.publicFile}\` | ${environment.secureFile ? `\`${environment.secureFile}\`` : "none"} | ${environment.hostConnection ? `\`${environment.hostConnection}\`` : "none"} |`,
		)
	lines.push("", "## Registry and serving")
	if (config.serving.mode === "artifact") {
		lines.push(
			"",
			`- Artifact destination: ${config.serving.destination}`,
			"- Serving remains external or pending. The artifact pipeline does not deploy to a host.",
		)
	} else {
		lines.push(
			"",
			`- Registry: \`${config.registry.hostname}\``,
			`- Image repository: \`${config.registry.repository}\``,
			`- Registry service connection: \`${config.pipeline.registryConnection}\``,
			`- Serving image: \`${config.serving.image}\``,
			`- Container asset path: \`${config.serving.assetPath}\``,
			`- Container port: \`${config.serving.containerPort}\``,
			config.serving.hostPort
				? `- Host port: \`${config.serving.hostPort}\``
				: "- Host port: none, use an existing proxy or explicit host routing.",
			config.serving.network
				? `- Shared network: \`${config.serving.network}\` and must already exist.`
				: "- Network: Compose creates the project network.",
			"- Deployment uses the exact image reference published by the build job and runs Compose with --no-build.",
		)
		if (config.serving.nginx)
			lines.push(
				"- Nginx configuration was explicitly selected for this application.",
			)
	}
	lines.push(
		"",
		"## Public frontend values",
		"",
		"The generated `.env.example` and per-environment files contain placeholders. Replace every placeholder before a build. Values with a `VITE_` prefix are visible in browser code. Secure overrides are allowlisted public values, not deployment credentials.",
		"",
		"## Local validation",
		"",
		`- Replace placeholders in the selected file, then run \`bash scripts/prepare-frontend-env.sh ${config.environments[0]?.publicFile ?? ".env.build.main"} \"\" -- docker buildx build --platform ${config.build.architecture} --file Dockerfile --target ${buildTarget}${buildOutput} .\`.`,
		"- Ashokify checked the generated files before writing them. It did not run a Docker build or verify Azure access.",
		"",
		"## Maintaining these files",
		"",
		"Edit these deployment files directly when the app changes. Ashokify does not save your answers or require a configuration file.",
		"",
		"- Change build versions and commands in `Dockerfile`.",
		"- Change branches, registry names and Azure service connections in `azure-pipelines.yml`.",
		"- Keep image references, Compose project names and public environment files consistent when renaming the app or its environments.",
	)
	if (config.serving.mode === "container")
		lines.push(
			"- Change ports and networks in `docker-compose.yml`, and local build settings in `docker-compose.override.yml`.",
		)
	if (config.serving.mode === "container" && config.serving.nginx)
		lines.push("- Change routing and proxy settings in `nginx.conf`.")
	if (config.serving.mode === "artifact") {
		lines.push(
			"",
			"## Remaining prerequisites",
			"",
			"- Decide how the published artifact reaches the external serving system.",
			"- Validate the concrete Docker build in the target architecture.",
		)
	} else {
		lines.push(
			"",
			"## Remaining prerequisites",
			"",
			"- Authorize the named Azure DevOps registry and Docker-host service connections for this pipeline.",
			"- Add each named secure file when an environment requires one. A missing or unauthorized secure file stops the pipeline.",
			"- Verify the selected Docker host, network and ports before the first deployment.",
			"- Validate the concrete Docker build and serving behavior in the target architecture.",
		)
		if (config.connectivity.tailscaleSecureFile)
			lines.push(
				`- Authorize the Tailscale secure file \`${config.connectivity.tailscaleSecureFile}\` and install Tailscale on the deployment agent when host access requires it.`,
			)
	}
	lines.push("")
	return `${lines.join("\n")}\n`
}

/** Render all files below the selected application directory. */
export function renderFiles(input: DeploymentConfig): GeneratedFiles {
	const config = validateSharedConfig(input)
	validateConfig(config)
	const files: GeneratedFiles = {}
	files["Dockerfile"] = dockerfile(config)
	files["azure-pipelines.yml"] = renderAzurePipeline(config)
	files[".env.example"] = exampleEnv(config.frontendVariables)
	for (const environment of config.environments)
		files[environment.publicFile] = envContent(
			config.frontendVariables,
			environment.branch,
		)
	files[".gitignore"] = gitIgnore(config)
	files[".dockerignore"] = dockerIgnore(config)
	files["DEPLOYMENT.md"] = deploymentDoc(config)
	files["scripts/prepare-frontend-env.sh"] = frontendEnvScript(config)
	if (config.serving.mode === "container") {
		files["docker-compose.yml"] = composeRuntime(config)
		files["docker-compose.override.yml"] = composeBuild(config)
		const nginx = nginxConfig(config)
		if (nginx) files["nginx.conf"] = nginx
	}
	return files
}

export { PUBLIC_PLACEHOLDER, SECURE_PLACEHOLDER }
