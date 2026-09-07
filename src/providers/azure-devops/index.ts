import type { DeploymentConfig } from "../../config/types.ts"

type Environment = DeploymentConfig["environments"][number]

function yamlQuote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`
}

function branchRef(environment: Environment): string {
	return environment.branch.startsWith("refs/heads/")
		? environment.branch
		: `refs/heads/${environment.branch}`
}

function taskName(
	prefix: string,
	environment: Environment,
	index: number,
): string {
	return `${prefix}_env_${index}_${environment.id.replace(/[^A-Za-z0-9_]/gu, "_")}`
}

function securePathVariable(environment: Environment, index: number): string {
	return `ASHOKIFY_SECURE_ENV_${index}_${environment.id.replace(/[^A-Za-z0-9_]/gu, "_").toUpperCase()}`
}

function secureTask(environment: Environment, index: number): string[] {
	if (!environment.secureFile) return []
	return [
		"  - task: DownloadSecureFile@1",
		`    name: ${taskName("secure", environment, index)}`,
		`    displayName: Download secure frontend override for ${yamlQuote(environment.branch)}`,
		`    condition: and(succeeded(), eq(variables['Build.SourceBranch'], ${yamlQuote(branchRef(environment))}))`,
		"    inputs:",
		`      secureFile: ${yamlQuote(environment.secureFile)}`,
	]
}

function branchSelector(
	config: DeploymentConfig,
	includeHost: boolean,
): string {
	const lines: string[] = [
		'    branch_ref="${ASHOKIFY_SOURCE_BRANCH:-}"',
		'    public_file=""',
		'    override_file=""',
		'    environment_id=""',
		'    host_connection=""',
		'    case "$branch_ref" in',
	]
	for (const environment of config.environments) {
		lines.push(`      ${shellQuote(branchRef(environment))})`)
		lines.push(`        public_file=${shellQuote(environment.publicFile)}`)
		lines.push(`        environment_id=${shellQuote(environment.id)}`)
		if (environment.secureFile)
			lines.push(
				`        override_file=\"\${${securePathVariable(environment, config.environments.indexOf(environment))}:-}\"`,
			)
		if (includeHost && environment.hostConnection)
			lines.push(
				`        host_connection=${shellQuote(environment.hostConnection)}`,
			)
		lines.push("        ;;")
	}
	lines.push(
		"      *)",
		'        echo "No generated environment matches Build.SourceBranch: $branch_ref" >&2',
		"        exit 1",
		"        ;;",
		"    esac",
		'    [[ -n "$public_file" && -n "$environment_id" ]] || { echo "Branch environment selection failed" >&2; exit 1; }',
	)
	return lines.map(line => `      ${line.trimStart()}`).join("\n")
}

function buildArgs(config: DeploymentConfig): string {
	return config.frontendVariables.map(key => ` --build-arg ${key}`).join("")
}

function pathExpression(config: DeploymentConfig, relative: string): string {
	return `$(Build.SourcesDirectory)/${config.application.directory === "." ? relative : `${config.application.directory}/${relative}`}`
}

function trigger(config: DeploymentConfig): string[] {
	return [
		"trigger:",
		"  branches:",
		"    include:",
		...config.environments.map(
			environment => `      - ${yamlQuote(branchRef(environment))}`,
		),
		"pr: none",
	]
}

function commonVariables(
	config: DeploymentConfig,
	includeRegistry = true,
): string[] {
	const lines = [
		"variables:",
		`  ashokifyApplicationDirectory: ${yamlQuote(config.application.directory)}`,
	]
	if (includeRegistry)
		lines.push(
			`  ashokifyRegistryHost: ${yamlQuote(config.registry.hostname)}`,
			`  ashokifyImageRepository: ${yamlQuote(config.registry.repository)}`,
			`  ashokifyRegistryConnection: ${yamlQuote(config.pipeline.registryConnection)}`,
		)
	return lines
}

function secureTasks(config: DeploymentConfig): string[] {
	return config.environments.flatMap((environment, index) =>
		secureTask(environment, index),
	)
}

function buildEnvironment(
	config: DeploymentConfig,
	includeArtifactDirectory: boolean,
): string[] {
	const lines = [
		"    env:",
		"      ASHOKIFY_SOURCE_BRANCH: $(Build.SourceBranch)",
		"      ASHOKIFY_SOURCES_DIRECTORY: $(Build.SourcesDirectory)",
		"      ASHOKIFY_BUILD_ID: $(Build.BuildId)",
		"      ASHOKIFY_JOB_ATTEMPT: $(System.JobAttempt)",
		"      ASHOKIFY_STAGE_ATTEMPT: $(System.StageAttempt)",
	]
	if (includeArtifactDirectory)
		lines.push(
			"      ASHOKIFY_ARTIFACT_STAGING_DIRECTORY: $(Build.ArtifactStagingDirectory)",
		)
	for (const [index, environment] of config.environments.entries())
		if (environment.secureFile)
			lines.push(
				`      ${securePathVariable(environment, index)}: $(${taskName("secure", environment, index)}.secureFilePath)`,
			)
	return lines
}

function artifactPipeline(config: DeploymentConfig): string {
	const appPath = `$(Build.SourcesDirectory)/${config.application.directory === "." ? "" : `${config.application.directory}/`}`
	const appRelative =
		config.application.directory === "."
			? ""
			: `${config.application.directory}/`
	const args = buildArgs(config)
	const script = [
		"  - bash: |",
		"      set -euo pipefail",
		`      cd -- \"$ASHOKIFY_SOURCES_DIRECTORY/${appRelative}\"`,
		branchSelector(config, false),
		"      docker buildx version",
		'      builder_name="ashokify-$ASHOKIFY_BUILD_ID-$ASHOKIFY_JOB_ATTEMPT-$ASHOKIFY_STAGE_ATTEMPT"',
		'      if docker buildx inspect "$builder_name" >/dev/null 2>&1; then docker buildx use "$builder_name"; else docker buildx create --name "$builder_name" --driver docker-container --use; fi',
		'      docker buildx inspect --bootstrap "$builder_name"',
		'      artifact_dir="$ASHOKIFY_ARTIFACT_STAGING_DIRECTORY/ashokify-site"',
		'      mkdir -p "$artifact_dir"',
		`      bash scripts/prepare-frontend-env.sh \"$public_file\" \"$override_file\" -- docker buildx build --builder \"$builder_name\" --platform ${config.build.architecture}${args} --file Dockerfile --target artifact --output \"type=local,dest=$artifact_dir\" .`,
		"    displayName: Build static artifact",
		`    workingDirectory: ${yamlQuote(appPath)}`,
		...buildEnvironment(config, true),
	]
	const lines = [
		...trigger(config),
		"",
		"pool:",
		"  vmImage: ubuntu-latest",
		"",
		...commonVariables(config, false),
		"",
		"steps:",
		"  - checkout: self",
		...secureTasks(config),
		...script,
		"  - task: PublishPipelineArtifact@1",
		"    displayName: Publish static artifact",
		"    inputs:",
		"      targetPath: $(Build.ArtifactStagingDirectory)/ashokify-site",
		"      artifact: frontend-static",
	]
	return `${lines.join("\n")}\n`
}

function containerPipeline(config: DeploymentConfig): string {
	const appPath = `$(Build.SourcesDirectory)/${config.application.directory === "." ? "" : `${config.application.directory}/`}`
	const appRelative =
		config.application.directory === "."
			? ""
			: `${config.application.directory}/`
	const args = buildArgs(config)
	const imageBase = `${config.registry.hostname}/${config.registry.repository}`
	const hostProject = `ashokify-${config.application.id}`
	const buildScript = [
		"  - bash: |",
		"      set -euo pipefail",
		`      cd -- \"$ASHOKIFY_SOURCES_DIRECTORY/${appRelative}\"`,
		branchSelector(config, true),
		"      docker buildx version",
		'      builder_name="ashokify-$ASHOKIFY_BUILD_ID-$ASHOKIFY_JOB_ATTEMPT-$ASHOKIFY_STAGE_ATTEMPT"',
		'      if docker buildx inspect "$builder_name" >/dev/null 2>&1; then docker buildx use "$builder_name"; else docker buildx create --name "$builder_name" --driver docker-container --use; fi',
		'      docker buildx inspect --bootstrap "$builder_name"',
		`      image_ref=${shellQuote(`${imageBase}:`)}\"$ASHOKIFY_BUILD_ID-$ASHOKIFY_JOB_ATTEMPT-$ASHOKIFY_STAGE_ATTEMPT-$environment_id\"`,
		'      echo "##vso[task.setvariable variable=ashokifyImageReference]$image_ref"',
		'      metadata_dir="$ASHOKIFY_ARTIFACT_STAGING_DIRECTORY/ashokify-deployment"',
		'      mkdir -p "$metadata_dir"',
		`      bash scripts/prepare-frontend-env.sh \"$public_file\" \"$override_file\" -- docker buildx build --builder \"$builder_name\" --platform ${config.build.architecture}${args} --file Dockerfile --tag \"$image_ref\" --push .`,
		`      printf '{\"image\":\"%s\",\"environment\":\"%s\"}\\n' \"$image_ref\" \"$environment_id\" > \"$metadata_dir/deployment.json\"`,
		"    displayName: Build and publish exact image reference",
		`    workingDirectory: ${yamlQuote(appPath)}`,
		...buildEnvironment(config, true),
		"  - task: PublishPipelineArtifact@1",
		"    displayName: Publish deployment metadata",
		"    inputs:",
		"      targetPath: $(Build.ArtifactStagingDirectory)/ashokify-deployment",
		"      artifact: deployment-metadata",
	]
	const tailscale: string[] = []
	if (config.connectivity.tailscaleSecureFile) {
		tailscale.push(
			"  - task: DownloadSecureFile@1",
			"    name: tailscale_auth",
			"    displayName: Download requested Tailscale auth key",
			"    inputs:",
			`      secureFile: ${yamlQuote(config.connectivity.tailscaleSecureFile)}`,
			"  - bash: |",
			"      set -euo pipefail",
			"      if ! command -v tailscale >/dev/null; then curl --fail --silent --show-error --location https://tailscale.com/install.sh | sh; fi",
			"      command -v tailscale >/dev/null || { echo 'Tailscale is required by this configuration but is not installed on the agent.' >&2; exit 1; }",
			'      auth_file="${ASHOKIFY_TAILSCALE_AUTH_FILE:-}"',
			'      [[ -n "$auth_file" && -f "$auth_file" ]] || { echo \'The requested Tailscale secure file is missing.\' >&2; exit 1; }',
			'      auth_key="$(tr -d \'\\r\\n\' < "$auth_file")"',
			"      [[ -n \"$auth_key\" ]] || { echo 'The requested Tailscale secure file is empty.' >&2; exit 1; }",
			'      sudo tailscale up --auth-key="$auth_key"',
			"    displayName: Connect requested Tailscale network",
			"    env:",
			"      ASHOKIFY_TAILSCALE_AUTH_FILE: $(tailscale_auth.secureFilePath)",
		)
	}
	const deploy: string[] = []
	for (const [index, environment] of config.environments.entries()) {
		const project = `${hostProject}-${environment.id}`
		deploy.push(
			"  - task: DockerCompose@1",
			`    displayName: Deploy ${yamlQuote(environment.branch)} image to its Docker host`,
			`    condition: and(succeeded(), eq(variables['Build.SourceBranch'], ${yamlQuote(branchRef(environment))}))`,
			"    inputs:",
			"      containerregistrytype: Container Registry",
			`      dockerRegistryEndpoint: ${yamlQuote(config.pipeline.registryConnection)}`,
			`      dockerComposeFile: ${yamlQuote(pathExpression(config, "docker-compose.yml"))}`,
			"      dockerComposeFileArgs: |",
			"        ASHOKIFY_IMAGE=$(ashokifyImageReference)",
			`        ASHOKIFY_COMPOSE_PROJECT=${project}`,
			`      projectName: ${yamlQuote(project)}`,
			"      action: Run a Docker Compose command",
			"      dockerComposeCommand: up --detach --no-build --pull always",
			`      dockerHostEndpoint: ${yamlQuote(environment.hostConnection ?? "")}`,
			`      currentWorkingDirectory: ${yamlQuote(appPath)}`,
		)
	}
	const lines = [
		...trigger(config),
		"",
		"pool:",
		"  vmImage: ubuntu-latest",
		"",
		...commonVariables(config),
		"",
		"steps:",
		"  - checkout: self",
		"  - task: Docker@2",
		"    displayName: Login to container registry",
		"    inputs:",
		"      command: login",
		`      containerRegistry: ${yamlQuote(config.pipeline.registryConnection)}`,
		...secureTasks(config),
		...buildScript,
		...tailscale,
		...deploy,
	]
	return `${lines.join("\n")}\n`
}

/** Render the Azure DevOps pipeline for the selected recipe and serving mode. */
export function renderAzurePipeline(config: DeploymentConfig): string {
	return config.serving.mode === "artifact"
		? artifactPipeline(config)
		: containerPipeline(config)
}
