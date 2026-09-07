import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { setup } from "../src/workflows/setup.ts"
import { Cancelled, type Choice, type UserInterface } from "../src/cli/ui.ts"
import { parseArguments } from "../src/cli/index.ts"
import { previewChange } from "../src/cli/preview.ts"

const directories: string[] = []
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" })

async function fixture(nested = false) {
	const root = await mkdtemp(join(tmpdir(), "ashokify-workflow-"))
	directories.push(root)
	git(root, "init", "-q")
	git(root, "config", "user.email", "tests@example.invalid")
	git(root, "config", "user.name", "Ashokify tests")
	const directory = nested ? join(root, "apps", "web") : root
	await mkdir(directory, { recursive: true })
	await writeFile(
		join(directory, "package.json"),
		JSON.stringify({
			name: "test-frontend",
			packageManager: "npm@10.8.2",
			scripts: { build: "vite build" },
			devDependencies: { vite: "6.1.0", react: "19.0.0" },
		}),
	)
	await writeFile(
		join(directory, "package-lock.json"),
		JSON.stringify({
			name: "test-frontend",
			lockfileVersion: 3,
			packages: {},
		}),
	)
	await writeFile(join(directory, "vite.config.ts"), "export default {}\n")
	await writeFile(
		join(directory, "index.html"),
		'<div id="app">Test frontend</div>\n',
	)
	await writeFile(join(directory, ".gitignore"), "node_modules\n.env.local\n")
	git(root, "add", ".")
	git(root, "commit", "-qm", "fixture")
	return { root, directory }
}

class ScriptedUI implements UserInterface {
	messages: string[] = []
	ids: string[] = []
	constructor(readonly values: Record<string, unknown> = {}) {}
	private take<T>(id: string, initial: T): T {
		this.ids.push(id)
		const value = Object.hasOwn(this.values, id) ? this.values[id] : initial
		if (value === "CANCEL") throw new Cancelled()
		return value as T
	}
	async text(
		id: string,
		_message: string,
		initial = "",
		validate?: (value: string) => string | undefined,
	) {
		const value = this.take(id, initial)
		const error = validate?.(value)
		if (error) throw new Error(`${id}: ${error}`)
		return value
	}
	async confirm(id: string, _message: string, initial = false) {
		return this.take(id, initial)
	}
	async select<T extends string>(
		id: string,
		_message: string,
		options: Choice<T>[],
		initial?: T,
	): Promise<T> {
		const value = this.take(
			id,
			initial ?? options.find(option => !option.disabled)!.value,
		)
		if (!options.some(option => option.value === value && !option.disabled))
			throw new Error(`Invalid selection ${id}`)
		return value
	}
	async multi(
		id: string,
		_message: string,
		_options: Choice<string>[],
		initial: string[],
	) {
		return this.take(id, initial)
	}
	info(message: string) {
		this.messages.push(message)
	}
	warn(message: string) {
		this.messages.push(message)
	}
}

afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true })
})

describe("interactive setup workflow", () => {
	test("uses the detected package manager without asking for a selection", async () => {
		const { root } = await fixture()
		const ui = new ScriptedUI({ packageManager: "bun", apply: true })
		await setup(root, ui)
		expect(ui.ids).not.toContain("packageManager")
		expect(ui.ids).not.toContain("detected")
		expect(ui.ids).not.toContain("recipe")
		expect(ui.ids).not.toContain("static")
		expect(ui.messages).toContain("Package manager: npm")
		const saved = JSON.parse(
			await readFile(join(root, "ashokify.config.json"), "utf8"),
		)
		expect(saved.build.packageManager).toBe("npm")
	})
	test("returns a schema validation error to its field before writing", async () => {
		const { root } = await fixture()
		const ui = new ScriptedUI({
			registryConnection: "invalid;connection",
			"correct:pipeline.registryConnection": "valid-connection",
			apply: true,
		})
		await setup(root, ui)
		expect(ui.ids).toContain("correct:pipeline.registryConnection")
		const saved = JSON.parse(
			await readFile(join(root, "ashokify.config.json"), "utf8"),
		)
		expect(saved.pipeline.registryConnection).toBe("valid-connection")
	})
	test("artifact generation, declined commit and dirty-rerun rejection", async () => {
		const { root } = await fixture()
		const ui = new ScriptedUI({ apply: true })
		const result = await setup(root, ui)
		expect(result.status).toBe("written")
		expect(result.files).toContain("azure-pipelines.yml")
		expect(git(root, "diff", "--cached", "--name-only")).toBe("")
		expect(await readFile(join(root, "Dockerfile"), "utf8")).not.toContain(
			"nginx",
		)
		await expect(setup(root, new ScriptedUI())).rejects.toThrow()
	})

	test("one reviewed commit and an identical rerun produce no new commit", async () => {
		const { root } = await fixture()
		const first = await setup(
			root,
			new ScriptedUI({ apply: true, commit: true }),
		)
		expect(first.status).toBe("committed")
		const head = git(root, "rev-parse", "HEAD")
		expect(git(root, "status", "--porcelain")).toBe("")
		const second = await setup(root, new ScriptedUI())
		expect(second.status).toBe("unchanged")
		expect(git(root, "rev-parse", "HEAD")).toBe(head)
	})

	test("cancelling at every prompt before application leaves Git and files unchanged", async () => {
		const { root } = await fixture()
		const probe = new ScriptedUI()
		await expect(setup(root, probe)).rejects.toBeInstanceOf(Cancelled)
		const original = git(root, "rev-parse", "HEAD")
		for (const id of probe.ids) {
			await expect(
				setup(root, new ScriptedUI({ [id]: "CANCEL" })),
			).rejects.toBeInstanceOf(Cancelled)
			expect(git(root, "status", "--porcelain")).toBe("")
			expect(git(root, "rev-parse", "HEAD")).toBe(original)
		}
	}, 30_000)

	test("custom slash branches and nested application directory persist correctly", async () => {
		const { root, directory } = await fixture(true)
		await setup(
			directory,
			new ScriptedUI({
				branches: [],
				additionalBranches: "feature/payments,release/payments",
				apply: true,
			}),
		)
		const saved = JSON.parse(
			await readFile(join(directory, "ashokify.config.json"), "utf8"),
		)
		expect(saved.application.directory).toBe("apps/web")
		expect(saved.environments.map((env: { id: string }) => env.id)).toEqual(
			["feature-payments", "release-payments"],
		)
		expect(git(root, "diff", "--cached", "--name-only")).toBe("")
	})

	test("unknown builds stop with a specific reason without asking for static confirmation", async () => {
		const { root } = await fixture()
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({
				name: "custom-frontend",
				packageManager: "npm@10.8.2",
				scripts: { build: "custom-build" },
			}),
		)
		await rm(join(root, "vite.config.ts"))
		git(root, "add", ".")
		git(root, "commit", "-qm", "custom build")
		const ui = new ScriptedUI({ static: true, apply: true })
		await expect(setup(root, ui)).rejects.toThrow(
			"Could not detect Vite in this folder",
		)
		expect(ui.ids).not.toContain("recipe")
		expect(ui.ids).not.toContain("static")
		expect(git(root, "status", "--porcelain")).toBe("")
	})

	test("a dynamic output folder only needs the output folder prompt", async () => {
		const { root } = await fixture()
		await writeFile(
			join(root, "vite.config.ts"),
			"export default { build: { outDir: process.env.OUT_DIR } }",
		)
		git(root, "add", ".")
		git(root, "commit", "-qm", "dynamic output")
		const ui = new ScriptedUI({ outputDirectory: "site", apply: true })
		await setup(root, ui)
		expect(ui.ids).toContain("outputDirectory")
		expect(ui.ids).not.toContain("static")
		const saved = JSON.parse(
			await readFile(join(root, "ashokify.config.json"), "utf8"),
		)
		expect(saved.build.outputDirectory).toBe("site")
	})

	test("custom Vite scripts stop with a specific build script issue", async () => {
		const { root } = await fixture()
		const manifest = JSON.parse(
			await readFile(join(root, "package.json"), "utf8"),
		)
		manifest.scripts.build = "node build.mjs"
		await writeFile(join(root, "package.json"), JSON.stringify(manifest))
		git(root, "add", ".")
		git(root, "commit", "-qm", "custom build")
		const ui = new ScriptedUI({ static: true, apply: true })
		await expect(setup(root, ui)).rejects.toThrow(
			"The build script does not call vite build directly",
		)
		expect(ui.ids).not.toContain("static")
		expect(git(root, "status", "--porcelain")).toBe("")
	})

	test("existing custom deployment file requires explicit review", async () => {
		const { root } = await fixture()
		await writeFile(
			join(root, "Dockerfile"),
			"FROM scratch\n# existing custom content\n",
		)
		git(root, "add", "Dockerfile")
		git(root, "commit", "-qm", "existing deployment")
		await expect(setup(root, new ScriptedUI())).rejects.toBeInstanceOf(
			Cancelled,
		)
		expect(await readFile(join(root, "Dockerfile"), "utf8")).toContain(
			"existing custom content",
		)
		await setup(
			root,
			new ScriptedUI({ "adopt:Dockerfile": true, apply: true }),
		)
		expect(await readFile(join(root, "Dockerfile"), "utf8")).not.toContain(
			"existing custom content",
		)
	})

	test("container serving validates Compose and uses only selected host resources", async () => {
		const { root } = await fixture()
		const result = await setup(
			root,
			new ScriptedUI({
				serving: "container",
				servingImage: "node:22.23.2-bookworm-slim",
				assetPath: "/site",
				servingCommand: '["node","server.cjs"]',
				containerPort: "8080",
				hostPort: "18080",
				network: "existing-project-network",
				apply: true,
			}),
		)
		expect(result.status).toBe("written")
		expect(result.validation.some(check => check.status === "failed")).toBe(
			false,
		)
		const compose = await readFile(join(root, "docker-compose.yml"), "utf8")
		expect(compose).toContain("18080:8080")
		expect(compose).toContain("existing-project-network")
		expect(compose).not.toContain("container_name")
		expect(compose).not.toContain("build:")
	})

	test("preserves committed public values when adding another approved variable", async () => {
		const { root } = await fixture()
		await setup(
			root,
			new ScriptedUI({
				variables: "VITE_ORIGIN",
				apply: true,
				commit: true,
			}),
		)
		for (const file of [
			".env.example",
			".env.build.main",
			".env.build.staging",
			".env.build.develop",
		]) {
			await writeFile(
				join(root, file),
				"# Intentional public origin\nVITE_ORIGIN=https://example.invalid\n",
			)
		}
		git(root, "add", ".")
		git(root, "commit", "-qm", "public frontend values")
		await setup(
			root,
			new ScriptedUI({
				variables: "VITE_ORIGIN,VITE_LABEL",
				apply: true,
			}),
		)
		expect(await readFile(join(root, ".env.build.main"), "utf8")).toContain(
			"VITE_ORIGIN=https://example.invalid",
		)
	})
})

test("CLI argument parsing rejects unsupported or incomplete options", () => {
	expect(parseArguments(["--help"]).help).toBe(true)
	expect(parseArguments(["--version"]).version).toBe(true)
	expect(() => parseArguments(["--yes"])).toThrow("Unknown argument")
	expect(() => parseArguments(["--cwd"])).toThrow("requires")
	expect(() => parseArguments(["--cwd=a", "--cwd=b"])).toThrow("only once")
})

test("previews hide environment values and credentials and escape terminal controls", () => {
	const preview = previewChange({
		path: "/tmp/.env.example",
		relativePath: ".env.example",
		operation: "update",
		before: "VITE_URL=PRIVATE_PREVIEW_SENTINEL\n",
		after: "VITE_URL=PRIVATE_PREVIEW_SENTINEL\nVITE_LABEL=<set-public-value>\n",
	})
	expect(preview).not.toContain("PRIVATE_PREVIEW_SENTINEL")
	expect(preview).toContain("VITE_LABEL=<set-public-value>")
	const custom = previewChange({
		path: "/tmp/Dockerfile",
		relativePath: "Dockerfile",
		operation: "update",
		before: "ENV PASSWORD=PRIVATE_PASSWORD_SENTINEL\n# \u001b[31mtext\n",
		after: "FROM scratch\n",
	})
	expect(custom).not.toContain("PRIVATE_PASSWORD_SENTINEL")
	expect(custom).not.toContain("\u001b")
})
