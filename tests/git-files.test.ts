import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import {
	lstat,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
	applyPlan,
	FileConflictError,
	planFiles,
} from "../src/planning/files.ts"
import {
	assertSnapshot,
	commitReviewed,
	DirtyWorktreeError,
	preflight,
} from "../src/adapters/git.ts"

const directories: string[] = []
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" })

async function repository(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "ashokify-files-"))
	directories.push(root)
	git(root, "init", "-q")
	git(root, "config", "user.email", "tests@example.invalid")
	git(root, "config", "user.name", "Ashokify tests")
	await writeFile(join(root, "tracked.txt"), "tracked\n")
	git(root, "add", "tracked.txt")
	git(root, "commit", "-qm", "fixture")
	return root
}

afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true })
})

describe("file planning and application", () => {
	test("merges public files without metadata and leaves identical files unchanged", async () => {
		const root = await repository()
		await writeFile(join(root, ".gitignore"), "custom-cache\n!keep.txt\n")
		await writeFile(
			join(root, ".env.example"),
			"PUBLIC_URL=https://example.invalid\n",
		)
		const generated = {
			".gitignore": "node_modules\ncustom-cache\n",
			".env.example":
				"PUBLIC_URL=<set-public-value>\nPUBLIC_TOKEN=<set-public-value>\n",
			"deploy.yml": "steps: []\n",
		}
		const plan = await planFiles(root, generated)
		expect(plan.conflicts).toHaveLength(0)
		await applyPlan(plan)
		expect(await readFile(join(root, ".env.example"), "utf8")).toContain(
			"PUBLIC_URL=https://example.invalid",
		)
		expect(await readFile(join(root, ".env.example"), "utf8")).toContain(
			"PUBLIC_TOKEN=<set-public-value>",
		)
		await expect(lstat(join(root, ".ashokify"))).rejects.toThrow()

		const rerun = await planFiles(root, generated)
		expect(rerun.conflicts).toHaveLength(0)
		expect(
			rerun.changes.every(change => change.operation === "unchanged"),
		).toBe(true)
	})

	test("requires review before replacing any different existing file", async () => {
		const root = await repository()
		const first = await planFiles(root, { "deploy.yml": "one\n" })
		await applyPlan(first)
		await writeFile(join(root, "deploy.yml"), "developer edit\n")
		const changed = await planFiles(root, { "deploy.yml": "two\n" })
		expect(changed.conflicts[0]?.conflict).toContain("requires review")
		await expect(applyPlan(changed)).rejects.toBeInstanceOf(
			FileConflictError,
		)

		const customRoot = await repository()
		await writeFile(join(customRoot, "Dockerfile"), "FROM scratch\n")
		const custom = await planFiles(customRoot, {
			Dockerfile: "FROM node:22\n",
		})
		expect(custom.conflicts[0]?.conflict).toContain("requires review")
	})

	test("rejects traversal and symlink paths before writing", async () => {
		const root = await repository()
		await expect(planFiles(root, { "../outside": "bad" })).rejects.toThrow()
		await symlink(join(root, "tracked.txt"), join(root, "link.txt"))
		await expect(
			planFiles(root, { "link.txt": "replacement" }),
		).rejects.toThrow()
		expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe(
			"tracked\n",
		)
	})

	test("keeps public env exceptions effective and private overrides excluded", async () => {
		const root = await repository()
		await writeFile(
			join(root, ".dockerignore"),
			"!public.env\n.env.*\n!.env.local\n",
		)
		const plan = await planFiles(root, {
			".dockerignore":
				".env\n.env.*\n!.env.example\n!.env.build.*\n.env.build.*.override\n",
		})
		const merged =
			plan.changes.find(change => change.relativePath === ".dockerignore")
				?.after ?? ""
		expect(merged.indexOf(".env.*")).toBeLessThan(
			merged.indexOf("!.env.example"),
		)
		expect(merged.indexOf("!.env.build.*")).toBeLessThan(
			merged.indexOf(".env.build.*.override"),
		)
		expect(merged.indexOf("!.env.local")).toBeLessThan(
			merged.indexOf(".env.build.*.override"),
		)
		expect(merged.match(/^\.env\.\*$/gm)?.length).toBe(1)
	})

	test("treats an ignored existing public environment file as a conflict", async () => {
		const root = await repository()
		await writeFile(
			join(root, ".gitignore"),
			".env.build.*\n!.env.example\n",
		)
		await writeFile(join(root, ".env.build.dev"), "PUBLIC_URL=old\n")
		const plan = await planFiles(root, {
			".env.build.dev":
				"PUBLIC_URL=new\nPUBLIC_TOKEN=<set-public-value>\n",
		})
		expect(plan.conflicts).toHaveLength(1)
		expect(plan.conflicts[0]?.conflict).toContain("ignored")
		for (const change of plan.changes) delete change.conflict
		plan.conflicts = []
		await applyPlan(plan)
		expect(await readFile(join(root, ".env.build.dev"), "utf8")).toContain(
			"PUBLIC_TOKEN",
		)
	})

	test("refuses to write generated files through a parent symlink", async () => {
		const root = await repository()
		const outside = await mkdtemp(join(tmpdir(), "ashokify-outside-"))
		directories.push(outside)
		await symlink(outside, join(root, "scripts"))
		await expect(
			planFiles(root, { "scripts/deploy.sh": "x\n" }),
		).rejects.toThrow()
		await expect(lstat(join(outside, "deploy.sh"))).rejects.toThrow()
	})

	test("leaves files outside the generated set untouched", async () => {
		const root = await repository()
		const first = await planFiles(root, {
			".env.build.dev": "PUBLIC_URL=one\n",
		})
		await applyPlan(first)
		const removed = await planFiles(root, {})
		expect(removed.changes).toHaveLength(0)
		await applyPlan(removed)
		expect(await readFile(join(root, ".env.build.dev"), "utf8")).toBe(
			"PUBLIC_URL=one\n",
		)
	})

	test("rolls back files already written when a later target becomes unsafe", async () => {
		const root = await repository()
		const plan = await planFiles(root, {
			"created/first.txt": "first\n",
			"later/file.txt": "later\n",
		})
		await writeFile(
			join(root, "later"),
			"a file now blocks the planned directory",
		)
		await expect(applyPlan(plan)).rejects.toThrow()
		await expect(lstat(join(root, "created/first.txt"))).rejects.toThrow()
		await expect(lstat(join(root, "created"))).rejects.toThrow()
	})

	test("reports skipped rollback and preserves concurrent additions", async () => {
		const root = await repository()
		const firstPath = join(root, "created", "first.txt")
		const laterPath = join(root, "later", "file.txt")
		await writeFile(
			join(root, "later"),
			"a file now blocks the planned directory",
		)
		const second: {
			path: string
			relativePath: string
			operation: "create"
			before: null
			after: string
		} = {
			path: laterPath,
			relativePath: "later/file.txt",
			operation: "create",
			before: null,
			after: "later\n",
		}
		let accesses = 0
		Object.defineProperty(second, "path", {
			configurable: true,
			enumerable: true,
			get: () => {
				accesses += 1
				if (accesses === 2) {
					writeFileSync(firstPath, "user edit\n")
					writeFileSync(
						join(root, "created", "user-file.txt"),
						"kept\n",
					)
				}
				return laterPath
			},
		})
		const plan = {
			root,
			changes: [
				{
					path: firstPath,
					relativePath: "created/first.txt",
					operation: "create" as const,
					before: null,
					after: "first\n",
				},
				second,
			],
			conflicts: [],
		}
		await expect(applyPlan(plan)).rejects.toThrow(
			/Recovery requires manual attention: created\/first\.txt/,
		)
		expect(await readFile(firstPath, "utf8")).toBe("user edit\n")
		expect(
			await readFile(join(root, "created", "user-file.txt"), "utf8"),
		).toBe("kept\n")
		expect((await lstat(join(root, "created"))).isDirectory()).toBe(true)
	})
})

describe("Git preflight and reviewed commits", () => {
	test("supports an unborn repository and rejects a real submodule edit", async () => {
		const unborn = await mkdtemp(join(tmpdir(), "ashokify-unborn-"))
		directories.push(unborn)
		git(unborn, "init", "-q")
		const beforeObjects = git(unborn, "count-objects", "-v")
		const beforeIndex = await stat(join(unborn, ".git/index")).catch(
			() => null,
		)
		const unbornSnapshot = await preflight(unborn)
		expect(unbornSnapshot.head).toBe("")
		expect(git(unborn, "count-objects", "-v")).toBe(beforeObjects)
		const afterIndex = await stat(join(unborn, ".git/index")).catch(
			() => null,
		)
		expect(afterIndex).toBeNull()
		expect(beforeIndex).toBeNull()

		const root = await repository()
		const submodule = await mkdtemp(join(tmpdir(), "ashokify-submodule-"))
		directories.push(submodule)
		git(submodule, "init", "-q")
		git(submodule, "config", "user.email", "tests@example.invalid")
		git(submodule, "config", "user.name", "Ashokify tests")
		await writeFile(join(submodule, "module.txt"), "module\n")
		git(submodule, "add", "module.txt")
		git(submodule, "commit", "-qm", "module")
		git(
			root,
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"add",
			"-q",
			submodule,
			"vendor",
		)
		git(root, "commit", "-qam", "submodule")
		await writeFile(join(root, "vendor", "module.txt"), "module changed\n")
		const error = await preflight(root).catch(value => value)
		expect(error).toBeInstanceOf(DirtyWorktreeError)
		expect((error as DirtyWorktreeError).paths).toContain("vendor")
	})

	test("reports an unmerged index as a dirty conflict", async () => {
		const root = await repository()
		git(root, "branch", "-M", "main")
		git(root, "checkout", "-qb", "side")
		await writeFile(join(root, "tracked.txt"), "side\n")
		git(root, "commit", "-qam", "side")
		git(root, "checkout", "-q", "main")
		await writeFile(join(root, "tracked.txt"), "main\n")
		git(root, "commit", "-qam", "main")
		try {
			git(root, "merge", "side")
		} catch {
			/* expected conflict leaves the index unmerged */
		}
		const error = await preflight(root).catch(value => value)
		expect(error).toBeInstanceOf(DirtyWorktreeError)
		expect((error as DirtyWorktreeError).paths).toContain("tracked.txt")
	})

	test("rejects staged, unstaged, and untracked changes and detects concurrency", async () => {
		const root = await repository()
		const beforeIndex = await stat(join(root, ".git/index"))
		const snapshot = await preflight(root)
		const afterIndex = await stat(join(root, ".git/index"))
		expect(afterIndex.mtimeMs).toBe(beforeIndex.mtimeMs)
		await writeFile(join(root, "new.txt"), "new\n")
		await expect(preflight(root)).rejects.toBeInstanceOf(DirtyWorktreeError)
		await rm(join(root, "new.txt"))
		await writeFile(join(root, "tracked.txt"), "changed\n")
		await expect(assertSnapshot(snapshot)).rejects.toThrow()
	})

	test("commits only reviewed paths with exact contents", async () => {
		const root = await repository()
		const snapshot = await preflight(root)
		const plan = await planFiles(root, { "generated.yml": "exact\n" })
		await applyPlan(plan)
		await writeFile(join(root, "unrelated.txt"), "do not stage\n")
		await rm(join(root, "unrelated.txt"))
		await commitReviewed(snapshot, plan.changes, "chore: generated files")
		expect(git(root, "status", "--porcelain")).toBe("")
		expect(git(root, "show", "HEAD:generated.yml")).toBe("exact\n")
		expect(
			git(root, "show", "--pretty=format:", "--name-only", "HEAD").trim(),
		).toBe("generated.yml")
	})

	test("refuses a changed HEAD or unrelated staged index entry", async () => {
		const root = await repository()
		const snapshot = await preflight(root)
		const plan = await planFiles(root, { "generated.yml": "exact\n" })
		await applyPlan(plan)
		await writeFile(join(root, "unrelated.txt"), "staged\n")
		git(root, "add", "unrelated.txt")
		await expect(
			commitReviewed(snapshot, plan.changes, "chore: generated files"),
		).rejects.toThrow("index")
		expect(git(root, "diff", "--cached", "--name-only").trim()).toBe(
			"unrelated.txt",
		)

		const changedHead = await repository()
		const changedSnapshot = await preflight(changedHead)
		const changedPlan = await planFiles(changedHead, {
			"generated.yml": "head\n",
		})
		await applyPlan(changedPlan)
		await writeFile(join(changedHead, "head-change.txt"), "head changed\n")
		git(changedHead, "add", "head-change.txt")
		git(changedHead, "commit", "-qm", "changed head")
		await expect(
			commitReviewed(
				changedSnapshot,
				changedPlan.changes,
				"chore: generated files",
			),
		).rejects.toThrow("HEAD")
	})

	test("leaves staged files when a commit hook rejects the commit", async () => {
		const root = await repository()
		const snapshot = await preflight(root)
		const plan = await planFiles(root, { "generated.yml": "hooked\n" })
		await applyPlan(plan)
		await writeFile(
			join(root, ".git/hooks/pre-commit"),
			"#!/bin/sh\nexit 1\n",
			{ mode: 0o755 },
		)
		await expect(
			commitReviewed(snapshot, plan.changes, "chore: rejected"),
		).rejects.toThrow("generated.yml")
		expect(
			git(root, "diff", "--cached", "--name-only")
				.trim()
				.split("\n")
				.sort(),
		).toEqual(["generated.yml"])
	})
})
