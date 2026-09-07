import { access, readFile } from "node:fs/promises"
import { relative, sep } from "node:path"
import { valid, satisfies, validRange, major } from "semver"
import {
	ConfigValidationError,
	mapBranches,
	normalizeIdentifier,
	resolveNodeVersion,
	validateConfig,
} from "../config/index.ts"
import type {
	DeploymentConfig,
	PackageManager,
	ProjectFacts,
} from "../config/types.ts"
import { Cancelled, type UserInterface } from "./ui.ts"

const packageManagerLabels: Record<PackageManager, string> = {
	npm: "npm",
	pnpm: "pnpm",
	yarn: "Yarn",
	bun: "Bun",
}

const required = (value: string) =>
	value.trim() ? undefined : "Enter a value."
const cleanLine = (value: string) =>
	/[\x00-\x1f\x7f]/.test(value)
		? "Use a single line without control characters."
		: undefined
const identifier = (value: string) =>
	/^[a-z0-9][a-z0-9_-]*$/.test(value)
		? undefined
		: "Use lowercase letters, numbers, hyphens or underscores."
const safePath = (value: string) =>
	/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(value) &&
	!value.split("/").some(part => part === "." || part === "..")
		? undefined
		: "Enter a folder path relative to this app, without spaces or .."
const reference = (value: string) =>
	required(value) ||
	cleanLine(value) ||
	(/[\$`]/.test(value)
		? "Resource names cannot contain dollar signs or backticks."
		: undefined)
const port = (value: string) =>
	/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535
		? undefined
		: "Enter a port between 1 and 65535."
const version = (value: string) =>
	valid(value) ? undefined : "Enter an exact version, such as 10.8.2."
const list = (value: string) => [
	...new Set(
		value
			.split(",")
			.map(item => item.trim())
			.filter(Boolean),
	),
]

export async function configure(
	facts: ProjectFacts,
	root: string,
	ui: UserInterface,
	saved?: DeploymentConfig,
): Promise<DeploymentConfig> {
	await ui.select(
		"provider",
		"Where should the pipeline run?",
		[
			{ value: "azure-devops", label: "Azure DevOps" },
			{
				value: "aws",
				label: "AWS",
				hint: "Not supported yet",
				disabled: true,
			},
		],
		"azure-devops",
	)
	if (facts.staticBuildIssue) throw new Error(facts.staticBuildIssue)
	if (facts.staticStatus === "unsupported")
		throw new Error(
			"This build is not supported. Use --cwd to select a standalone Vite app.",
		)
	for (const warning of facts.warnings) ui.warn(warning)
	const defaults = ["main", "staging", "develop"]
	const selected = await ui.multi(
		"branches",
		"Which branches should run the pipeline?",
		defaults.map(value => ({ value, label: value })),
		saved
			? saved.environments
					.map(env => env.branch)
					.filter(branch => defaults.includes(branch))
			: defaults,
	)
	const additional = await ui.text(
		"additionalBranches",
		"Additional branches, separated by commas",
		saved?.environments
			.map(env => env.branch)
			.filter(branch => !defaults.includes(branch))
			.join(", ") ?? "",
		value => {
			try {
				mapBranches([...selected, ...list(value)])
				return undefined
			} catch (error) {
				return (error as Error).message
			}
		},
		"release, qa",
	)
	const environments = mapBranches([...selected, ...list(additional)])
	ui.info(
		`Pipeline branches: ${environments.map(env => env.branch).join(", ")}`,
	)
	const name = await ui.text(
		"name",
		"App name",
		saved?.application.name ?? facts.name,
		value =>
			required(value) ||
			cleanLine(value) ||
			(!normalizeIdentifier(value)
				? "Enter a name containing letters or numbers."
				: undefined),
	)
	if (["frontend", "app", "web", "client"].includes(name.toLowerCase()))
		ui.warn(
			`'${name}' is a common name. Use a distinct deployment name below to identify this app on a shared host.`,
		)
	const id = await ui.text(
		"id",
		"Deployment name for Docker images and containers",
		saved?.application.id ?? normalizeIdentifier(name),
		identifier,
	)
	const hostname = await ui.text(
		"registry",
		"Container registry hostname",
		saved?.registry.hostname ?? "sifars.azurecr.io",
		value =>
			/^[a-z0-9][a-z0-9.-]*(?::\d+)?$/.test(value)
				? undefined
				: "Enter a registry hostname without a URL scheme.",
	)
	const repository = await ui.text(
		"repository",
		"Image name in the registry",
		saved?.registry.repository ?? id,
		value =>
			/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(value)
				? undefined
				: "Enter a lowercase image repository path.",
	)
	const registryConnection = await ui.text(
		"registryConnection",
		"Registry service connection name in Azure DevOps",
		saved?.pipeline.registryConnection ?? hostname,
		reference,
	)
	const detectedManager =
		facts.packageManagerCandidates.length === 1
			? facts.packageManager
			: undefined
	const manager =
		detectedManager ??
		(await ui.select<PackageManager>(
			"packageManager",
			"Which package manager does this app use?",
			["npm", "pnpm", "yarn", "bun"].map(value => ({
				value: value as PackageManager,
				label: packageManagerLabels[value as PackageManager],
			})),
			saved?.build.packageManager ?? facts.packageManager,
		))
	if (detectedManager)
		ui.info(`Package manager: ${packageManagerLabels[detectedManager]}`)
	const managerVersion = await ui.text(
		"packageManagerVersion",
		`${packageManagerLabels[manager]} version for builds`,
		saved?.build.packageManager === manager
			? saved.build.packageManagerVersion
			: facts.packageManager === manager
				? facts.packageManagerVersion
				: "",
		version,
	)
	const lockNames: Record<PackageManager, string[]> = {
		npm: ["package-lock.json", "npm-shrinkwrap.json"],
		pnpm: ["pnpm-lock.yaml"],
		yarn: ["yarn.lock"],
		bun: ["bun.lock", "bun.lockb"],
	}
	const existingLocks: string[] = []
	for (const name of lockNames[manager]) {
		try {
			await access(`${facts.directory}/${name}`)
			existingLocks.push(name)
		} catch {
			/* Require a lockfile below. */
		}
	}
	if (!existingLocks.length)
		throw new Error(
			`No ${manager} lockfile exists in the application directory. Create and commit one using the application's package manager, then rerun setup.`,
		)
	const lockfile =
		existingLocks.length === 1
			? existingLocks[0]!
			: await ui.select(
					"lockfile",
					"Which lockfile should the build use?",
					existingLocks.map(value => ({ value, label: value })),
					saved?.build.lockfile,
				)
	let proposedNode = saved?.build.nodeVersion ?? facts.nodeVersion ?? ""
	if (facts.nodeConstraint && !validRange(facts.nodeConstraint))
		throw new Error(
			"package.json engines.node is not a valid version range. Correct and commit it before running setup again.",
		)
	if (!proposedNode) {
		try {
			proposedNode = resolveNodeVersion(facts.nodeConstraint)
		} catch (error) {
			ui.warn((error as Error).message)
		}
	}
	const nodeVersion = await ui.text(
		"nodeVersion",
		`Node.js version for builds${
			facts.nodeConstraint
				? `, project requires ${facts.nodeConstraint}`
				: !saved?.build.nodeVersion && proposedNode
					? `, default Node.js ${major(proposedNode)}`
					: ""
		}`,
		proposedNode,
		value =>
			version(value) ||
			(![22, 24].includes(major(value))
				? "Choose a supported Node 22 or 24 release."
				: undefined) ||
			(facts.nodeConstraint && !satisfies(value, facts.nodeConstraint)
				? `Must satisfy ${facts.nodeConstraint}.`
				: undefined),
	)
	const manifest = JSON.parse(
		await readFile(`${facts.directory}/package.json`, "utf8"),
	)
	const command = await ui.text(
		"command",
		"Build command",
		saved?.build.command ??
			(manifest.scripts?.build ? `${manager} run build` : ""),
		value => {
			if (
				!/^[A-Za-z0-9_./:@%+=,-]+(?: [A-Za-z0-9_./:@%+=,-]+)*$/.test(
					value,
				)
			)
				return "Use a package-manager command such as npm run build. Keep shell operators in the package script."
			const script = /^(?:npm|pnpm|yarn|bun) run ([A-Za-z0-9_.:-]+)/.exec(
				value,
			)?.[1]
			if (script && typeof manifest.scripts?.[script] !== "string")
				return `package.json has no ${script} script. Enter an existing build command.`
			return undefined
		},
	)
	const outputDirectory = await ui.text(
		"outputDirectory",
		"Build output folder",
		saved?.build.outputDirectory ?? facts.outputDirectory,
		safePath,
	)
	const architecture = await ui.select<
		DeploymentConfig["build"]["architecture"]
	>(
		"architecture",
		"Build platform",
		[
			{ value: "linux/amd64", label: "Linux x64", hint: "Intel or AMD" },
			{ value: "linux/arm64", label: "Linux ARM64" },
		],
		saved?.build.architecture ?? "linux/amd64",
	)
	const servingChoice = await ui.select(
		"serving",
		"How should the pipeline deliver your app?",
		[
			{
				value: "artifact",
				label: "Publish the built files",
				hint: "Set up hosting separately",
			},
			{
				value: "container",
				label: "Deploy a Docker container",
				hint: "Use your own serving image",
			},
			{
				value: "nginx",
				label: "Deploy with Nginx",
				hint: "Generate an Nginx container and config",
			},
		],
		saved?.serving.mode === "container"
			? saved.serving.nginx
				? "nginx"
				: "container"
			: "artifact",
	)
	let serving: DeploymentConfig["serving"]
	const prior =
		saved?.serving.mode === "container" ? saved.serving : undefined
	if (servingChoice === "artifact") {
		serving = {
			mode: "artifact",
			destination:
				saved?.serving.mode === "artifact"
					? saved.serving.destination
					: "The pipeline publishes the built files. Set up delivery and hosting separately.",
		}
	} else {
		const nginx = servingChoice === "nginx"
		const image = await ui.text(
			"servingImage",
			"Base image for serving the app, including tag or digest",
			prior?.image ?? "",
			value =>
				/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]+$/.test(value) &&
				value.includes(":")
					? undefined
					: "Enter an image with a tag or digest.",
		)
		const assetPath = await ui.text(
			"assetPath",
			"Folder for built files inside the container",
			prior?.assetPath ?? (nginx ? "/usr/share/nginx/html" : ""),
			value =>
				/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(value) &&
				!value.split("/").includes("..")
					? undefined
					: "Enter a container folder starting with /, without spaces or ..",
		)
		const rawCommand = await ui.text(
			"servingCommand",
			"Container start command as JSON, [] uses the image default",
			JSON.stringify(prior?.command ?? []),
			value => {
				try {
					const parsed = JSON.parse(value)
					return Array.isArray(parsed) &&
						parsed.every(
							item =>
								typeof item === "string" && !cleanLine(item),
						)
						? undefined
						: "Use a JSON array of single-line strings."
				} catch {
					return 'Use valid JSON, such as ["serve", "dist"].'
				}
			},
		)
		const containerPort = Number(
			await ui.text(
				"containerPort",
				"Port the app listens on inside the container",
				String(prior?.containerPort ?? (nginx ? 80 : "")),
				port,
			),
		)
		const hostPortText = await ui.text(
			"hostPort",
			"Host port, leave blank to skip port publishing",
			prior?.hostPort?.toString() ?? "",
			value => (value ? port(value) : undefined),
		)
		const network = await ui.text(
			"network",
			"Shared Docker network, leave blank to create one for this app",
			prior?.network ?? "",
			value => (value ? identifier(value) : undefined),
		)
		serving = {
			mode: "container",
			image,
			assetPath,
			command: JSON.parse(rawCommand),
			containerPort,
			...(hostPortText ? { hostPort: Number(hostPortText) } : {}),
			...(network ? { network } : {}),
		}
		if (nginx) {
			serving.nginx = {
				spaFallback: await ui.confirm(
					"spa",
					"Serve index.html for app routes such as /dashboard?",
					prior?.nginx?.spaFallback ?? true,
				),
			}
			if (
				await ui.confirm(
					"proxy",
					"Forward requests from Nginx to another service?",
					!!prior?.nginx?.proxyPath,
				)
			) {
				serving.nginx.proxyPath = await ui.text(
					"proxyPath",
					"URL path to forward",
					prior?.nginx?.proxyPath ?? "/api/",
					value =>
						/^\/[A-Za-z0-9_/-]+$/.test(value)
							? undefined
							: "Enter a URL path such as /api/.",
				)
				serving.nginx.proxyTarget = await ui.text(
					"proxyTarget",
					"Service URL to forward requests to",
					prior?.nginx?.proxyTarget ?? "",
					value =>
						/^https?:\/\/[A-Za-z0-9._:-]+\/?$/.test(value)
							? undefined
							: "Enter the service URL, such as http://api:3000.",
				)
			}
		}
	}
	let tailscaleSecureFile: string | undefined
	if (serving.mode === "container") {
		for (const environment of environments) {
			const previous = saved?.environments.find(
				item => item.branch === environment.branch,
			)
			environment.hostConnection = await ui.text(
				`host:${environment.branch}`,
				`Docker host service connection in Azure DevOps for ${environment.branch}`,
				previous?.hostConnection ?? `docker-host-${environment.id}`,
				reference,
			)
		}
		if (
			await ui.confirm(
				"tailscale",
				"Does the pipeline need Tailscale to reach the Docker host?",
				!!saved?.connectivity.tailscaleSecureFile,
			)
		) {
			tailscaleSecureFile = await ui.text(
				"tailscaleFile",
				"Azure Secure File name containing the Tailscale auth key",
				saved?.connectivity.tailscaleSecureFile ??
					"tailscale-vpn-authkey.txt",
				reference,
			)
		}
	}
	ui.info(
		"Enter variable names only. Their values will be visible in the browser, so do not include passwords or private keys.",
	)
	const frontendVariables = list(
		await ui.text(
			"variables",
			"Browser environment variable names, separated by commas",
			(saved?.frontendVariables ?? facts.frontendVariables).join(", "),
			value =>
				list(value).every(key => /^VITE_[A-Z0-9_]+$/.test(key))
					? undefined
					: "Use VITE_ variable names containing uppercase letters, numbers and underscores.",
			"VITE_API_URL, VITE_APP_NAME",
		),
	)
	for (const environment of environments) {
		const previous = saved?.environments.find(
			item => item.branch === environment.branch,
		)
		environment.id = await ui.text(
			`environment:${environment.branch}`,
			`Environment name for ${environment.branch}`,
			previous?.id ?? environment.id,
			value =>
				identifier(value) ||
				(environments.some(
					other => other !== environment && other.id === value,
				)
					? "Each branch needs a different environment name."
					: undefined),
		)
		environment.publicFile = `.env.build.${environment.id}`
		if (
			await ui.confirm(
				`override:${environment.branch}`,
				`Override build variables with an Azure Secure File for ${environment.branch}?`,
				!!previous?.secureFile,
			)
		) {
			environment.secureFile = await ui.text(
				`secureFile:${environment.branch}`,
				`Azure Secure File name for ${environment.branch}, required on each build`,
				previous?.secureFile ?? `${id}-${environment.id}.env`,
				reference,
			)
		}
	}
	return validateAnswers(
		{
			schemaVersion: 1,
			templateVersion: 1,
			application: {
				directory:
					relative(root, facts.directory).split(sep).join("/") || ".",
				name,
				id,
			},
			build: {
				recipe: "vite-static",
				packageManager: manager,
				packageManagerVersion: managerVersion,
				lockfile,
				...(facts.nodeConstraint
					? { nodeConstraint: facts.nodeConstraint }
					: {}),
				nodeVersion,
				command,
				outputDirectory,
				architecture,
			},
			pipeline: { provider: "azure-devops", registryConnection },
			registry: { hostname, repository },
			environments,
			serving,
			frontendVariables,
			connectivity: tailscaleSecureFile ? { tailscaleSecureFile } : {},
		},
		ui,
	)
}

async function validateAnswers(
	draft: DeploymentConfig,
	ui: UserInterface,
): Promise<DeploymentConfig> {
	for (;;) {
		try {
			return validateConfig(draft)
		} catch (error) {
			if (!(error instanceof ConfigValidationError)) throw error
			const parts = error.field.replaceAll(/\[(\d+)\]/g, ".$1").split(".")
			let parent: unknown = draft
			for (const part of parts.slice(0, -1)) {
				if (!parent || typeof parent !== "object") throw error
				parent = (parent as Record<string, unknown>)[part]
			}
			if (!parent || typeof parent !== "object") throw error
			const owner = parent as Record<string, unknown>
			const key = parts.at(-1)!
			const current = owner?.[key]
			if (typeof current !== "string" && typeof current !== "number")
				throw error
			ui.warn(error.message)
			const label = error.field
				.replaceAll(
					/\[(\d+)\]/g,
					(_match, index) => ` ${Number(index) + 1}`,
				)
				.replaceAll(".", " ")
				.replaceAll(/([a-z])([A-Z])/g, "$1 $2")
			const value = await ui.text(
				`correct:${error.field}`,
				`Correct ${label}`,
				String(current),
				input => {
					const previous = owner[key]
					owner[key] =
						typeof current === "number" ? Number(input) : input
					try {
						validateConfig(draft)
						return undefined
					} catch (next) {
						return next instanceof ConfigValidationError &&
							next.field === error.field
							? next.message
							: undefined
					} finally {
						owner[key] = previous
					}
				},
			)
			owner[key] = typeof current === "number" ? Number(value) : value
			if (/^environments\[\d+\]\.id$/.test(error.field))
				owner.publicFile = `.env.build.${value}`
		}
	}
}
