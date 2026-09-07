import { posix, win32 } from "node:path"
import * as semver from "semver"

import type { DeploymentConfig } from "./types.ts"

export class ConfigValidationError extends Error {
	readonly field: string

	constructor(field: string, message: string) {
		super(`${field}: ${message}`)
		this.name = "ConfigValidationError"
		this.field = field
	}
}

type RecordValue = Record<string, unknown>

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"])
const VERSION_PATTERN =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function ownKeys(value: RecordValue): string[] {
	return Object.keys(value)
}

function exactKeys(
	value: RecordValue,
	allowed: readonly string[],
	field: string,
): void {
	const allowedSet = new Set(allowed)
	for (const key of ownKeys(value)) {
		if (!allowedSet.has(key)) {
			throw new ConfigValidationError(`${field}.${key}`, "unknown field")
		}
	}
}

function requiredRecord(value: unknown, field: string): RecordValue {
	if (!isRecord(value)) {
		throw new ConfigValidationError(field, "must be an object")
	}
	return value
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new ConfigValidationError(field, "must be a non-empty string")
	}
	if (/[\u0000\r\n\u2028\u2029]/u.test(value)) {
		throw new ConfigValidationError(
			field,
			"must not contain control or line-separator characters",
		)
	}
	if (
		value.includes("${") ||
		value.includes("$(") ||
		value.includes("`") ||
		value.includes("\\")
	) {
		throw new ConfigValidationError(
			field,
			"must not contain shell interpolation or backslash escapes",
		)
	}
	return value
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined
	return requiredString(value, field)
}

function relativePath(value: unknown, field: string, allowDot = false): string {
	const result = requiredString(value, field)
	if (
		win32.isAbsolute(result) ||
		posix.isAbsolute(result) ||
		result.includes("\\")
	) {
		throw new ConfigValidationError(
			field,
			"must be a repository-relative POSIX path",
		)
	}
	if (!/^[A-Za-z0-9._/-]+$/u.test(result)) {
		throw new ConfigValidationError(
			field,
			"must contain only safe POSIX path characters",
		)
	}
	if (result === "." && !allowDot)
		throw new ConfigValidationError(field, "must identify a child path")
	const parts = result.split("/")
	if (
		parts.some(part => part === "..") ||
		(result !== "." && parts.some(part => part === ".")) ||
		parts.some(part => part.length === 0 && parts.length > 1)
	) {
		throw new ConfigValidationError(
			field,
			"must not traverse outside the application directory",
		)
	}
	return result
}

function containerPath(value: unknown, field: string): string {
	const result = requiredString(value, field)
	if (
		result.includes("\\") ||
		!/^\/[A-Za-z0-9._/-]+$/u.test(result) ||
		result.split("/").some(part => part === "..")
	) {
		throw new ConfigValidationError(
			field,
			"must be a safe POSIX container path",
		)
	}
	return result
}

function safeIdentifier(value: unknown, field: string): string {
	const result = requiredString(value, field)
	if (result.length > 128 || !/^[a-z0-9][a-z0-9_-]*$/u.test(result)) {
		throw new ConfigValidationError(
			field,
			"must be a lowercase deployment identifier",
		)
	}
	return result
}

function safeConnection(value: unknown, field: string): string {
	const result = requiredString(value, field)
	if (/[;&|<>()[\]{}$`]/u.test(result)) {
		throw new ConfigValidationError(
			field,
			"contains characters that cannot be used in a resource reference",
		)
	}
	return result
}

function safeCommand(value: unknown, field: string): string {
	const result = requiredString(value, field)
	if (!/^[A-Za-z0-9_./:@%+=,-]+(?: [A-Za-z0-9_./:@%+=,-]+)*$/u.test(result)) {
		throw new ConfigValidationError(field, "contains unsafe shell syntax")
	}
	return result
}

function concreteVersion(value: unknown, field: string): string {
	const result = requiredString(value, field)
	if (!VERSION_PATTERN.test(result)) {
		throw new ConfigValidationError(
			field,
			"must be a concrete numeric version",
		)
	}
	return result
}

const NODE_RELEASES = [
	{ version: "22.23.2", major: 22 },
	{ version: "24.20.0", major: 24 },
] as const

function parseNodeRange(constraint: string): semver.Range {
	const field = "build.nodeConstraint"
	const value = requiredString(constraint, field).trim()
	if (value.length > 200)
		throw new ConfigValidationError(field, "is too long")
	try {
		const range = new semver.Range(value, { includePrerelease: true })
		if (!range.set.length) throw new Error("empty range")
		return range
	} catch {
		throw new ConfigValidationError(
			field,
			`invalid Node version range "${constraint}"`,
		)
	}
}

export function resolveNodeVersion(constraint?: string): string {
	if (constraint === undefined || constraint.trim() === "") return "22.23.2"
	const range = parseNodeRange(constraint)
	for (const release of NODE_RELEASES) {
		if (
			semver.satisfies(release.version, range, {
				includePrerelease: true,
			})
		)
			return release.version
	}
	throw new ConfigValidationError(
		"build.nodeConstraint",
		"does not allow the supported Node 22 or 24 releases",
	)
}

function validateNodeVersion(
	value: string,
	constraint: string | undefined,
): void {
	if (!semver.valid(value))
		throw new ConfigValidationError(
			"build.nodeVersion",
			"must be a full concrete semver version",
		)
	const parsed = semver.parse(value)
	if (
		!parsed ||
		!NODE_RELEASES.some(release => release.major === parsed.major)
	)
		throw new ConfigValidationError(
			"build.nodeVersion",
			"must select a supported Node 22 or 24 release",
		)
	if (
		constraint &&
		!semver.satisfies(value, parseNodeRange(constraint), {
			includePrerelease: true,
		})
	)
		throw new ConfigValidationError(
			"build.nodeVersion",
			"does not satisfy build.nodeConstraint",
		)
}

function validateBranch(value: unknown, field: string): string {
	const raw = requiredString(value, field)
	if (raw.startsWith("refs/") && !raw.startsWith("refs/heads/"))
		throw new ConfigValidationError(
			field,
			"must be a branch, not a tag or another Git ref",
		)
	const branch = raw.startsWith("refs/heads/")
		? raw.slice("refs/heads/".length)
		: raw
	if (
		branch.length > 255 ||
		branch.startsWith("/") ||
		branch.endsWith("/") ||
		branch.includes("..") ||
		branch.includes("//") ||
		branch.includes("@{") ||
		branch.endsWith(".") ||
		branch.split("/").some(part => part.endsWith(".lock")) ||
		!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(branch)
	) {
		throw new ConfigValidationError(
			field,
			"must be a valid Git branch name",
		)
	}
	return branch
}

export function normalizeIdentifier(name: string): string {
	const ascii = name.normalize("NFKD").replace(/[^\x00-\x7F]/gu, "")
	const normalized = ascii
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
	return normalized.slice(0, 128).replace(/-+$/u, "")
}

export function mapBranches(
	branches: string[],
): DeploymentConfig["environments"] {
	if (!Array.isArray(branches))
		throw new ConfigValidationError("environments", "must be an array")
	const unique: string[] = []
	const seen = new Set<string>()
	for (const [index, value] of branches.entries()) {
		if (typeof value !== "string")
			throw new ConfigValidationError(
				`environments[${index}].branch`,
				"must be a string",
			)
		if (!value.trim()) continue
		const branch = validateBranch(
			value.trim(),
			`environments[${index}].branch`,
		)
		if (!seen.has(branch)) {
			seen.add(branch)
			unique.push(branch)
		}
	}
	if (unique.length === 0)
		throw new ConfigValidationError(
			"environments",
			"at least one branch is required",
		)
	const ids = new Map<string, string>()
	return unique.map(branch => {
		const id = normalizeIdentifier(branch)
		const previous = ids.get(id)
		if (previous)
			throw new ConfigValidationError(
				"environments",
				`branches "${previous}" and "${branch}" normalize to the same id "${id}"`,
			)
		ids.set(id, branch)
		return { branch, id, publicFile: `.env.build.${id}` }
	})
}

function validateHostname(value: unknown, field: string): string {
	const hostname = requiredString(value, field)
	const hostPort = /^(.*?)(?::(\d+))?$/u.exec(hostname)
	const host = hostPort?.[1] ?? ""
	const port = hostPort?.[2]
	if (
		hostname.length > 253 ||
		hostname.includes("/") ||
		(port !== undefined && (Number(port) < 1 || Number(port) > 65535)) ||
		!/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/u.test(
			host,
		)
	) {
		throw new ConfigValidationError(
			field,
			"must be a hostname without a scheme or path",
		)
	}
	return hostname.toLowerCase()
}

function validateImage(value: unknown, field: string): string {
	const image = requiredString(value, field)
	if (
		image.length > 512 ||
		!/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*)(?::\d+)?(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*(?::[a-zA-Z0-9._-]+|@sha256:[a-fA-F0-9]{64})?$/u.test(
			image,
		)
	) {
		throw new ConfigValidationError(
			field,
			"must be a safe container image reference",
		)
	}
	return image
}

function validatePort(value: unknown, field: string): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > 65535
	) {
		throw new ConfigValidationError(
			field,
			"must be an integer between 1 and 65535",
		)
	}
	return value
}

function validateEnvironment(
	value: unknown,
	index: number,
): DeploymentConfig["environments"][number] {
	const field = `environments[${index}]`
	const environment = requiredRecord(value, field)
	exactKeys(
		environment,
		["branch", "id", "publicFile", "secureFile", "hostConnection"],
		field,
	)
	const branch = validateBranch(environment.branch, `${field}.branch`)
	const id = safeIdentifier(environment.id, `${field}.id`)
	const publicFile = relativePath(
		environment.publicFile,
		`${field}.publicFile`,
	)
	const secureFile = optionalString(
		environment.secureFile,
		`${field}.secureFile`,
	)
	const hostConnection = optionalString(
		environment.hostConnection,
		`${field}.hostConnection`,
	)
	if (
		secureFile?.includes("..") ||
		(hostConnection && /[;&|<>()[\]{}$`]/u.test(hostConnection))
	) {
		throw new ConfigValidationError(
			field,
			"contains an unsafe resource reference",
		)
	}
	return {
		branch,
		id,
		publicFile,
		...(secureFile ? { secureFile } : {}),
		...(hostConnection ? { hostConnection } : {}),
	}
}

export function validateConfig(value: unknown): DeploymentConfig {
	const root = requiredRecord(value, "config")
	exactKeys(
		root,
		[
			"schemaVersion",
			"templateVersion",
			"application",
			"build",
			"pipeline",
			"registry",
			"environments",
			"serving",
			"frontendVariables",
			"connectivity",
		],
		"config",
	)
	if (root.schemaVersion !== 1)
		throw new ConfigValidationError("schemaVersion", "must be 1")
	if (root.templateVersion !== 1)
		throw new ConfigValidationError("templateVersion", "must be 1")

	const application = requiredRecord(root.application, "application")
	exactKeys(application, ["directory", "name", "id"], "application")
	const applicationValue = {
		directory: relativePath(
			application.directory,
			"application.directory",
			true,
		),
		name: requiredString(application.name, "application.name"),
		id: safeIdentifier(application.id, "application.id"),
	}

	const build = requiredRecord(root.build, "build")
	exactKeys(
		build,
		[
			"recipe",
			"packageManager",
			"packageManagerVersion",
			"lockfile",
			"nodeConstraint",
			"nodeVersion",
			"command",
			"outputDirectory",
			"architecture",
		],
		"build",
	)
	if (build.recipe !== "vite-static")
		throw new ConfigValidationError("build.recipe", "must be vite-static")
	if (
		typeof build.packageManager !== "string" ||
		!PACKAGE_MANAGERS.has(build.packageManager)
	)
		throw new ConfigValidationError(
			"build.packageManager",
			"must be npm, pnpm, yarn or bun",
		)
	const packageManagerVersion = concreteVersion(
		build.packageManagerVersion,
		"build.packageManagerVersion",
	)
	const nodeConstraint = optionalString(
		build.nodeConstraint,
		"build.nodeConstraint",
	)
	if (nodeConstraint !== undefined) parseNodeRange(nodeConstraint)
	const nodeVersion = concreteVersion(build.nodeVersion, "build.nodeVersion")
	validateNodeVersion(nodeVersion, nodeConstraint)
	const command = safeCommand(build.command, "build.command")
	const outputDirectory = relativePath(
		build.outputDirectory,
		"build.outputDirectory",
	)
	if (
		build.architecture !== "linux/amd64" &&
		build.architecture !== "linux/arm64"
	)
		throw new ConfigValidationError(
			"build.architecture",
			"must be linux/amd64 or linux/arm64",
		)
	const lockfile = relativePath(build.lockfile, "build.lockfile")
	const supportedLockfiles: Record<
		DeploymentConfig["build"]["packageManager"],
		string[]
	> = {
		npm: ["package-lock.json", "npm-shrinkwrap.json"],
		pnpm: ["pnpm-lock.yaml"],
		yarn: ["yarn.lock"],
		bun: ["bun.lock", "bun.lockb"],
	}
	if (
		!supportedLockfiles[
			build.packageManager as DeploymentConfig["build"]["packageManager"]
		].includes(lockfile)
	) {
		throw new ConfigValidationError(
			"build.lockfile",
			`does not match package manager ${build.packageManager}`,
		)
	}
	const buildValue = {
		recipe: "vite-static" as const,
		packageManager:
			build.packageManager as DeploymentConfig["build"]["packageManager"],
		packageManagerVersion,
		lockfile,
		...(nodeConstraint ? { nodeConstraint } : {}),
		nodeVersion,
		command,
		outputDirectory,
		architecture:
			build.architecture as DeploymentConfig["build"]["architecture"],
	}

	const pipeline = requiredRecord(root.pipeline, "pipeline")
	exactKeys(pipeline, ["provider", "registryConnection"], "pipeline")
	if (pipeline.provider !== "azure-devops")
		throw new ConfigValidationError(
			"pipeline.provider",
			"must be azure-devops",
		)
	const pipelineValue = {
		provider: "azure-devops" as const,
		registryConnection: safeConnection(
			pipeline.registryConnection,
			"pipeline.registryConnection",
		),
	}

	const registry = requiredRecord(root.registry, "registry")
	exactKeys(registry, ["hostname", "repository"], "registry")
	const registryValue = {
		hostname: validateHostname(registry.hostname, "registry.hostname"),
		repository: safeConnection(registry.repository, "registry.repository"),
	}
	if (
		!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u.test(registryValue.repository) ||
		registryValue.repository.includes("..")
	)
		throw new ConfigValidationError(
			"registry.repository",
			"must be a safe image repository name",
		)

	if (!Array.isArray(root.environments) || root.environments.length === 0)
		throw new ConfigValidationError(
			"environments",
			"must contain at least one environment",
		)
	const environments = root.environments.map((environment, index) =>
		validateEnvironment(environment, index),
	)
	const ids = new Set<string>()
	for (const [index, environment] of environments.entries()) {
		if (ids.has(environment.id))
			throw new ConfigValidationError(
				`environments[${index}].id`,
				"collides with another environment id",
			)
		ids.add(environment.id)
	}

	const serving = requiredRecord(root.serving, "serving")
	let servingValue: DeploymentConfig["serving"]
	if (serving.mode === "artifact") {
		exactKeys(serving, ["mode", "destination"], "serving")
		const destination = requiredString(
			serving.destination,
			"serving.destination",
		)
		if (destination.split("/").some(part => part === ".."))
			throw new ConfigValidationError(
				"serving.destination",
				"must not contain path traversal",
			)
		servingValue = { mode: "artifact", destination }
	} else if (serving.mode === "container") {
		exactKeys(
			serving,
			[
				"mode",
				"image",
				"command",
				"assetPath",
				"containerPort",
				"hostPort",
				"network",
				"nginx",
			],
			"serving",
		)
		if (!Array.isArray(serving.command))
			throw new ConfigValidationError(
				"serving.command",
				"must be an array of command arguments",
			)
		const commands = serving.command.map((item, index) =>
			safeCommand(item, `serving.command[${index}]`),
		)
		const nginx = serving.nginx
		let nginxValue:
			| { spaFallback: boolean; proxyPath?: string; proxyTarget?: string }
			| undefined
		if (nginx !== undefined) {
			const nginxObject = requiredRecord(nginx, "serving.nginx")
			exactKeys(
				nginxObject,
				["spaFallback", "proxyPath", "proxyTarget"],
				"serving.nginx",
			)
			if (typeof nginxObject.spaFallback !== "boolean")
				throw new ConfigValidationError(
					"serving.nginx.spaFallback",
					"must be boolean",
				)
			const proxyPath = optionalString(
				nginxObject.proxyPath,
				"serving.nginx.proxyPath",
			)
			const proxyTarget = optionalString(
				nginxObject.proxyTarget,
				"serving.nginx.proxyTarget",
			)
			if (
				proxyPath &&
				(!/^\/[A-Za-z0-9._/-]*$/u.test(proxyPath) ||
					proxyPath.includes(".."))
			)
				throw new ConfigValidationError(
					"serving.nginx.proxyPath",
					"must be a safe URL path",
				)
			if (proxyTarget && !/^[a-zA-Z0-9._:/-]+$/u.test(proxyTarget))
				throw new ConfigValidationError(
					"serving.nginx.proxyTarget",
					"must be a safe proxy target",
				)
			nginxValue = {
				spaFallback: nginxObject.spaFallback,
				...(proxyPath ? { proxyPath } : {}),
				...(proxyTarget ? { proxyTarget } : {}),
			}
		}
		const hostPort =
			serving.hostPort === undefined
				? undefined
				: validatePort(serving.hostPort, "serving.hostPort")
		servingValue = {
			mode: "container",
			image: validateImage(serving.image, "serving.image"),
			command: commands,
			assetPath: containerPath(serving.assetPath, "serving.assetPath"),
			containerPort: validatePort(
				serving.containerPort,
				"serving.containerPort",
			),
			...(hostPort === undefined ? {} : { hostPort }),
			...(serving.network === undefined
				? {}
				: {
						network: safeConnection(
							serving.network,
							"serving.network",
						),
					}),
			...(nginxValue ? { nginx: nginxValue } : {}),
		}
	} else {
		throw new ConfigValidationError(
			"serving.mode",
			"must be artifact or container",
		)
	}

	const frontendVariablesValue = root.frontendVariables
	if (!Array.isArray(frontendVariablesValue))
		throw new ConfigValidationError("frontendVariables", "must be an array")
	const frontendVariables: string[] = []
	for (const [index, item] of frontendVariablesValue.entries()) {
		const variable = requiredString(item, `frontendVariables[${index}]`)
		if (!/^[A-Z][A-Z0-9_]*$/u.test(variable))
			throw new ConfigValidationError(
				`frontendVariables[${index}]`,
				"must be an uppercase environment variable name",
			)
		if (frontendVariables.includes(variable))
			throw new ConfigValidationError(
				`frontendVariables[${index}]`,
				"duplicates another frontend variable",
			)
		frontendVariables.push(variable)
	}

	const connectivity = requiredRecord(root.connectivity, "connectivity")
	exactKeys(connectivity, ["tailscaleSecureFile"], "connectivity")
	const tailscaleSecureFile = optionalString(
		connectivity.tailscaleSecureFile,
		"connectivity.tailscaleSecureFile",
	)
	if (tailscaleSecureFile?.includes(".."))
		throw new ConfigValidationError(
			"connectivity.tailscaleSecureFile",
			"must not contain path traversal",
		)

	return {
		schemaVersion: 1,
		templateVersion: 1,
		application: applicationValue,
		build: buildValue,
		pipeline: pipelineValue,
		registry: registryValue,
		environments,
		serving: servingValue,
		frontendVariables,
		connectivity: tailscaleSecureFile ? { tailscaleSecureFile } : {},
	}
}
