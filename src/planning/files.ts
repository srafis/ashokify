import { execFile as execFileCallback } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
	mkdir,
	chmod,
	lstat,
	readFile,
	readdir,
	rename,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises"
import { promisify } from "node:util"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const execFile = promisify(execFileCallback)

export type FileOperation = "create" | "update" | "delete" | "unchanged"

export interface FileChange {
	path: string
	relativePath: string
	operation: FileOperation
	before: string | null
	after: string | null
	conflict?: string
}

export interface FilePlan {
	/** Application directory used as the plan root. */
	root?: string
	applicationDir?: string
	changes: FileChange[]
	conflicts: FileChange[]
}

export class FilePlanningError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "FilePlanningError"
	}
}

export class UnsafePathError extends FilePlanningError {
	constructor(
		path: string,
		reason = "path is outside the application directory or is unsafe",
	) {
		super(`Cannot use generated path ${JSON.stringify(path)}: ${reason}`)
		this.name = "UnsafePathError"
	}
}

export class FileConflictError extends FilePlanningError {
	readonly conflicts: FileChange[]

	constructor(conflicts: FileChange[]) {
		super(
			`The reviewed file plan contains ${conflicts.length} unresolved conflict${conflicts.length === 1 ? "" : "s"}`,
		)
		this.name = "FileConflictError"
		this.conflicts = conflicts
	}
}

export class ConcurrentFileChangeError extends FilePlanningError {
	constructor(relativePath: string) {
		super(`File changed after it was reviewed: ${relativePath}`)
		this.name = "ConcurrentFileChangeError"
	}
}

interface ExistingFile {
	content: string
	mode: number
}

interface CreatedDirectory {
	path: string
	dev: number
	ino: number
}

interface RecoveryIssue {
	path: string
	reason: string
}

const IGNORE_FILES = new Set([".gitignore", ".dockerignore"])
// Kept out of the public change shape. It records that the planner showed an
// ignored existing path to the reviewer. Clearing `conflict` then counts as
// explicit adoption, while an ignored file that appears after planning still
// fails the writer's safety check.
const ignoredReviewedChanges = new WeakSet<FileChange>()

function normaliseRelativePath(input: string): string {
	if (typeof input !== "string" || input.length === 0 || input.includes("\0"))
		throw new UnsafePathError(
			String(input),
			"path is empty or contains a NUL byte",
		)
	const slashPath = input.replaceAll("\\", "/")
	if (slashPath.startsWith("/") || /^[A-Za-z]:\//.test(slashPath))
		throw new UnsafePathError(input, "absolute paths are not allowed")
	const parts = slashPath
		.split("/")
		.filter(part => part.length > 0 && part !== ".")
	if (parts.length === 0 || parts.some(part => part === ".."))
		throw new UnsafePathError(input, "path traversal is not allowed")
	if (parts[0] === ".git")
		throw new UnsafePathError(
			input,
			"Git's internal directory cannot be generated",
		)
	return parts.join("/")
}

function targetPath(root: string, relativePath: string): string {
	const absolute = resolve(root, ...relativePath.split("/"))
	const actualRelative = relative(root, absolute)
	if (
		actualRelative === "" ||
		actualRelative === ".." ||
		actualRelative.startsWith(`..${sep}`) ||
		isAbsolute(actualRelative)
	) {
		throw new UnsafePathError(relativePath)
	}
	return absolute
}

async function readExisting(target: string): Promise<ExistingFile | null> {
	try {
		const stat = await lstat(target)
		if (stat.isSymbolicLink())
			throw new UnsafePathError(target, "symbolic links are not followed")
		if (!stat.isFile())
			throw new UnsafePathError(
				target,
				"the target exists but is not a regular file",
			)
		return {
			content: (await readFile(target)).toString("utf8"),
			mode: stat.mode & 0o7777,
		}
	} catch (error) {
		if (error instanceof UnsafePathError) throw error
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
		throw error
	}
}

async function assertSafeParents(
	root: string,
	target: string,
	createMissing = false,
): Promise<CreatedDirectory[]> {
	const created: CreatedDirectory[] = []
	const parent = dirname(target)
	const parentRelative = relative(root, parent)
	let current = root
	for (const part of parentRelative.split(sep).filter(Boolean)) {
		current = join(current, part)
		try {
			const stat = await lstat(current)
			if (stat.isSymbolicLink())
				throw new UnsafePathError(
					relative(root, current),
					"a parent directory is a symbolic link",
				)
			if (!stat.isDirectory())
				throw new UnsafePathError(
					relative(root, current),
					"a parent path is not a directory",
				)
		} catch (error) {
			if (error instanceof UnsafePathError) throw error
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			if (!createMissing) return created
			await mkdir(current)
			const createdStat = await lstat(current)
			created.push({
				path: current,
				dev: createdStat.dev,
				ino: createdStat.ino,
			})
		}
	}
	return created
}

async function checkIgnored(
	applicationDir: string,
	target: string,
): Promise<boolean> {
	try {
		const rootOutput = await execFile(
			"git",
			["rev-parse", "--show-toplevel"],
			{ cwd: applicationDir, encoding: "utf8" },
		)
		const gitRoot = resolve(rootOutput.stdout.trim())
		const gitRelative = relative(gitRoot, target).split(sep).join("/")
		if (gitRelative === "" || gitRelative.startsWith("..")) return false
		await execFile(
			"git",
			["check-ignore", "--no-index", "--quiet", "--", gitRelative],
			{
				cwd: gitRoot,
				encoding: "utf8",
			},
		)
		return true
	} catch {
		return false
	}
}

function splitLines(content: string): { lines: string[]; newline: string } {
	const newline = content.includes("\r\n") ? "\r\n" : "\n"
	const lines = content.replace(/\r\n/g, "\n").split("\n")
	if (lines.at(-1) === "") lines.pop()
	return { lines, newline }
}

function lineKey(line: string): string {
	return line.trim()
}

/**
 * Merge required ignore rules as a final, ordered block. Keeping the block at
 * the end matters for Git's last-match-wins rules. It makes generated public
 * environment exceptions effective after an existing `.env.*` rule, then
 * makes the generated private override exclusions effective after any broad
 * or user-added negation. Exact generated lines are removed from their old
 * positions so reruns do not accumulate duplicates.
 */
function mergeIgnore(existing: string, generated: string): string {
	if (!existing) return generated
	const old = splitLines(existing)
	const required = splitLines(generated)
	const generatedLines: string[] = []
	const generatedKeys = new Set<string>()
	for (const line of required.lines) {
		const key = lineKey(line)
		if (!key || generatedKeys.has(key)) continue
		generatedKeys.add(key)
		generatedLines.push(line)
	}
	if (generatedLines.length === 0) return existing
	const preserved = old.lines.filter(
		line => !generatedKeys.has(lineKey(line)),
	)
	const merged = [...preserved, ...generatedLines]
	const needsNewline =
		existing.endsWith("\n") ||
		existing.endsWith("\r\n") ||
		generated.endsWith("\n") ||
		generated.endsWith("\r\n")
	return merged.join(old.newline) + (needsNewline ? old.newline : "")
}

function envName(line: string): string | null {
	const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
	return match?.[1] ?? null
}

/** Keep all existing environment lines and append only variable names missing from them. */
function mergeEnvironment(existing: string, generated: string): string {
	if (!existing) return generated
	const old = splitLines(existing)
	const names = new Set(
		old.lines.map(envName).filter((name): name is string => name !== null),
	)
	const additions = requiredEnvironmentLines(generated).filter(line => {
		const name = envName(line)
		if (!name || names.has(name)) return false
		names.add(name)
		return true
	})
	if (additions.length === 0) return existing
	const newline = old.newline
	const separator = old.lines.length > 0 ? newline : ""
	return (
		old.lines.join(newline) +
		separator +
		additions.join(newline) +
		(existing.endsWith("\n") || existing.endsWith("\r\n")
			? newline
			: newline)
	)
}

function requiredEnvironmentLines(generated: string): string[] {
	return splitLines(generated).lines.filter(line => envName(line) !== null)
}

function isEnvironmentTemplate(relativePath: string): boolean {
	const name = relativePath.split("/").at(-1) ?? ""
	return name === ".env.example" || name.startsWith(".env.build.")
}

function isIgnoreFile(relativePath: string): boolean {
	return IGNORE_FILES.has(relativePath.split("/").at(-1) ?? "")
}

function isMergeFile(relativePath: string): boolean {
	return isIgnoreFile(relativePath) || isEnvironmentTemplate(relativePath)
}

function operation(before: string | null, after: string | null): FileOperation {
	if (before === null && after === null) return "unchanged"
	if (before === null) return "create"
	if (after === null) return "delete"
	return before === after ? "unchanged" : "update"
}

function changeFor(
	root: string,
	relativePath: string,
	before: string | null,
	after: string | null,
	conflict?: string,
): FileChange {
	return {
		path: targetPath(root, relativePath),
		relativePath,
		operation: operation(before, after),
		before,
		after,
		...(conflict ? { conflict } : {}),
	}
}

/**
 * Build a deterministic, side-effect-free file plan. Existing files are
 * never read through symlinks. Different existing files always require review.
 */
export async function planFiles(
	applicationDir: string,
	generated: Record<string, string>,
): Promise<FilePlan> {
	const root = resolve(applicationDir)
	const rootStat = await lstat(root)
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
		throw new FilePlanningError(
			`Application directory is not a real directory: ${applicationDir}`,
		)

	const normalised = new Map<string, string>()
	for (const [rawPath, content] of Object.entries(generated)) {
		if (typeof content !== "string")
			throw new FilePlanningError(
				`Generated content for ${rawPath} must be a string`,
			)
		const relativePath = normaliseRelativePath(rawPath)
		if (normalised.has(relativePath))
			throw new FilePlanningError(
				`Generated paths collide after normalisation: ${rawPath}`,
			)
		normalised.set(relativePath, content)
	}
	const changes: FileChange[] = []
	const conflicts: FileChange[] = []

	for (const relativePath of [...normalised.keys()].sort()) {
		const target = targetPath(root, relativePath)
		await assertSafeParents(root, target)
		const existing = await readExisting(target)
		const generatedContent = normalised.get(relativePath) as string
		const after =
			existing && isMergeFile(relativePath)
				? isIgnoreFile(relativePath)
					? mergeIgnore(existing.content, generatedContent)
					: mergeEnvironment(existing.content, generatedContent)
				: generatedContent

		let conflict: string | undefined
		if (existing && existing.content !== after) {
			if (await checkIgnored(root, target)) {
				conflict = "existing ignored file would be overwritten"
			} else if (isMergeFile(relativePath)) {
				// Ignore files and public env templates have explicit merge rules.
			} else {
				conflict =
					"existing file differs from generated content and requires review"
			}
		}
		const change = changeFor(
			root,
			relativePath,
			existing?.content ?? null,
			after,
			conflict,
		)
		if (conflict === "existing ignored file would be overwritten")
			ignoredReviewedChanges.add(change)
		changes.push(change)
		if (conflict) conflicts.push(change)
	}

	changes.sort((left, right) =>
		left.relativePath.localeCompare(right.relativePath),
	)
	conflicts.sort((left, right) =>
		left.relativePath.localeCompare(right.relativePath),
	)
	return { root, applicationDir: root, changes, conflicts }
}

async function currentForApply(
	root: string,
	change: FileChange,
): Promise<{ content: string | null; mode: number | null }> {
	await assertSafeParents(root, change.path)
	try {
		const stat = await lstat(change.path)
		if (stat.isSymbolicLink())
			throw new UnsafePathError(
				change.relativePath,
				"symbolic links are not followed",
			)
		if (!stat.isFile())
			throw new UnsafePathError(
				change.relativePath,
				"target is not a regular file",
			)
		return {
			content: (await readFile(change.path)).toString("utf8"),
			mode: stat.mode & 0o7777,
		}
	} catch (error) {
		if (error instanceof UnsafePathError) throw error
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { content: null, mode: null }
		throw error
	}
}

async function atomicWrite(
	root: string,
	target: string,
	content: string,
	mode: number | null,
	expectedBefore: string | null = null,
	createdDirectories?: Map<string, CreatedDirectory>,
): Promise<void> {
	for (const created of await assertSafeParents(root, target, true))
		createdDirectories?.set(created.path, created)
	const temporary = join(
		dirname(target),
		`.ashokify-write-${randomUUID()}.tmp`,
	)
	try {
		await writeFile(temporary, content, {
			encoding: "utf8",
			mode: mode ?? 0o644,
			flag: "wx",
		})
		if (mode !== null) await chmod(temporary, mode)
		const targetNow = await lstat(target).catch(
			(error: NodeJS.ErrnoException) =>
				error.code === "ENOENT" ? null : Promise.reject(error),
		)
		if (targetNow?.isSymbolicLink())
			throw new UnsafePathError(
				target,
				"target became a symbolic link while applying the plan",
			)
		if (targetNow && !targetNow.isFile())
			throw new UnsafePathError(
				target,
				"target became a non-file while applying the plan",
			)
		if (targetNow) {
			const currentBefore = (await readFile(target)).toString("utf8")
			if (currentBefore !== expectedBefore)
				throw new ConcurrentFileChangeError(relative(root, target))
		} else if (expectedBefore !== null) {
			throw new ConcurrentFileChangeError(relative(root, target))
		}
		await rename(temporary, target)
	} finally {
		await unlink(temporary).catch(() => undefined)
	}
}

interface Backup {
	change: FileChange
	beforeContent: string | null
	mode: number | null
	parentMtimeNs: bigint | null
}

function directoryMtime(stat: { mtimeMs: number }): bigint {
	// `lstat` without bigint options exposes mtimeMs in the Node typings. Turn
	// it into a bigint so comparisons do not accidentally mix numeric types.
	return BigInt(Math.round(stat.mtimeMs * 1_000_000))
}

async function removeCreatedDirectories(
	createdDirectories: Map<string, CreatedDirectory>,
	root: string,
): Promise<RecoveryIssue[]> {
	const issues: RecoveryIssue[] = []
	const directories = [...createdDirectories.values()].sort((left, right) => {
		const leftDepth = relative(root, left.path).split(sep).length
		const rightDepth = relative(root, right.path).split(sep).length
		return rightDepth - leftDepth
	})
	for (const created of directories) {
		try {
			const stat = await lstat(created.path)
			if (
				stat.isSymbolicLink() ||
				!stat.isDirectory() ||
				stat.dev !== created.dev ||
				stat.ino !== created.ino
			)
				continue
			const entries = await readdir(created.path)
			if (entries.length > 0) continue
			await rmdir(created.path)
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			// A concurrent removal, addition, or replacement means the path now
			// belongs to the user. Leave it alone and preserve that state.
			if (
				code === "ENOENT" ||
				code === "ENOTEMPTY" ||
				code === "EEXIST" ||
				code === "ENOTDIR"
			)
				continue
			issues.push({
				path: relative(root, created.path).split(sep).join("/"),
				reason: `could not remove an empty directory: ${error instanceof Error ? error.message : String(error)}`,
			})
		}
	}
	return issues
}

async function rollback(
	backups: Backup[],
	root: string,
	createdDirectories: Map<string, CreatedDirectory>,
): Promise<RecoveryIssue[]> {
	const issues: RecoveryIssue[] = []
	for (const backup of [...backups].reverse()) {
		const path = backup.change.relativePath
		try {
			const current = await currentForApply(root, backup.change)
			if (backup.change.operation === "delete") {
				if (current.content === backup.beforeContent) continue
				if (current.content !== null) {
					issues.push({
						path,
						reason: "the deleted path was recreated or changed during rollback",
					})
					continue
				}
				const parentStat = await lstat(dirname(backup.change.path))
				if (
					backup.parentMtimeNs !== null &&
					directoryMtime(parentStat) !== backup.parentMtimeNs
				) {
					issues.push({
						path,
						reason: "the deleted path's parent changed during rollback",
					})
					continue
				}
				await atomicWrite(
					root,
					backup.change.path,
					backup.beforeContent as string,
					backup.mode,
					null,
					createdDirectories,
				)
				continue
			}
			if (current.content === backup.beforeContent) continue
			if (current.content !== backup.change.after) {
				if (backup.beforeContent === null && current.content === null)
					continue
				issues.push({
					path,
					reason: "the path no longer matches the reviewed output",
				})
				continue
			}
			if (backup.beforeContent === null) {
				await unlink(backup.change.path)
			} else {
				await atomicWrite(
					root,
					backup.change.path,
					backup.beforeContent,
					backup.mode,
					backup.change.after,
					createdDirectories,
				)
			}
		} catch (error) {
			// A concurrent edit, a removed parent, or a permission failure must
			// not cause rollback to overwrite a user's newer state. Report the
			// path so the caller can recover it manually.
			issues.push({
				path,
				reason: `rollback failed: ${error instanceof Error ? error.message : String(error)}`,
			})
		}
	}
	issues.push(...(await removeCreatedDirectories(createdDirectories, root)))
	return issues
}

function appendRecoveryIssues(error: unknown, issues: RecoveryIssue[]): Error {
	const reported = error instanceof Error ? error : new Error(String(error))
	if (issues.length > 0) {
		reported.message = `${reported.message}. Recovery requires manual attention: ${issues.map(issue => `${issue.path} (${issue.reason})`).join("; ")}`
	}
	return reported
}

/** Apply only an explicitly reviewed, conflict-free plan with per-file checks. */
export async function applyPlan(plan: FilePlan): Promise<void> {
	if (!plan || !Array.isArray(plan.changes) || !Array.isArray(plan.conflicts))
		throw new FilePlanningError("Invalid file plan")
	if (
		plan.conflicts.length > 0 ||
		plan.changes.some(change => change.conflict)
	)
		throw new FileConflictError(
			plan.conflicts.length
				? plan.conflicts
				: plan.changes.filter(change => change.conflict),
		)
	const root = resolve(
		plan.root || plan.applicationDir || inferredPlanRoot(plan),
	)
	const rootStat = await lstat(root)
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
		throw new UnsafePathError(root, "plan root is not a real directory")

	const mutable = plan.changes.filter(
		change => change.operation !== "unchanged",
	)
	const seen = new Set<string>()
	for (const change of plan.changes) {
		const normalised = normaliseRelativePath(change.relativePath)
		if (
			normalised !== change.relativePath ||
			targetPath(root, normalised) !== resolve(change.path)
		)
			throw new UnsafePathError(
				change.relativePath,
				"reviewed path does not match its application root",
			)
		if (seen.has(change.relativePath))
			throw new FilePlanningError(
				`Reviewed path appears more than once: ${change.relativePath}`,
			)
		seen.add(change.relativePath)
	}

	const ordered = [...mutable].sort((left, right) =>
		left.relativePath.localeCompare(right.relativePath),
	)
	const backups: Backup[] = []
	const createdDirectories = new Map<string, CreatedDirectory>()
	try {
		for (const change of ordered) {
			const current = await currentForApply(root, change)
			const expectedBefore = change.before
			if (current.content !== expectedBefore)
				throw new ConcurrentFileChangeError(change.relativePath)
			if (
				current.content !== null &&
				(await checkIgnored(root, change.path)) &&
				!ignoredReviewedChanges.has(change)
			) {
				throw new FilePlanningError(
					`Refusing to overwrite an ignored file that was not present during review: ${change.relativePath}`,
				)
			}
			const parentStat =
				change.operation === "delete"
					? await lstat(dirname(change.path))
					: null
			backups.push({
				change,
				beforeContent: current.content,
				mode: current.mode,
				parentMtimeNs: parentStat ? directoryMtime(parentStat) : null,
			})

			if (change.operation === "delete") {
				await unlink(change.path)
				// Deleting a file changes its parent directory mtime. Record the
				// post-delete value so rollback can tell our deletion apart from
				// a later concurrent create or delete in that directory.
				backups[backups.length - 1]!.parentMtimeNs = directoryMtime(
					await lstat(dirname(change.path)),
				)
			} else if (change.after !== null)
				await atomicWrite(
					root,
					change.path,
					change.after,
					current.mode,
					current.content,
					createdDirectories,
				)
			else
				throw new FilePlanningError(
					`Non-delete change has no resulting content: ${change.relativePath}`,
				)
		}
	} catch (error) {
		const recoveryIssues = await rollback(backups, root, createdDirectories)
		throw appendRecoveryIssues(error, recoveryIssues)
	}
}

function inferredPlanRoot(plan: FilePlan): string {
	const first = plan.changes[0]
	if (!first)
		throw new FilePlanningError(
			"A file plan must contain an application root",
		)
	const segments = normaliseRelativePath(first.relativePath).split("/")
	return resolve(first.path, ...segments.map(() => ".."))
}

/** A compact text preview for CLI review screens and logs. */
export function previewChanges(plan: FilePlan): string {
	return plan.changes
		.map(
			change =>
				`${change.operation.padEnd(9)} ${change.relativePath}${change.conflict ? ` [conflict: ${change.conflict}]` : ""}`,
		)
		.join("\n")
}
