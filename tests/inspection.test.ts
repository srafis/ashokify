import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { inspectProject } from "../src/inspection/index.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(directory => rm(directory, { recursive: true, force: true })),
	)
})

async function fixture(
	files: Record<string, string>,
	applicationAtRoot = false,
): Promise<{ root: string; app: string }> {
	const root = await mkdtemp(join("/tmp", "ashokify-inspection-"))
	temporaryDirectories.push(root)
	const app = applicationAtRoot ? root : join(root, "app")
	await mkdir(app, { recursive: true })
	for (const [name, contents] of Object.entries(files)) {
		const path = join(app, name)
		await mkdir(join(path, ".."), { recursive: true })
		await writeFile(path, contents)
	}
	return { root, app }
}

describe("inspectProject", () => {
	test("detects a Vite frontend without running config or reading env values", async () => {
		const { root, app } = await fixture({
			"package.json": JSON.stringify({
				name: "@example/portal",
				packageManager: "pnpm@9.15.0",
				engines: { node: ">=22 <23" },
				scripts: { build: "tsc && vite build" },
				dependencies: { react: "^19.0.0" },
				devDependencies: {
					vite: "^7.0.0",
					"@vitejs/plugin-react": "^5.0.0",
				},
			}),
			"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
			"vite.config.ts":
				"export default { build: { outDir: 'public-dist' } }",
			".env.example": "VITE_API_URL=https://private.example.invalid\n",
			"src/main.tsx":
				"const url = import.meta.env.VITE_API_URL\nconsole.log(url)",
		})
		const facts = await inspectProject(app, root)
		expect(facts.directory).toBe(app)
		expect(facts.name).toBe("@example/portal")
		expect(facts.packageManager).toBe("pnpm")
		expect(facts.packageManagerVersion).toBe("9.15.0")
		expect(facts.lockfile).toBe("pnpm-lock.yaml")
		expect(facts.nodeVersion).toBe("22.23.2")
		expect(facts.buildCommand).toBe("pnpm run build")
		expect(facts.outputDirectory).toBe("public-dist")
		expect(facts.staticStatus).toBe("supported")
		expect(facts.frontendVariables).toEqual(["VITE_API_URL"])
		expect(JSON.stringify(facts)).not.toContain("private.example.invalid")
	})

	test("reports conflicting lockfile evidence and keeps the result ambiguous", async () => {
		const { root, app } = await fixture({
			"package.json": JSON.stringify({
				name: "frontend",
				scripts: { build: "vite build" },
				devDependencies: { vite: "^7.0.0" },
			}),
			"package-lock.json": "{}",
			"yarn.lock": "",
			"vite.config.js": "export default {}",
		})
		const facts = await inspectProject(app, root)
		expect(facts.packageManager).toBeUndefined()
		expect(facts.packageManagerCandidates).toEqual(["npm", "yarn"])
		expect(facts.staticStatus).toBe("ambiguous")
		expect(
			facts.warnings.some(warning =>
				warning.includes("Found multiple lockfiles"),
			),
		).toBe(true)
	})

	test("marks server-rendered projects unsupported from static evidence", async () => {
		const { root, app } = await fixture({
			"package.json": JSON.stringify({
				name: "server-app",
				scripts: { build: "vite build --ssr" },
				dependencies: { vite: "^7.0.0", express: "^5.0.0" },
			}),
			"vite.config.ts": "export default { ssr: { target: 'node' } }",
		})
		const facts = await inspectProject(app, root)
		expect(facts.staticStatus).toBe("unsupported")
		expect(
			facts.warnings.some(warning =>
				warning.includes("unsupported framework or server build"),
			),
		).toBe(true)
	})

	test("uses the same static recipe evidence for React and Vue", async () => {
		for (const [framework, plugin] of [
			["react", "@vitejs/plugin-react"],
			["vue", "@vitejs/plugin-vue"],
		] as const) {
			const { root, app } = await fixture({
				"package.json": JSON.stringify({
					name: `${framework}-app`,
					packageManager: "npm@10.8.2",
					scripts: { build: "vite build" },
					devDependencies: { vite: "7.0.0", [plugin]: "latest" },
				}),
				"package-lock.json": "{}",
				"vite.config.ts": "export default {}",
			})
			const facts = await inspectProject(app, root)
			expect(facts.staticStatus).toBe("supported")
			expect(facts.packageManager).toBe("npm")
			expect(facts.buildCommand).toBe("npm run build")
		}
	})

	test("keeps dynamic Vite output ambiguous", async () => {
		const { root, app } = await fixture({
			"package.json": JSON.stringify({
				name: "dynamic-output",
				packageManager: "bun@1.4.2",
				scripts: { build: "vite build" },
				devDependencies: { vite: "7.0.0" },
			}),
			"bun.lock": "",
			"vite.config.ts":
				"const output = process.env.OUT_DIR; export default { build: { outDir: output } }",
		})
		const facts = await inspectProject(app, root)
		expect(facts.staticStatus).toBe("ambiguous")
		expect(facts.outputDirectory).toBe("dist")
		expect(
			facts.warnings.some(warning =>
				warning.includes("Could not read the build output folder"),
			),
		).toBe(true)
	})

	test("reports metadata and lockfile package-manager conflicts", async () => {
		const { root, app } = await fixture({
			"package.json": JSON.stringify({
				name: "conflicted",
				packageManager: "yarn@4.5.0",
				scripts: { build: "vite build" },
				devDependencies: { vite: "7.0.0" },
			}),
			"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
			"vite.config.js": "export default {}",
		})
		const facts = await inspectProject(app, root)
		expect(facts.packageManager).toBeUndefined()
		expect(facts.packageManagerCandidates).toEqual(["pnpm", "yarn"])
		expect(
			facts.warnings.some(warning =>
				warning.includes("package.json selects yarn"),
			),
		).toBe(true)
	})

	test("recognizes each supported reproducible lockfile", async () => {
		const lockfiles = [
			["npm", "package-lock.json", "npm@10.8.2"],
			["pnpm", "pnpm-lock.yaml", "pnpm@9.15.0"],
			["yarn", "yarn.lock", "yarn@4.5.0"],
			["bun", "bun.lock", "bun@1.4.2"],
		] as const
		for (const [manager, lockfile, packageManager] of lockfiles) {
			const { root, app } = await fixture({
				"package.json": JSON.stringify({
					name: `${manager}-app`,
					packageManager,
					scripts: { build: "vite build" },
					devDependencies: { vite: "7.0.0" },
				}),
				[lockfile]: "",
				"vite.config.js": "export default {}",
			})
			const facts = await inspectProject(app, root)
			expect(facts.packageManager).toBe(manager)
			expect(facts.lockfile).toBe(lockfile)
			expect(facts.staticStatus).toBe("supported")
		}
	})

	test("requires manual handling for workspaces and rejects shared workspace dependencies", async () => {
		const ambiguous = await fixture(
			{
				"package.json": JSON.stringify({
					name: "workspace-root",
					packageManager: "pnpm@9.15.0",
					workspaces: ["apps/*"],
					scripts: { build: "vite build" },
					devDependencies: { vite: "7.0.0" },
				}),
				"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
				"vite.config.ts": "export default {}",
			},
			true,
		)
		await expect(
			inspectProject(ambiguous.app, ambiguous.root),
		).rejects.toThrow(/ambiguous monorepo.*--cwd/)
		const standalone = await fixture({
			"package.json": JSON.stringify({
				name: "nested-app",
				packageManager: "pnpm@9.15.0",
				scripts: { build: "vite build" },
				devDependencies: { vite: "7.0.0" },
			}),
			"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
			"vite.config.ts": "export default {}",
		})
		await writeFile(
			join(standalone.root, "pnpm-workspace.yaml"),
			"packages:\n  - app\n",
		)
		expect(
			(await inspectProject(standalone.app, standalone.root))
				.staticStatus,
		).toBe("supported")
		const shared = await fixture({
			"package.json": JSON.stringify({
				name: "shared-app",
				packageManager: "pnpm@9.15.0",
				scripts: { build: "vite build" },
				dependencies: { "@example/ui": "workspace:*", vite: "7.0.0" },
			}),
			"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
			"vite.config.ts": "export default {}",
		})
		const facts = await inspectProject(shared.app, shared.root)
		expect(facts.staticStatus).toBe("unsupported")
		expect(
			facts.warnings.some(warning =>
				warning.includes("Shared workspace dependency"),
			),
		).toBe(true)
	})

	test("fails closed for malformed manifests and unsafe static output paths", async () => {
		const malformed = await fixture({ "package.json": "{not json" })
		await expect(
			inspectProject(malformed.app, malformed.root),
		).rejects.toThrow(/package\.json/)
		const unsafe = await fixture({
			"package.json": JSON.stringify({
				name: "unsafe",
				packageManager: "npm@10.8.2",
				scripts: { build: "vite build" },
				devDependencies: { vite: "7.0.0" },
			}),
			"package-lock.json": "{}",
			"vite.config.ts":
				"export default { build: { outDir: '../outside' } }",
		})
		await expect(inspectProject(unsafe.app, unsafe.root)).rejects.toThrow(
			/outputDirectory/,
		)
	})
})
