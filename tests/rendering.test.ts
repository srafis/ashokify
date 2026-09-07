import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { renderFiles } from "../src/recipes/vite-static/index.ts"
import { validateGenerated } from "../src/validation/index.ts"
import type { DeploymentConfig } from "../src/config/types.ts"

const execFileAsync = promisify(execFile)

const artifactConfig = (): DeploymentConfig => ({
	schemaVersion: 1,
	templateVersion: 1,
	application: { directory: "apps/web", name: "Portal", id: "portal" },
	build: {
		recipe: "vite-static",
		packageManager: "pnpm",
		packageManagerVersion: "9.15.0",
		lockfile: "pnpm-lock.yaml",
		nodeConstraint: ">=22 <23",
		nodeVersion: "22.23.2",
		command: "pnpm run build",
		outputDirectory: "dist",
		architecture: "linux/amd64",
	},
	pipeline: { provider: "azure-devops", registryConnection: "sifars-acr" },
	registry: { hostname: "sifars.azurecr.io", repository: "portal" },
	environments: [
		{ branch: "main", id: "main", publicFile: ".env.build.main" },
		{
			branch: "feature/payments",
			id: "feature-payments",
			publicFile: ".env.build.feature-payments",
		},
		{
			branch: "release/payments",
			id: "release-payments",
			publicFile: ".env.build.release-payments",
		},
	],
	serving: { mode: "artifact", destination: "dist" },
	frontendVariables: ["VITE_API_URL"],
	connectivity: {},
})

describe("Vite static renderer", () => {
	test("renders deterministic app-relative artifact files and full branch refs", () => {
		const config = artifactConfig()
		const first = renderFiles(config)
		const second = renderFiles(config)
		expect(first).toEqual(second)
		expect(first["azure-pipelines.yml"]).toContain(
			"refs/heads/feature/payments",
		)
		expect(first["azure-pipelines.yml"]).toContain(
			"$(Build.SourcesDirectory)/apps/web/",
		)
		expect(first["azure-pipelines.yml"]).not.toContain("DockerCompose@1")
		expect(first["Dockerfile"]).toContain("FROM scratch AS artifact")
		expect(first["docker-compose.yml"]).toBeUndefined()
		expect(first[".dockerignore"]).not.toContain("!.env.build.*\n")
	})

	test("structurally validates generated artifacts and rejects branch injection", () => {
		const config = artifactConfig()
		const generated = renderFiles(config)
		const results = validateGenerated(config, generated)
		expect(results.some(result => result.status === "failed")).toBe(false)
		const unexpected = validateGenerated(config, {
			...generated,
			".env.build.private.local": "VITE_API_URL=private\n",
		})
		expect(
			unexpected.find(result => result.name === "generated-paths")
				?.status,
		).toBe("failed")
		expect(() =>
			renderFiles({
				...config,
				environments: [
					{
						...config.environments[0]!,
						branch: "feature/$(injected)",
						id: "feature",
						publicFile: ".env.build.feature",
					},
				],
			}),
		).toThrow()
	})

	test("executes the allowlisted dotenv parser with quoted and secure values", async () => {
		const config = {
			...artifactConfig(),
			frontendVariables: ["VITE_API_URL", "VITE_API_KEY"],
		}
		const files = renderFiles(config)
		const directory = await mkdtemp(join(tmpdir(), "ashokify-rendering-"))
		try {
			const helper = join(directory, "prepare-frontend-env.sh")
			const publicFile = join(directory, ".env.public")
			const overrideFile = join(directory, ".env.override")
			await writeFile(helper, files["scripts/prepare-frontend-env.sh"]!)
			await chmod(helper, 0o755)
			await writeFile(
				publicFile,
				'export VITE_API_URL = "https://example.invalid?a=1&b=\\"quoted\\"" # comment\nVITE_API_KEY=<set-public-value>\n',
			)
			await writeFile(
				overrideFile,
				"export VITE_API_KEY = 'literal $(echo should-not-run) = # hash' # comment\n",
			)
			const command =
				'if [ "$VITE_API_URL" != \'https://example.invalid?a=1&b="quoted"\' ] || [ "$VITE_API_KEY" != \'literal $(echo should-not-run) = # hash\' ]; then exit 1; fi; printf parsed'
			const result = await execFileAsync("bash", [
				helper,
				publicFile,
				overrideFile,
				"--",
				"bash",
				"-c",
				command,
			])
			expect(result.stdout).toBe("parsed")
			await expect(
				execFileAsync("bash", [helper, publicFile, "", "--", "true"]),
			).rejects.toThrow(/Unresolved public frontend value/)
			const duplicateFile = join(directory, ".env.duplicate")
			await writeFile(
				duplicateFile,
				"VITE_API_URL=https://one.invalid\nVITE_API_URL=https://two.invalid\nVITE_API_KEY=present\n",
			)
			await expect(
				execFileAsync("bash", [
					helper,
					duplicateFile,
					"",
					"--",
					"true",
				]),
			).rejects.toThrow(/Duplicate approved frontend key/)
			const parsedHelper = await readFile(helper, "utf8")
			expect(parsedHelper).not.toContain("source ")
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	test("maps conditional secure, host and Tailscale tasks for container delivery", () => {
		const config: DeploymentConfig = {
			...artifactConfig(),
			pipeline: {
				provider: "azure-devops",
				registryConnection: "registry-connection",
			},
			serving: {
				mode: "container",
				image: "nginx:1.27.1",
				command: [],
				assetPath: "/usr/share/nginx/html",
				containerPort: 8080,
				hostPort: 18080,
				network: "shared-proxy",
			},
			environments: artifactConfig().environments.map(
				(environment, index) => ({
					...environment,
					secureFile: index === 0 ? "main-secure.env" : undefined,
					hostConnection: `docker-host-${index}`,
				}),
			),
			connectivity: { tailscaleSecureFile: "tailscale-auth.key" },
		}
		const files = renderFiles(config)
		const results = validateGenerated(config, files)
		expect(results.some(result => result.status === "failed")).toBe(false)
		const pipeline = files["azure-pipelines.yml"]!
		expect(pipeline).toContain("DockerCompose@1")
		expect(pipeline).toContain("dockerHostEndpoint: 'docker-host-0'")
		expect(pipeline).toContain("name: secure_env_0_main")
		expect(pipeline).toContain(
			"ASHOKIFY_SECURE_ENV_0_MAIN: $(secure_env_0_main.secureFilePath)",
		)
		expect(pipeline).not.toContain(
			'override_file="$(secure_env_0_main.secureFilePath)"',
		)
		expect(pipeline).toContain("secureFile: 'tailscale-auth.key'")
		expect(pipeline).toContain(
			"ASHOKIFY_TAILSCALE_AUTH_FILE: $(tailscale_auth.secureFilePath)",
		)
		expect(pipeline).toContain("refs/heads/feature/payments")
		expect(pipeline).toContain("up --detach --no-build --pull always")
		expect(files["docker-compose.yml"]).toContain("platform: 'linux/amd64'")
		const yarnOneConfig: DeploymentConfig = {
			...config,
			build: {
				...config.build,
				packageManager: "yarn",
				packageManagerVersion: "1.22.22",
				lockfile: "yarn.lock",
			},
		}
		const yarnOneFiles = renderFiles(yarnOneConfig)
		expect(
			validateGenerated(yarnOneConfig, yarnOneFiles).some(
				result => result.status === "failed",
			),
		).toBe(false)
	})
})
