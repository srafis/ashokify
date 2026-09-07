import { validateConfig as validateSharedConfig } from "../config/index.ts"
import type {
	DeploymentConfig,
	GeneratedFiles,
	ValidationResult,
} from "../config/types.ts"
import { parseDocument } from "yaml"

type Environment = DeploymentConfig["environments"][number]
type ContainerServing = Extract<
	DeploymentConfig["serving"],
	{ mode: "container" }
>

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

function passed(name: string, detail: string): ValidationResult {
	return { name, status: "passed", detail }
}

function failed(name: string, detail: string): ValidationResult {
	return { name, status: "failed", detail }
}

function notRun(name: string, detail: string): ValidationResult {
	return { name, status: "not-run", detail }
}

function check(name: string, action: () => string): ValidationResult {
	try {
		return passed(name, action())
	} catch (error) {
		return failed(
			name,
			error instanceof Error ? error.message : String(error),
		)
	}
}

function requireFile(files: GeneratedFiles, path: string): string {
	const content = files[path]
	if (typeof content !== "string")
		throw new Error(`Missing generated file ${path}.`)
	return content
}

function branchRef(environment: Environment): string {
	return environment.branch.startsWith("refs/heads/")
		? environment.branch
		: `refs/heads/${environment.branch}`
}

function secureTaskName(environment: Environment, index: number): string {
	return `secure_env_${index}_${environment.id.replace(/[^A-Za-z0-9_]/gu, "_")}`
}

function securePathVariable(environment: Environment, index: number): string {
	return `ASHOKIFY_SECURE_ENV_${index}_${environment.id.replace(/[^A-Za-z0-9_]/gu, "_").toUpperCase()}`
}

function envKeys(content: string): string[] {
	return content
		.split(/\r?\n/u)
		.filter(line => line.length > 0 && !line.trimStart().startsWith("#"))
		.map(line => {
			const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/u.exec(line)
			if (!match) throw new Error("Invalid environment template line.")
			const key = match[1]
			if (!key) throw new Error("Invalid environment template key.")
			return key
		})
}

function sameKeys(
	actual: string[],
	expected: readonly string[],
	label: string,
): void {
	if (new Set(actual).size !== actual.length)
		throw new Error(`${label} contains duplicate variable keys.`)
	if (
		new Set(actual).size !== new Set(expected).size ||
		actual.some(key => !expected.includes(key))
	)
		throw new Error(
			`${label} does not contain exactly the approved frontend variable allowlist.`,
		)
}

function yamlObject(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${label} must be a YAML mapping.`)
	return value as Record<string, unknown>
}

function yamlSequence(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value))
		throw new Error(`${label} must be a YAML sequence.`)
	return value
}

function parseYaml(content: string, label: string): Record<string, unknown> {
	const document = parseDocument(content)
	if (document.errors.length)
		throw new Error(
			`${label} has invalid YAML: ${document.errors[0]?.message ?? "parse error"}`,
		)
	return yamlObject(document.toJS(), label)
}

function expectedPaths(config: DeploymentConfig): string[] {
	const paths = [
		"ashokify.config.json",
		"Dockerfile",
		"azure-pipelines.yml",
		".env.example",
		".gitignore",
		".dockerignore",
		"DEPLOYMENT.md",
		"scripts/prepare-frontend-env.sh",
		...config.environments.map(environment => environment.publicFile),
	]
	if (config.serving.mode === "container") {
		paths.push("docker-compose.yml", "docker-compose.override.yml")
		if (config.serving.nginx) paths.push("nginx.conf")
	}
	return paths
}

function assertNoUnsafePath(path: string): void {
	if (
		!path ||
		path.startsWith("/") ||
		path.includes("\\") ||
		path.split("/").some(part => part === ".." || part === "")
	)
		throw new Error(`Generated path is not relative: ${path}`)
}

function validateConfigFile(
	config: DeploymentConfig,
	files: GeneratedFiles,
): string {
	const parsed = JSON.parse(
		requireFile(files, "ashokify.config.json"),
	) as unknown
	const expected = validateSharedConfig(config)
	if (JSON.stringify(parsed) !== JSON.stringify(expected))
		throw new Error(
			"ashokify.config.json does not match the selected deployment configuration.",
		)
	return "The generated JSON parses and matches the validated configuration."
}

function validateEnvFiles(
	config: DeploymentConfig,
	files: GeneratedFiles,
): string {
	const expected = [...config.frontendVariables]
	const example = envKeys(requireFile(files, ".env.example"))
	sameKeys(example, expected, ".env.example")
	for (const environment of config.environments) {
		const keys = envKeys(requireFile(files, environment.publicFile))
		sameKeys(keys, expected, environment.publicFile)
	}
	return "Public templates contain only the approved frontend keys and visible placeholders."
}

function validatePipeline(
	config: DeploymentConfig,
	files: GeneratedFiles,
): string {
	const pipeline = requireFile(files, "azure-pipelines.yml")
	const document = parseYaml(pipeline, "azure-pipelines.yml")
	const trigger = yamlObject(document.trigger, "azure-pipelines.yml trigger")
	const triggerBranches = yamlObject(
		trigger.branches,
		"azure-pipelines.yml trigger.branches",
	)
	const includes = yamlSequence(
		triggerBranches.include,
		"azure-pipelines.yml trigger.branches.include",
	)
	if (
		includes.length !== config.environments.length ||
		includes.some(value => typeof value !== "string")
	)
		throw new Error(
			"azure-pipelines.yml trigger does not list exactly the selected environments.",
		)
	if (
		!Array.from(includes).every(value =>
			config.environments.some(
				environment => value === branchRef(environment),
			),
		)
	)
		throw new Error(
			"azure-pipelines.yml trigger contains an unselected branch.",
		)
	yamlSequence(document.steps, "azure-pipelines.yml steps")
	if (
		CONTROL_CHARACTERS.test(
			pipeline.replaceAll("\n", "").replaceAll("\r", ""),
		)
	)
		throw new Error("azure-pipelines.yml contains control characters.")
	if (/\t/u.test(pipeline))
		throw new Error("azure-pipelines.yml must use spaces for indentation.")
	if (!pipeline.startsWith("trigger:\n") || !pipeline.includes("\nsteps:\n"))
		throw new Error(
			"azure-pipelines.yml is missing trigger or steps sections.",
		)
	if (pipeline.includes("Build.SourceBranchName"))
		throw new Error(
			"azure-pipelines.yml must select environments using the full Build.SourceBranch ref.",
		)
	if (!pipeline.includes("Build.SourceBranch"))
		throw new Error(
			"azure-pipelines.yml does not inspect the full source branch ref.",
		)
	if (
		pipeline.includes('branch_ref="$(Build.SourceBranch)"') ||
		pipeline.includes("cd -- '$(Build.SourcesDirectory)") ||
		pipeline.includes('artifact_dir="$(Build.ArtifactStagingDirectory)') ||
		pipeline.includes('secureFilePath)"') ||
		pipeline.includes("secureFilePath)'")
	)
		throw new Error(
			"azure-pipelines.yml embeds an agent or secure-file path in shell source.",
		)
	if (
		!pipeline.includes("docker buildx version") ||
		!pipeline.includes("--driver docker-container") ||
		!pipeline.includes("docker buildx inspect --bootstrap")
	)
		throw new Error(
			"azure-pipelines.yml does not prepare an explicit Docker Buildx builder.",
		)
	for (const binding of [
		"ASHOKIFY_SOURCE_BRANCH: $(Build.SourceBranch)",
		"ASHOKIFY_SOURCES_DIRECTORY: $(Build.SourcesDirectory)",
		"ASHOKIFY_BUILD_ID: $(Build.BuildId)",
		"ASHOKIFY_JOB_ATTEMPT: $(System.JobAttempt)",
		"ASHOKIFY_STAGE_ATTEMPT: $(System.StageAttempt)",
	])
		if (!pipeline.includes(binding))
			throw new Error(
				`azure-pipelines.yml does not pass ${binding.split(":", 1)[0]} through the build environment.`,
			)
	if (
		!pipeline.includes(
			"ASHOKIFY_ARTIFACT_STAGING_DIRECTORY: $(Build.ArtifactStagingDirectory)",
		)
	)
		throw new Error(
			"azure-pipelines.yml does not pass the artifact staging directory through the build environment.",
		)
	const applicationSuffix =
		config.application.directory === "."
			? ""
			: `${config.application.directory}/`
	if (
		!pipeline.includes(
			`cd -- "$ASHOKIFY_SOURCES_DIRECTORY/${applicationSuffix}"`,
		)
	)
		throw new Error(
			"azure-pipelines.yml does not cd into the selected application directory.",
		)
	for (const environment of config.environments) {
		const ref = branchRef(environment)
		if (!pipeline.includes(ref))
			throw new Error(`azure-pipelines.yml does not include ${ref}.`)
		if (!pipeline.includes(environment.publicFile))
			throw new Error(
				`azure-pipelines.yml does not select ${environment.publicFile}.`,
			)
		if (
			config.serving.mode === "container" &&
			environment.hostConnection &&
			!pipeline.includes(environment.hostConnection)
		)
			throw new Error(
				`azure-pipelines.yml does not reference Docker host ${environment.hostConnection}.`,
			)
		if (
			environment.secureFile &&
			(!pipeline.includes("DownloadSecureFile@1") ||
				!pipeline.includes(environment.secureFile) ||
				!pipeline.includes(
					`${securePathVariable(environment, config.environments.indexOf(environment))}: $(${secureTaskName(environment, config.environments.indexOf(environment))}.secureFilePath)`,
				))
		)
			throw new Error(
				`azure-pipelines.yml does not require secure file ${environment.secureFile}.`,
			)
	}
	const appDirectory =
		config.application.directory === "."
			? "$(Build.SourcesDirectory)/"
			: `$(Build.SourcesDirectory)/${config.application.directory}/`
	if (!pipeline.includes(appDirectory))
		throw new Error(
			`azure-pipelines.yml does not use the application directory ${config.application.directory} as its build context.`,
		)
	if (config.serving.mode === "artifact") {
		if (!pipeline.includes("PublishPipelineArtifact@1"))
			throw new Error("Artifact pipeline does not publish its output.")
		if (
			pipeline.includes("DockerCompose@1") ||
			pipeline.includes("dockerHostEndpoint")
		)
			throw new Error("Artifact pipeline contains host deployment steps.")
	} else {
		if (
			!pipeline.includes("Docker@2") ||
			!pipeline.includes("command: login")
		)
			throw new Error(
				"Container pipeline does not authenticate to its registry.",
			)
		if (
			!pipeline.includes("DockerCompose@1") ||
			!pipeline.includes("dockerHostEndpoint")
		)
			throw new Error(
				"Container pipeline does not use an Azure Docker-host task.",
			)
		if (!pipeline.includes("--no-build"))
			throw new Error(
				"Container deployment must disable Compose rebuilds.",
			)
		if (
			!pipeline.includes("Build.BuildId") ||
			!pipeline.includes("deployment.json")
		)
			throw new Error(
				"Container pipeline does not carry a unique image reference into deployment metadata.",
			)
		if (pipeline.includes(":latest") || pipeline.includes(" latest"))
			throw new Error(
				"Container pipeline must not deploy a mutable latest tag.",
			)
	}
	if (
		config.connectivity.tailscaleSecureFile &&
		config.serving.mode === "container" &&
		(!pipeline.includes(config.connectivity.tailscaleSecureFile) ||
			!pipeline.includes(
				"ASHOKIFY_TAILSCALE_AUTH_FILE: $(tailscale_auth.secureFilePath)",
			))
	)
		throw new Error(
			"Requested Tailscale secure file is missing from the pipeline environment.",
		)
	if (
		!config.connectivity.tailscaleSecureFile &&
		pipeline.includes("tailscale")
	)
		throw new Error("Tailscale steps were generated without a request.")
	return "The Azure pipeline has explicit full-ref branch mapping and the selected delivery steps."
}

function validateDockerfile(
	config: DeploymentConfig,
	files: GeneratedFiles,
): string {
	const dockerfile = requireFile(files, "Dockerfile")
	if (
		!dockerfile.includes("COPY . .") &&
		(!dockerfile.includes("COPY package.json") ||
			!dockerfile.includes(config.build.lockfile))
	)
		throw new Error(
			"Dockerfile does not copy application source and the selected lockfile.",
		)
	if (!dockerfile.includes(config.build.command))
		throw new Error("Dockerfile does not run the selected build command.")
	if (!dockerfile.includes(`/workspace/${config.build.outputDirectory}`))
		throw new Error("Dockerfile does not copy the selected static output.")
	if (
		dockerfile.includes("source ") ||
		dockerfile.includes("eval ") ||
		dockerfile.includes("rm -rf") ||
		dockerfile.includes("docker system prune")
	)
		throw new Error(
			"Dockerfile contains unsafe shell or host cleanup behavior.",
		)
	for (const key of config.frontendVariables)
		if (
			!dockerfile.includes(`ARG ${key}`) ||
			!dockerfile.includes(`ENV ${key}=$${key}`)
		)
			throw new Error(
				`Dockerfile does not expose approved build argument ${key}.`,
			)
	if (config.build.packageManager === "npm" && !dockerfile.includes("npm ci"))
		throw new Error("npm builds must use npm ci.")
	if (
		config.build.packageManager === "pnpm" &&
		!dockerfile.includes("pnpm install --frozen-lockfile")
	)
		throw new Error("pnpm builds must use a frozen lockfile install.")
	if (config.build.packageManager === "yarn") {
		const installFlag = config.build.packageManagerVersion.startsWith("1.")
			? "--frozen-lockfile"
			: "--immutable"
		if (!dockerfile.includes(`yarn install ${installFlag}`))
			throw new Error(
				`Yarn builds must use ${installFlag} for a reproducible lockfile install.`,
			)
	}
	if (
		config.build.packageManager === "bun" &&
		!dockerfile.includes("bun install --frozen-lockfile")
	)
		throw new Error("Bun builds must use a frozen lockfile install.")
	if (config.serving.mode === "artifact") {
		if (!dockerfile.includes("FROM scratch AS artifact"))
			throw new Error(
				"Artifact Dockerfile must expose an artifact target.",
			)
		if (
			dockerfile.includes("nginx.conf") ||
			dockerfile.toLowerCase().includes("/etc/nginx")
		)
			throw new Error(
				"Artifact Dockerfile must not include Nginx serving configuration.",
			)
	} else {
		const serving = config.serving as ContainerServing
		if (!dockerfile.includes(`FROM ${serving.image} AS runtime`))
			throw new Error(
				"Dockerfile does not use the selected serving image.",
			)
		if (!dockerfile.includes(`WORKDIR ${serving.assetPath}`))
			throw new Error(
				"Dockerfile does not use the selected serving asset path.",
			)
		if (
			serving.nginx &&
			!dockerfile.includes("nginx.conf /etc/nginx/conf.d/default.conf")
		)
			throw new Error(
				"Selected Nginx configuration is not copied into the runtime image.",
			)
		if (
			!serving.nginx &&
			(dockerfile.includes("nginx.conf") ||
				dockerfile.includes("/etc/nginx/conf.d"))
		)
			throw new Error(
				"Nginx configuration was generated without explicit selection.",
			)
	}
	return "The Dockerfile uses the selected toolchain and output target without host cleanup commands."
}

function validateIgnoreFiles(
	config: DeploymentConfig,
	files: GeneratedFiles,
): string {
	const gitignore = requireFile(files, ".gitignore")
	const dockerignore = requireFile(files, ".dockerignore")
	for (const [name, content] of [
		[".gitignore", gitignore],
		[".dockerignore", dockerignore],
	] as const) {
		for (const pattern of [
			".env",
			".env.*",
			".env.build.*.override",
			".env.build.*.override.local",
		])
			if (!content.includes(pattern))
				throw new Error(`${name} is missing ${pattern}.`)
		if (content.includes("!.env.build.*\n"))
			throw new Error(`${name} unignores unapproved environment files.`)
		for (const environment of config.environments)
			if (!content.includes(`!${environment.publicFile}`))
				throw new Error(
					`${name} does not allow the selected public file ${environment.publicFile}.`,
				)
	}
	if (
		!dockerignore.includes("node_modules") ||
		!dockerignore.includes(config.build.outputDirectory)
	)
		throw new Error(
			".dockerignore does not exclude dependencies and build output.",
		)
	return "Ignore files exclude local and secure environment material from commits and Docker context."
}

function validateCompose(
	config: DeploymentConfig,
	files: GeneratedFiles,
): string {
	if (config.serving.mode !== "container") return ""
	const runtime = requireFile(files, "docker-compose.yml")
	const override = requireFile(files, "docker-compose.override.yml")
	const runtimeObject = parseYaml(runtime, "docker-compose.yml")
	const overrideObject = parseYaml(override, "docker-compose.override.yml")
	const runtimeServices = yamlObject(
		runtimeObject.services,
		"docker-compose.yml services",
	)
	const overrideServices = yamlObject(
		overrideObject.services,
		"docker-compose.override.yml services",
	)
	const service = runtimeServices[config.application.id]
	const overrideService = overrideServices[config.application.id]
	if (!service || !overrideService)
		throw new Error("Compose files are missing the application service.")
	const runtimeService = yamlObject(service, "docker-compose.yml service")
	const overrideServiceObject = yamlObject(
		overrideService,
		"docker-compose.override.yml service",
	)
	if (
		runtimeObject.name !==
			"${ASHOKIFY_COMPOSE_PROJECT:?ASHOKIFY_COMPOSE_PROJECT is required}" ||
		runtimeService.image !== "${ASHOKIFY_IMAGE:?ASHOKIFY_IMAGE is required}"
	)
		throw new Error(
			"Runtime Compose must require the exact image and project references.",
		)
	if (
		runtimeService.platform !== config.build.architecture ||
		overrideServiceObject.platform !== config.build.architecture
	)
		throw new Error(
			"Compose files do not pin the selected target architecture.",
		)
	if (!overrideServiceObject.build)
		throw new Error("Compose build override is missing its build mapping.")
	if (
		!runtime.includes("ASHOKIFY_IMAGE") ||
		!runtime.includes("ASHOKIFY_COMPOSE_PROJECT")
	)
		throw new Error(
			"Runtime Compose requires explicit image and project variables.",
		)
	if (
		/^\s+build:/mu.test(runtime) ||
		runtime.includes("docker-compose.override.yml")
	)
		throw new Error(
			"Runtime Compose contains build configuration or an override reference.",
		)
	if (
		!override.includes("build:") ||
		!override.includes("context: .") ||
		!override.includes("target: runtime")
	)
		throw new Error("Compose build override is incomplete.")
	if (!runtime.includes("restart: unless-stopped"))
		throw new Error("Runtime Compose is missing its restart policy.")
	if (
		config.serving.hostPort !== undefined &&
		!runtime.includes(
			`${config.serving.hostPort}:${config.serving.containerPort}`,
		)
	)
		throw new Error(
			"Runtime Compose is missing the configured host port binding.",
		)
	if (
		config.serving.network &&
		(!runtime.includes(config.serving.network) ||
			!runtime.includes("external: true"))
	)
		throw new Error(
			"Runtime Compose does not preserve the explicitly selected shared network.",
		)
	return "Runtime Compose contains only image and serving settings; the build override remains separate."
}

function validateHelper(
	config: DeploymentConfig,
	files: GeneratedFiles,
): string {
	const script = requireFile(files, "scripts/prepare-frontend-env.sh")
	if (!script.startsWith("#!/usr/bin/env bash\n"))
		throw new Error("Frontend environment helper is not a Bash script.")
	if (
		script.includes("source ") ||
		/(^|\n)\s*\.\s+[^.]/u.test(script) ||
		script.includes("eval ")
	)
		throw new Error(
			"Frontend environment helper must parse files without sourcing or evaluating them.",
		)
	for (const key of config.frontendVariables)
		if (!script.includes(`'${key}'`))
			throw new Error(
				`Frontend environment helper is missing allowlisted key ${key}.`,
			)
	if (
		!script.includes("Unresolved public frontend value") ||
		!script.includes("Missing approved public frontend value")
	)
		throw new Error(
			"Frontend environment helper does not fail clearly on unresolved values.",
		)
	return "Frontend environment values are parsed through an explicit allowlist with override precedence."
}

/** Validate generated files without accessing the filesystem, network or cloud services. */
export function validateGenerated(
	config: DeploymentConfig,
	files: GeneratedFiles,
): ValidationResult[] {
	let checked: DeploymentConfig
	try {
		checked = validateSharedConfig(config)
	} catch (error) {
		return [
			failed(
				"configuration",
				error instanceof Error ? error.message : String(error),
			),
		]
	}
	const results: ValidationResult[] = []
	results.push(
		check(
			"configuration",
			() =>
				"The deployment configuration satisfies the versioned schema.",
		),
	)
	results.push(
		check("generated-paths", () => {
			const expected = expectedPaths(checked)
			const rootManaged = new Set([".ashokify/manifest.json"])
			for (const path of Object.keys(files)) {
				assertNoUnsafePath(path)
				if (!expected.includes(path) && !rootManaged.has(path))
					throw new Error(`Unexpected generated path ${path}.`)
			}
			for (const path of expected) requireFile(files, path)
			return "All required recipe files are present under the application directory."
		}),
	)
	results.push(
		check("configuration-file", () => validateConfigFile(checked, files)),
	)
	results.push(
		check("public-environment-files", () =>
			validateEnvFiles(checked, files),
		),
	)
	results.push(
		check("azure-pipeline", () => validatePipeline(checked, files)),
	)
	results.push(check("dockerfile", () => validateDockerfile(checked, files)))
	results.push(
		check("ignore-files", () => validateIgnoreFiles(checked, files)),
	)
	results.push(
		check("frontend-environment-helper", () =>
			validateHelper(checked, files),
		),
	)
	if (checked.serving.mode === "container") {
		results.push(
			check("compose-files", () => validateCompose(checked, files)),
		)
		const serving = checked.serving as ContainerServing
		if (serving.nginx)
			results.push(
				check("nginx-configuration", () => {
					const nginx = requireFile(files, "nginx.conf")
					if (
						!nginx.includes("server {") ||
						!nginx.includes(`root ${serving.assetPath};`)
					)
						throw new Error(
							"Generated Nginx configuration is incomplete.",
						)
					return "Nginx configuration is present because it was explicitly selected."
				}),
			)
		else
			results.push(
				passed(
					"nginx-configuration",
					"Nginx configuration is absent until the developer explicitly selects it.",
				),
			)
	} else {
		results.push(
			passed(
				"serving-mode",
				"Artifact mode publishes static files and contains no host deployment stage.",
			),
		)
		results.push(
			notRun(
				"docker-build",
				"Build and test the image before deployment. See DEPLOYMENT.md for commands.",
			),
		)
	}
	return results
}
