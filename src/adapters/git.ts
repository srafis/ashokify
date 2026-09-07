import { execFile as execFileCallback } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import { promisify } from "node:util"
import { isAbsolute, relative, resolve } from "node:path"
import type { FileChange } from "../planning/files.ts"

const execFile = promisify(execFileCallback)
const gitEnvironment = { ...process.env, GIT_OPTIONAL_LOCKS: "0" }

export interface GitStatusEntry {
	relativePath: string
	code: string
	raw: string
}

export interface GitSnapshot {
	/** The repository root at the time of the preflight. */
	root: string
	/** The commit checked out at the time of the preflight. Empty for an unborn branch. */
	head: string
	/** The index tree object at the time of the preflight. */
	index: string
	/** Fingerprint of the complete non-ignored worktree status. */
	worktree: string
	/** Fingerprint of HEAD, the index and the worktree status. */
	fingerprint: string
	/** The status entries captured during preflight. Normally empty. */
	status: GitStatusEntry[]
	/** Internal state fields are exposed so a snapshot can be serialized and restored. */
	statusRaw?: string
	trackedRaw?: string
}

export class GitAdapterError extends Error {
	readonly paths: string[]

	constructor(message: string, paths: string[] = []) {
		super(message)
		this.name = "GitAdapterError"
		this.paths = paths
	}
}

export class DirtyWorktreeError extends GitAdapterError {
	constructor(paths: string[]) {
		super(
			`Git worktree is not clean. Resolve these paths before running ashokify: ${paths.join(", ")}`,
			paths,
		)
		this.name = "DirtyWorktreeError"
	}
}

export class ConcurrentGitChangeError extends GitAdapterError {
	constructor(message: string, paths: string[] = []) {
		super(message, paths)
		this.name = "ConcurrentGitChangeError"
	}
}

export class CommitFailedError extends GitAdapterError {
	readonly stagedPaths: string[]

	constructor(message: string, stagedPaths: string[]) {
		super(
			`${message}. The index still contains: ${stagedPaths.join(", ") || "(nothing)"}`,
			stagedPaths,
		)
		this.name = "CommitFailedError"
		this.stagedPaths = stagedPaths
	}
}

interface GitState {
	head: string
	index: string
	status: GitStatusEntry[]
	statusRaw: string
	trackedRaw: string
}

async function runGit(cwd: string, args: string[]): Promise<string> {
	try {
		const result = await execFile("git", args, {
			cwd,
			env: gitEnvironment,
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		})
		return result.stdout
	} catch (error) {
		const err = error as NodeJS.ErrnoException & {
			stderr?: string
			stdout?: string
		}
		const detail = err.stderr?.trim() || err.message || "unknown Git error"
		throw new GitAdapterError(`git ${args.join(" ")} failed: ${detail}`)
	}
}

async function runGitAllowFailure(
	cwd: string,
	args: string[],
): Promise<{ ok: boolean; stdout: string }> {
	try {
		const result = await execFile("git", args, {
			cwd,
			env: gitEnvironment,
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		})
		return { ok: true, stdout: result.stdout }
	} catch (error) {
		const err = error as { stdout?: string }
		return { ok: false, stdout: err.stdout ?? "" }
	}
}

function digest(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex")
}

function parseStatus(output: string): GitStatusEntry[] {
	const records = output.split("\0").filter(record => record.length > 0)
	const entries: GitStatusEntry[] = []

	for (const record of records) {
		if (record.startsWith("# ")) continue

		if (record.startsWith("? ") || record.startsWith("! ")) {
			entries.push({
				relativePath: record.slice(2),
				code: record.slice(0, 2),
				raw: record,
			})
			continue
		}

		const fields = record.split(" ")
		const kind = fields[0]
		if (kind === "1" && fields.length >= 9) {
			entries.push({
				relativePath: fields.slice(8).join(" "),
				code: fields[1] ?? "??",
				raw: record,
			})
			continue
		}

		if (kind === "2") {
			const tab = record.indexOf("\t")
			const firstPath = tab === -1 ? record : record.slice(0, tab)
			const firstFields = firstPath.split(" ")
			if (firstFields.length >= 10) {
				entries.push({
					relativePath: firstFields.slice(9).join(" "),
					code: firstFields[1] ?? "??",
					raw: record,
				})
			}
			continue
		}

		if (kind === "u" && fields.length >= 11) {
			entries.push({
				relativePath: fields.slice(10).join(" "),
				code: fields[1] ?? "??",
				raw: record,
			})
		}
	}

	return entries
}

async function currentState(root: string): Promise<GitState> {
	const headResult = await runGitAllowFailure(root, [
		"rev-parse",
		"--verify",
		"HEAD",
	])
	const head = headResult.ok ? headResult.stdout.trim() : ""

	const statusRaw = await runGit(root, [
		"status",
		"--porcelain=v2",
		"--null",
		"--branch",
		"--untracked-files=all",
		"--ignore-submodules=none",
	])
	const trackedRaw = await runGit(root, [
		"ls-files",
		"-s",
		"--full-name",
		"-z",
	])
	// Hash the index file itself instead of using `git write-tree`. write-tree
	// is tempting here, but it writes a tree object into .git/objects as a side
	// effect of what should be a read-only preflight. Hashing the file also
	// captures index flags such as skip-worktree that ls-files -s omits.
	const indexPath = resolve(
		root,
		(await runGit(root, ["rev-parse", "--git-path", "index"])).trim(),
	)
	const indexBytes = await readFile(indexPath).catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null
			throw error
		},
	)
	const unmergedResult = await runGitAllowFailure(root, [
		"ls-files",
		"-u",
		"-z",
	])
	const index =
		unmergedResult.ok && unmergedResult.stdout.length > 0
			? `<unmerged-index:${digest(unmergedResult.stdout)}>`
			: digest(indexBytes ?? trackedRaw)
	return {
		head,
		index,
		status: parseStatus(statusRaw),
		statusRaw,
		trackedRaw,
	}
}

function stateFingerprint(state: GitState): string {
	return digest(
		`${state.head}\0${state.index}\0${state.statusRaw}\0${state.trackedRaw}`,
	)
}

function statusPaths(status: GitStatusEntry[]): string[] {
	return [...new Set(status.map(entry => entry.relativePath))].sort()
}

async function repositoryRoot(cwd: string): Promise<string> {
	const output = await runGit(resolve(cwd), ["rev-parse", "--show-toplevel"])
	return resolve(output.trim())
}

/**
 * Check that the complete repository worktree is clean and capture the state
 * needed to detect a later HEAD, index or worktree change.
 */
export async function preflight(cwd: string): Promise<GitSnapshot> {
	const root = await repositoryRoot(cwd)
	const state = await currentState(root)
	const paths = statusPaths(state.status)
	if (paths.length > 0) throw new DirtyWorktreeError(paths)

	return {
		root,
		head: state.head,
		index: state.index,
		worktree: digest(state.statusRaw),
		fingerprint: stateFingerprint(state),
		status: state.status,
		statusRaw: state.statusRaw,
		trackedRaw: state.trackedRaw,
	}
}

/** Recheck the exact Git state captured by `preflight`. */
export async function assertSnapshot(snapshot: GitSnapshot): Promise<void> {
	const root = await repositoryRoot(snapshot.root)
	if (root !== resolve(snapshot.root)) {
		throw new ConcurrentGitChangeError(
			`Git repository root changed from ${snapshot.root} to ${root}`,
		)
	}

	const state = await currentState(root)
	const paths = statusPaths(state.status)
	if (
		state.head !== snapshot.head ||
		state.index !== snapshot.index ||
		!sameStatus(state.status, snapshot.status)
	) {
		throw new ConcurrentGitChangeError(
			`Git state changed since preflight. Review the worktree again before continuing${paths.length ? `: ${paths.join(", ")}` : "."}`,
			paths,
		)
	}
}

function sameStatus(left: GitStatusEntry[], right: GitStatusEntry[]): boolean {
	if (left.length !== right.length) return false
	const leftRaw = left.map(entry => entry.raw).sort()
	const rightRaw = right.map(entry => entry.raw).sort()
	return leftRaw.every((entry, index) => entry === rightRaw[index])
}

function pathInside(root: string, target: string): boolean {
	const rel = relative(root, target)
	return (
		rel !== "" &&
		rel !== ".." &&
		!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
		!isAbsolute(rel)
	)
}

function gitRelativePath(root: string, target: string): string {
	const absolute = resolve(target)
	if (!pathInside(root, absolute))
		throw new GitAdapterError(
			`Reviewed path is outside the Git repository: ${target}`,
		)
	return relative(root, absolute).split("\\").join("/")
}

async function readRegularFile(target: string): Promise<Buffer | null> {
	try {
		const stat = await lstat(target)
		if (!stat.isFile())
			throw new GitAdapterError(
				`Reviewed path is not a regular file: ${target}`,
			)
		const data = await readFile(target)
		return data
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === "ENOENT") return null
		throw error
	}
}

function reviewedChanges(changes: FileChange[]): FileChange[] {
	return changes.filter(change => change.operation !== "unchanged")
}

async function verifyChangeContent(change: FileChange): Promise<void> {
	const current = await readRegularFile(change.path)
	const expected = change.operation === "delete" ? null : change.after
	if (expected === null) {
		if (current !== null)
			throw new ConcurrentGitChangeError(
				`Reviewed deletion changed before commit: ${change.relativePath}`,
				[change.relativePath],
			)
		return
	}
	if (current === null || current.toString("utf8") !== expected) {
		throw new ConcurrentGitChangeError(
			`Reviewed file changed before commit: ${change.relativePath}`,
			[change.relativePath],
		)
	}
}

async function stagedPaths(root: string): Promise<string[]> {
	const output = await runGit(root, ["diff", "--cached", "--name-only", "-z"])
	return output
		.split("\0")
		.filter(Boolean)
		.map(path => path.split("\\").join("/"))
		.sort()
}

async function stagedBlob(root: string, path: string): Promise<Buffer | null> {
	const result = await runGitAllowFailure(root, ["show", `:${path}`])
	return result.ok ? Buffer.from(result.stdout, "utf8") : null
}

/**
 * Stage exactly the reviewed changes and create one commit. The command never
 * pushes. If Git identity or a hook rejects the commit, the staged generated
 * files are deliberately left in place for the caller to inspect and retry.
 */
export async function commitReviewed(
	snapshot: GitSnapshot,
	changes: FileChange[],
	message: string,
): Promise<void> {
	if (!message.trim())
		throw new GitAdapterError("Commit message cannot be empty")
	const root = await repositoryRoot(snapshot.root)
	if (root !== resolve(snapshot.root))
		throw new ConcurrentGitChangeError("Git repository root changed")

	const allGitPaths = changes.map(change =>
		gitRelativePath(root, change.path),
	)
	if (new Set(allGitPaths).size !== allGitPaths.length)
		throw new GitAdapterError("The reviewed set contains duplicate paths")
	const reviewed = reviewedChanges(changes)
	const reviewedGitPaths = reviewed.map(change =>
		gitRelativePath(root, change.path),
	)
	const reviewedSet = new Set(reviewedGitPaths)
	const before = await currentState(root)
	if (before.head !== snapshot.head || before.index !== snapshot.index) {
		throw new ConcurrentGitChangeError(
			"HEAD or the Git index changed before the reviewed commit",
			statusPaths(before.status),
		)
	}

	const unrelated = before.status.filter(
		entry => !reviewedSet.has(entry.relativePath),
	)
	if (unrelated.length > 0) {
		throw new ConcurrentGitChangeError(
			`Unreviewed Git changes appeared before the commit: ${statusPaths(unrelated).join(", ")}`,
			statusPaths(unrelated),
		)
	}

	for (const change of changes) await verifyChangeContent(change)
	if (reviewed.length === 0) return

	// `-f` is limited to the reviewed allowlist. It permits an explicitly
	// adopted ignored path to be committed while still preventing any broad
	// add operation from pulling in unrelated local files.
	await runGit(root, ["add", "-A", "-f", "--", ...reviewedGitPaths])
	const afterStage = await currentState(root)
	if (afterStage.head !== snapshot.head)
		throw new ConcurrentGitChangeError(
			"HEAD changed while staging the reviewed files",
		)
	const unrelatedAfterStage = afterStage.status.filter(
		entry => !reviewedSet.has(entry.relativePath),
	)
	if (unrelatedAfterStage.length > 0) {
		throw new ConcurrentGitChangeError(
			`Unreviewed Git changes appeared while staging: ${statusPaths(unrelatedAfterStage).join(", ")}`,
			statusPaths(unrelatedAfterStage),
		)
	}
	for (const change of changes) await verifyChangeContent(change)
	const staged = await stagedPaths(root)
	const expectedStaged = [...reviewedSet].sort()
	if (
		staged.length !== expectedStaged.length ||
		staged.some((path, index) => path !== expectedStaged[index])
	) {
		throw new GitAdapterError(
			`Git staged paths differ from the reviewed set. Staged: ${staged.join(", ") || "(none)"}`,
		)
	}

	for (const change of reviewed) {
		const path = gitRelativePath(root, change.path)
		const blob = await stagedBlob(root, path)
		if (change.operation === "delete") {
			if (blob !== null)
				throw new GitAdapterError(
					`Git did not stage the reviewed deletion: ${change.relativePath}`,
				)
		} else if (blob === null || blob.toString("utf8") !== change.after) {
			throw new GitAdapterError(
				`Git staged unexpected content for ${change.relativePath}`,
			)
		}
	}

	try {
		await runGit(root, ["commit", "-m", message])
	} catch (error) {
		// runGit intentionally does not clean up the index. Hooks and identity
		// failures must leave the reviewed files available for a manual retry.
		const actualStagedPaths = await stagedPaths(root).catch(() => [])
		throw new CommitFailedError((error as Error).message, actualStagedPaths)
	}
}
