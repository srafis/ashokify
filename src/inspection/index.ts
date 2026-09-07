import { lstat, realpath, readFile, readdir, stat } from "node:fs/promises"
import { relative, resolve, sep, posix } from "node:path"

import { resolveNodeVersion } from "../config/index.ts"
import type { PackageManager, ProjectFacts } from "../config/types.ts"

/**
 * The framework checks below are a narrow, static adaptation of shadcn/ui's
 * get-project-info.ts detector at revision 078dfe66072c4ca780bbc99d4ad4b13b1f44fe7e.
 * See THIRD_PARTY_NOTICES.md for the MIT notice and source link.
 */

export class ProjectInspectionError extends Error {
	readonly field: string

	constructor(field: string, message: string) {
		super(`${field}: ${message}`)
		this.name = "ProjectInspectionError"
		this.field = field
	}
}

type JsonObject = Record<string, unknown>

const PACKAGE_MANAGERS: PackageManager[] = ["npm", "pnpm", "yarn", "bun"]
const SOURCE_EXTENSIONS = new Set([
	".js",
	".jsx",
	".mjs",
	".cjs",
	".ts",
	".tsx",
	".mts",
	".cts",
	".vue",
	".svelte",
	".astro",
	".html",
	".css",
])
const IGNORED_DIRECTORIES = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"dist",
	"build",
	".next",
	".nuxt",
	"coverage",
	".turbo",
	".cache",
])
const SSR_DEPENDENCIES = new Set([
	"next",
	"nuxt",
	"@remix-run/react",
	"@remix-run/node",
	"@remix-run/serve",
	"@sveltejs/kit",
	"@tanstack/start",
	"express",
	"fastify",
	"hono",
	"vite-plugin-ssr",
	"vite-plugin-rsc",
	"@vitejs/plugin-rsc",
])

interface LockEvidence {
	manager: PackageManager
	file: string
}

interface Manifest {
	name?: string
	packageManager?: string
	engines?: JsonObject
	scripts?: JsonObject
	dependencies?: JsonObject
	devDependencies?: JsonObject
	peerDependencies?: JsonObject
	optionalDependencies?: JsonObject
	workspaces?: unknown
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSupportedPackageManager(value: string): value is PackageManager {
	return PACKAGE_MANAGERS.includes(value as PackageManager)
}

function packageManagerFromMetadata(value: unknown): {
	manager?: PackageManager
	version?: string
	raw?: string
} {
	if (typeof value !== "string" || !value.trim()) return {}
	const match = /^([a-z]+)@([^\s]+)$/iu.exec(value.trim())
	const managerName = match?.[1]?.toLowerCase()
	if (!managerName || !isSupportedPackageManager(managerName))
		return { raw: value }
	return { manager: managerName, version: match?.[2] }
}

function packageManagerForLockfile(name: string): PackageManager | undefined {
	if (name === "package-lock.json" || name === "npm-shrinkwrap.json")
		return "npm"
	if (name === "pnpm-lock.yaml") return "pnpm"
	if (name === "yarn.lock") return "yarn"
	if (name === "bun.lockb" || name === "bun.lock") return "bun"
	return undefined
}

function displayRelativePath(root: string, value: string): string {
	const output = relative(root, value).split(sep).join("/")
	return output || "."
}

function assertPathInputs(
	applicationDirAbsolute: string,
	repositoryRoot: string,
): void {
	for (const [field, value] of [
		["applicationDirAbsolute", applicationDirAbsolute],
		["repositoryRoot", repositoryRoot],
	] as const) {
		if (
			typeof value !== "string" ||
			!value ||
			!posix.isAbsolute(value) ||
			/[\u0000\r\n\u2028\u2029]/u.test(value)
		) {
			throw new ProjectInspectionError(
				field,
				"must be an absolute path without control characters",
			)
		}
	}
}

async function resolveInsideRepository(
	applicationDirAbsolute: string,
	repositoryRoot: string,
): Promise<{ app: string; root: string; directory: string }> {
	assertPathInputs(applicationDirAbsolute, repositoryRoot)
	let app: string
	let root: string
	try {
		;[app, root] = await Promise.all([
			realpath(applicationDirAbsolute),
			realpath(repositoryRoot),
		])
	} catch {
		throw new ProjectInspectionError(
			"applicationDirAbsolute",
			"application directory or repository root does not exist",
		)
	}
	const pathFromRoot = relative(root, app)
	if (
		pathFromRoot === ".." ||
		pathFromRoot.startsWith(`..${sep}`) ||
		pathFromRoot.startsWith(sep) ||
		posix.isAbsolute(pathFromRoot)
	) {
		throw new ProjectInspectionError(
			"applicationDirAbsolute",
			"must be inside repositoryRoot",
		)
	}
	const appStat = await stat(app).catch(() => undefined)
	if (!appStat?.isDirectory())
		throw new ProjectInspectionError(
			"applicationDirAbsolute",
			"must point to a directory",
		)
	return { app, root, directory: displayRelativePath(root, app) }
}

async function readJsonFile(path: string, field: string): Promise<JsonObject> {
	let text: string
	try {
		const fileStat = await lstat(path)
		if (!fileStat.isFile() || fileStat.isSymbolicLink())
			throw new Error("not a regular file")
		text = await readFile(path, "utf8")
	} catch {
		throw new ProjectInspectionError(field, "could not be read")
	}
	try {
		const parsed: unknown = JSON.parse(text)
		if (!isObject(parsed)) throw new Error("not an object")
		return parsed
	} catch {
		throw new ProjectInspectionError(field, "must contain valid JSON")
	}
}

async function topLevelFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true })
	return entries
		.filter(entry => entry.isFile())
		.map(entry => entry.name)
		.sort()
}

async function findStaticFiles(directory: string): Promise<string[]> {
	const result: string[] = []
	const queue: Array<{ directory: string; depth: number }> = [
		{ directory, depth: 0 },
	]
	while (queue.length) {
		const current = queue.shift()
		if (!current) continue
		let entries
		try {
			entries = await readdir(current.directory, { withFileTypes: true })
		} catch {
			continue
		}
		for (const entry of entries.sort((left, right) =>
			left.name.localeCompare(right.name),
		)) {
			if (entry.isSymbolicLink()) continue
			const fullPath = resolve(current.directory, entry.name)
			if (entry.isDirectory()) {
				if (!IGNORED_DIRECTORIES.has(entry.name) && current.depth < 12)
					queue.push({
						directory: fullPath,
						depth: current.depth + 1,
					})
				continue
			}
			if (!entry.isFile()) continue
			if (
				entry.name.startsWith(".env") ||
				SOURCE_EXTENSIONS.has(extension(entry.name))
			)
				result.push(fullPath)
		}
	}
	return result
}

function extension(name: string): string {
	const dot = name.lastIndexOf(".")
	return dot >= 0 ? name.slice(dot).toLowerCase() : ""
}

function stringsFromObject(value: unknown): string[] {
	return isObject(value) ? Object.keys(value) : []
}

function allDependencyNames(manifest: Manifest): Set<string> {
	const names = new Set<string>()
	for (const group of [
		manifest.dependencies,
		manifest.devDependencies,
		manifest.peerDependencies,
		manifest.optionalDependencies,
	]) {
		for (const name of stringsFromObject(group)) names.add(name)
	}
	return names
}

function hasWorkspaceDependency(manifest: Manifest): string | undefined {
	for (const group of [
		manifest.dependencies,
		manifest.devDependencies,
		manifest.peerDependencies,
		manifest.optionalDependencies,
	]) {
		if (!isObject(group)) continue
		for (const [name, version] of Object.entries(group)) {
			if (
				typeof version === "string" &&
				(version.startsWith("workspace:") ||
					version.startsWith("link:"))
			)
				return name
		}
	}
	return undefined
}

function workspacePatterns(manifest: Manifest): string[] {
	if (Array.isArray(manifest.workspaces)) {
		return manifest.workspaces.filter(
			(value): value is string => typeof value === "string",
		)
	}
	if (
		isObject(manifest.workspaces) &&
		Array.isArray(manifest.workspaces.packages)
	) {
		return manifest.workspaces.packages.filter(
			(value): value is string => typeof value === "string",
		)
	}
	return []
}

async function workspaceCandidates(
	root: string,
	manifest: Manifest,
	rootFiles: string[],
): Promise<string[]> {
	const patterns = workspacePatterns(manifest)
	if (rootFiles.includes("pnpm-workspace.yaml")) {
		try {
			const pnpmWorkspace = await readFile(
				resolve(root, "pnpm-workspace.yaml"),
				"utf8",
			)
			for (const match of pnpmWorkspace.matchAll(
				/^\s*-\s*["']?([^"'\s#]+)["']?\s*$/gmu,
			)) {
				if (match[1]) patterns.push(match[1])
			}
		} catch {
			// The metadata itself is enough to stop an ambiguous root inspection.
		}
	}
	const candidates = new Set<string>()
	const addPackageIfPresent = async (directory: string) => {
		try {
			if ((await stat(resolve(directory, "package.json"))).isFile())
				candidates.add(displayRelativePath(root, directory))
		} catch {
			// A pattern can point to a directory that has not been created yet.
		}
	}
	for (const pattern of patterns) {
		const prefix = pattern.split("*")[0]?.replace(/\/$/u, "") || "."
		const base = resolve(root, prefix)
		await addPackageIfPresent(base)
		try {
			for (const entry of await readdir(base, { withFileTypes: true })) {
				if (entry.isDirectory() && !entry.isSymbolicLink())
					await addPackageIfPresent(resolve(base, entry.name))
			}
		} catch {
			// The candidate list remains useful even when a workspace glob is stale.
		}
	}
	if (!candidates.size) {
		try {
			for (const entry of await readdir(root, { withFileTypes: true })) {
				if (
					!entry.isDirectory() ||
					entry.isSymbolicLink() ||
					IGNORED_DIRECTORIES.has(entry.name)
				)
					continue
				await addPackageIfPresent(resolve(root, entry.name))
			}
		} catch {
			// The caller still receives guidance to choose an application path.
		}
	}
	return [...candidates].filter(candidate => candidate !== ".").sort()
}

function readViteOutput(configText: string): {
	output?: string
	dynamic: boolean
} {
	const match = /\boutDir\s*:\s*["'`]([^"'`\r\n]+)["'`]/u.exec(configText)
	if (match) return { output: match[1], dynamic: false }
	if (/\boutDir\s*:/u.test(configText)) return { dynamic: true }
	return { dynamic: false }
}

function scriptString(manifest: Manifest, name: string): string | undefined {
	if (!isObject(manifest.scripts)) return undefined
	const value = manifest.scripts[name]
	return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function addEvidence(evidence: string[], value: string): void {
	if (!evidence.includes(value)) evidence.push(value)
}

function addWarning(warnings: string[], value: string): void {
	if (!warnings.includes(value)) warnings.push(value)
}

function scanEnvironmentNames(files: string[]): Promise<string[]> {
	return Promise.all(
		files.map(async file => {
			try {
				const fileStat = await stat(file)
				if (!fileStat.isFile() || fileStat.size > 2 * 1024 * 1024)
					return ""
				const content = await readFile(file, "utf8")
				const found = new Set<string>()
				if (
					file.split(sep).some(segment => segment.startsWith(".env"))
				) {
					for (const line of content.split(/\r?\n/u)) {
						const match =
							/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(
								line,
							)
						if (match?.[1] && /^VITE_[A-Z0-9_]+$/u.test(match[1]))
							found.add(match[1])
					}
				}
				if (SOURCE_EXTENSIONS.has(extension(file))) {
					for (const match of content.matchAll(
						/import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/gu,
					))
						if (match[1] && /^VITE_[A-Z0-9_]+$/u.test(match[1]))
							found.add(match[1])
					for (const match of content.matchAll(
						/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/gu,
					))
						if (match[1] && /^VITE_[A-Z0-9_]+$/u.test(match[1]))
							found.add(match[1])
				}
				return [...found].join("\n")
			} catch {
				return ""
			}
		}),
	).then(groups =>
		[
			...new Set(
				groups.flatMap(group => (group ? group.split("\n") : [])),
			),
		].sort(),
	)
}

function validOutputDirectory(value: string): boolean {
	if (
		!value ||
		posix.isAbsolute(value) ||
		value.includes("\\") ||
		!/^[A-Za-z0-9._/-]+$/u.test(value)
	)
		return false
	const parts = value.split("/")
	return !parts.some(part => part === ".." || !part)
}

function detectPackageManager(
	files: string[],
	manifest: Manifest,
	app: string,
	root: string,
	evidence: string[],
	warnings: string[],
): {
	manager?: PackageManager
	version?: string
	lockfile?: string
	candidates: PackageManager[]
	conflicting: boolean
} {
	const metadata = packageManagerFromMetadata(manifest.packageManager)
	if (metadata.raw)
		addWarning(
			warnings,
			`Cannot identify the package manager from "${metadata.raw}" in package.json. Choose the package manager this app uses.`,
		)
	if (metadata.manager)
		addEvidence(
			evidence,
			`package.json declares ${metadata.manager}${metadata.version ? `@${metadata.version}` : ""}`,
		)
	const lockEvidence: LockEvidence[] = files
		.map(file => ({ manager: packageManagerForLockfile(file), file }))
		.filter((item): item is LockEvidence => item.manager !== undefined)
	for (const lock of lockEvidence)
		addEvidence(evidence, `${lock.manager} lockfile ${lock.file}`)
	const lockManagers = [...new Set(lockEvidence.map(item => item.manager))]
	const candidates = PACKAGE_MANAGERS.filter(
		manager =>
			metadata.manager === manager || lockManagers.includes(manager),
	)
	if (lockEvidence.length > 1) {
		addWarning(
			warnings,
			`Found multiple lockfiles: ${lockEvidence.map(item => item.file).join(", ")}. Choose the one this app uses.`,
		)
		return { candidates, conflicting: true }
	}
	if (
		metadata.manager &&
		lockManagers[0] &&
		metadata.manager !== lockManagers[0]
	) {
		addWarning(
			warnings,
			`package.json selects ${metadata.manager}, but ${lockEvidence.find(item => item.manager === lockManagers[0])?.file ?? "the lockfile"} selects ${lockManagers[0]}. Choose the package manager this app uses.`,
		)
		return { candidates, conflicting: false }
	}
	const manager = metadata.manager ?? lockManagers[0]
	if (!manager) return { candidates, conflicting: false }
	const selected = lockEvidence.find(item => item.manager === manager)
	return {
		manager,
		version: metadata.version,
		lockfile: selected
			? displayRelativePath(app, resolve(app, selected.file))
			: undefined,
		candidates,
		conflicting: false,
	}
}

export async function inspectProject(
	applicationDirAbsolute: string,
	repositoryRoot: string,
): Promise<ProjectFacts> {
	const locations = await resolveInsideRepository(
		applicationDirAbsolute,
		repositoryRoot,
	)
	const evidence: string[] = []
	const warnings: string[] = []
	const files = await topLevelFiles(locations.app)
	const packagePath = resolve(locations.app, "package.json")
	const packageJson = (await readJsonFile(
		packagePath,
		"package.json",
	)) as Manifest
	const packageName =
		typeof packageJson.name === "string" && packageJson.name.trim()
			? packageJson.name.trim()
			: undefined
	const name =
		packageName ??
		locations.root.split(sep).filter(Boolean).pop() ??
		locations.app.split(sep).filter(Boolean).pop() ??
		"application"
	if (packageName) addEvidence(evidence, "package.json name")
	else
		addWarning(
			warnings,
			"package.json has no name; the repository name will be used.",
		)

	const configFiles = files.filter(
		file =>
			/^vite\.config\.[cm]?[jt]sx?$/u.test(file) ||
			/^vite\.config\.[cm]?[jt]s$/u.test(file),
	)
	const nextConfig = files.find(file => /^next\.config\./u.test(file))
	const nuxtConfig = files.find(file => /^nuxt\.config\./u.test(file))
	const remixConfig = files.find(file => /^remix\.config\./u.test(file))
	const configTexts = await Promise.all(
		configFiles.map(async file => {
			try {
				return await readFile(resolve(locations.app, file), "utf8")
			} catch {
				return ""
			}
		}),
	)
	const configText = configTexts.join("\n")
	const dependencies = allDependencyNames(packageJson)
	const rawBuildCommand = scriptString(packageJson, "build")
	const hasViteDependency =
		dependencies.has("vite") ||
		dependencies.has("@vitejs/plugin-react") ||
		dependencies.has("@vitejs/plugin-vue")
	const hasViteEvidence =
		configFiles.length > 0 ||
		hasViteDependency ||
		/(?:^|[\s;&])vite\s+build(?:$|[\s;&])/u.test(rawBuildCommand ?? "")
	if (configFiles.length)
		addEvidence(evidence, `Vite config ${configFiles[0]}`)
	if (hasViteDependency) addEvidence(evidence, "Vite dependency")

	let outputDirectory = "dist"
	let dynamicOutput = false
	if (configText) {
		const output = readViteOutput(configText)
		dynamicOutput = output.dynamic
		if (output.output) {
			const normalizedOutput = output.output.replace(/^\.\//u, "")
			if (!validOutputDirectory(normalizedOutput))
				throw new ProjectInspectionError(
					"build.outputDirectory",
					"Vite outDir must be a safe relative path",
				)
			outputDirectory = normalizedOutput
			addEvidence(evidence, `Vite build.outDir ${outputDirectory}`)
		} else if (dynamicOutput) {
			addWarning(
				warnings,
				"Could not read the build output folder from the Vite config. Confirm it below.",
			)
		}
	}

	const nodeConstraint =
		typeof packageJson.engines?.node === "string"
			? packageJson.engines.node.trim()
			: undefined
	let nodeVersion: string | undefined
	if (nodeConstraint) {
		try {
			nodeVersion = resolveNodeVersion(nodeConstraint)
			addEvidence(evidence, `Node engine ${nodeConstraint}`)
		} catch {
			addWarning(
				warnings,
				`Could not choose a supported Node.js version for "${nodeConstraint}" in package.json. Check the version requirement.`,
			)
		}
	} else {
		nodeVersion = resolveNodeVersion()
		addEvidence(
			evidence,
			"Node 22 fallback because package.json has no engines.node",
		)
	}

	const packageManagerInfo = detectPackageManager(
		files,
		packageJson,
		locations.app,
		locations.root,
		evidence,
		warnings,
	)
	// The script body is used only for static evidence. The fact exposed to the
	// workflow is an executable package-manager command that works in a clean
	// Docker build environment.
	const buildCommand =
		rawBuildCommand && packageManagerInfo.manager
			? `${packageManagerInfo.manager} run build`
			: undefined
	const rootFiles =
		locations.app === locations.root
			? files
			: await topLevelFiles(locations.root)
	if (locations.app !== locations.root && !packageManagerInfo.lockfile) {
		const rootLocks = rootFiles.filter(file =>
			packageManagerForLockfile(file),
		)
		if (rootLocks.length)
			addWarning(
				warnings,
				`A repository-root lockfile (${rootLocks.join(", ")}) is outside the selected application directory; shared-workspace builds need manual handling.`,
			)
	}
	const rootWorkspaceMetadata =
		locations.app === locations.root &&
		(packageJson.workspaces !== undefined ||
			rootFiles.includes("pnpm-workspace.yaml"))
	if (rootWorkspaceMetadata) {
		const candidates = await workspaceCandidates(
			locations.root,
			packageJson,
			rootFiles,
		)
		const detail = candidates.length
			? ` Candidates: ${candidates.join(", ")}.`
			: " Choose the application directory explicitly."
		throw new ProjectInspectionError(
			"applicationDirAbsolute",
			`repository root is an ambiguous monorepo. Rerun with --cwd pointing to one application directory.${detail}`,
		)
	}
	const workspaceDependency = hasWorkspaceDependency(packageJson)
	if (workspaceDependency)
		addWarning(
			warnings,
			`Shared workspace dependency "${workspaceDependency}" is not supported by the MVP.`,
		)
	const hasWorkspaceMetadata = packageJson.workspaces !== undefined
	if (hasWorkspaceMetadata) {
		addEvidence(evidence, "workspace metadata")
		if (!workspaceDependency)
			addWarning(
				warnings,
				"Workspace metadata requires one application directory and a self-contained build.",
			)
	}

	let staticStatus: ProjectFacts["staticStatus"] = "ambiguous"
	const serverIndicators: string[] = []
	if (nextConfig) serverIndicators.push(nextConfig)
	if (nuxtConfig) serverIndicators.push(nuxtConfig)
	if (remixConfig) serverIndicators.push(remixConfig)
	for (const dependency of SSR_DEPENDENCIES)
		if (dependencies.has(dependency)) serverIndicators.push(dependency)
	if (
		/\bvite\s+build\b[^\n]*\b--ssr\b/u.test(rawBuildCommand ?? "") ||
		/\bssr\s*:/u.test(configText)
	)
		serverIndicators.push("SSR build/configuration marker")
	if (serverIndicators.length) {
		staticStatus = "unsupported"
		addWarning(
			warnings,
			`Found an unsupported framework or server build: ${serverIndicators.join(", ")}. Only Vite static sites are supported today.`,
		)
	} else if (!hasViteEvidence) {
		addWarning(
			warnings,
			"Could not detect Vite. Confirm the framework and whether the build produces static files.",
		)
	} else if (!rawBuildCommand) {
		addWarning(
			warnings,
			"package.json has no build script. Enter the command that builds the app.",
		)
	} else if (dynamicOutput) {
		staticStatus = "ambiguous"
	} else if (
		!/(?:^|[\s;&])vite\s+build(?:$|[\s;&])/u.test(rawBuildCommand ?? "")
	) {
		addWarning(
			warnings,
			"The build uses a custom script. Confirm whether it produces static files.",
		)
	} else {
		staticStatus = "supported"
	}
	if (hasWorkspaceDependency(packageJson)) staticStatus = "unsupported"
	if (hasWorkspaceMetadata && staticStatus === "supported")
		staticStatus = "ambiguous"
	if (packageManagerInfo.conflicting)
		staticStatus =
			staticStatus === "unsupported" ? staticStatus : "ambiguous"
	if (packageManagerInfo.candidates.length > 1)
		staticStatus =
			staticStatus === "unsupported" ? staticStatus : "ambiguous"
	if (!buildCommand)
		staticStatus =
			staticStatus === "unsupported" ? staticStatus : "ambiguous"

	let staticBuildIssue: string | undefined
	if (serverIndicators.length)
		staticBuildIssue = `This app uses an unsupported framework or server build: ${serverIndicators.join(", ")}. Ashokify currently supports Vite static sites.`
	else if (!hasViteEvidence)
		staticBuildIssue =
			"Could not detect Vite in this folder. Run ashokify --cwd with the path to a Vite app."
	else if (!rawBuildCommand)
		staticBuildIssue =
			'package.json has no build script. Add a "build" script that runs vite build, commit the change, then run setup again.'
	else if (!/(?:^|[\s;&])vite\s+build(?:$|[\s;&])/u.test(rawBuildCommand))
		staticBuildIssue =
			"The build script does not call vite build directly, so Ashokify cannot determine its output. Use a build script that calls vite build, commit the change, then run setup again."
	if (workspaceDependency)
		staticBuildIssue = `This app depends on another workspace: ${workspaceDependency}. Shared-workspace builds are not supported yet.`
	else if (hasWorkspaceMetadata)
		staticBuildIssue =
			"This folder defines a workspace. Run ashokify --cwd with the path to one standalone Vite app."

	const staticFiles = await findStaticFiles(locations.app)
	const frontendVariables = await scanEnvironmentNames(staticFiles)
	for (const variable of frontendVariables)
		addEvidence(evidence, `environment variable name ${variable}`)
	return {
		// ProjectFacts is consumed by the prompt workflow for filesystem reads.
		// Keep it absolute; DeploymentConfig converts it to a repository-relative path.
		directory: locations.app,
		name,
		...(packageManagerInfo.manager
			? { packageManager: packageManagerInfo.manager }
			: {}),
		...(packageManagerInfo.version
			? { packageManagerVersion: packageManagerInfo.version }
			: {}),
		...(packageManagerInfo.lockfile
			? { lockfile: packageManagerInfo.lockfile }
			: {}),
		...(packageManagerInfo.candidates.length
			? { packageManagerCandidates: packageManagerInfo.candidates }
			: { packageManagerCandidates: [] }),
		...(nodeConstraint ? { nodeConstraint } : {}),
		...(nodeVersion ? { nodeVersion } : {}),
		...(buildCommand ? { buildCommand } : {}),
		outputDirectory,
		staticStatus,
		...(staticBuildIssue ? { staticBuildIssue } : {}),
		evidence: evidence.sort(),
		warnings: warnings.sort(),
		frontendVariables,
	}
}
