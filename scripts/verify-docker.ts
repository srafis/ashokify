import { spawn } from "node:child_process"
import {
	mkdtemp,
	mkdir,
	writeFile,
	readFile,
	readdir,
	rm,
} from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { renderFiles } from "../src/recipes/vite-static/index.ts"
import { validateConfig, resolveNodeVersion } from "../src/config/index.ts"
import type { DeploymentConfig, PackageManager } from "../src/config/types.ts"

async function run(
	command: string,
	args: string[],
	cwd: string,
	capture = false,
	environment?: Record<string, string>,
): Promise<string> {
	return await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: { ...process.env, ...environment },
			stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
		})
		let output = ""
		let error = ""
		child.stdout?.on("data", chunk => {
			output += chunk
		})
		child.stderr?.on("data", chunk => {
			error += chunk
		})
		child.on("error", reject)
		child.on("close", code =>
			code === 0
				? resolve(output.trim())
				: reject(new Error(`${command} failed with ${code}: ${error}`)),
		)
	})
}

async function contents(directory: string): Promise<string> {
	let output = ""
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name)
		output += entry.isDirectory()
			? await contents(path)
			: await readFile(path, "utf8")
	}
	return output
}

const temporary = await mkdtemp(join(tmpdir(), "ashokify-docker-"))
const unique = `${process.pid}-${Date.now()}`
const images: string[] = []
const containers: string[] = []
const sharedFixtures: Array<{
	directory: string
	image: string
	config: DeploymentConfig
}> = []
const composeProjects: Array<{
	directory: string
	environment: Record<string, string>
}> = []
const network = `ashokify-verify-${unique}`
let networkCreated = false
const nodeVersion = resolveNodeVersion()
const managers: Array<{
	name: PackageManager
	version: string
	lockfile: string
	install: string[]
}> = [
	{
		name: "npm",
		version: "10.8.2",
		lockfile: "package-lock.json",
		install: ["npm", "install", "--package-lock-only", "--ignore-scripts"],
	},
	{
		name: "pnpm",
		version: "9.15.9",
		lockfile: "pnpm-lock.yaml",
		install: [
			"sh",
			"-c",
			"corepack enable && corepack prepare pnpm@9.15.9 --activate && pnpm install --lockfile-only --ignore-scripts",
		],
	},
	{
		name: "yarn",
		version: "1.22.22",
		lockfile: "yarn.lock",
		install: [
			"sh",
			"-c",
			"corepack enable && corepack prepare yarn@1.22.22 --activate && yarn install --ignore-scripts",
		],
	},
	{
		name: "yarn",
		version: "4.9.2",
		lockfile: "yarn.lock",
		install: [
			"sh",
			"-c",
			"corepack enable && corepack prepare yarn@4.9.2 --activate && yarn install --mode=skip-build",
		],
	},
	{
		name: "bun",
		version: "1.4.2",
		lockfile: "bun.lock",
		install: ["bun", "install", "--ignore-scripts"],
	},
]

try {
	await run("docker", ["info"], temporary, true)
	await run("docker", ["buildx", "version"], temporary, true)
	await run("docker", ["compose", "version"], temporary, true)
	for (const [index, manager] of managers.entries()) {
		const framework = index % 2 ? "vue" : "react"
		const directory = join(temporary, `${manager.name}-${manager.version}`)
		await mkdir(join(directory, "public"), { recursive: true })
		const manifest = {
			name: `fixture-${manager.name}-${framework}`,
			version: "1.0.0",
			type: "module",
			packageManager: `${manager.name}@${manager.version}`,
			scripts: {
				build: "vite build",
				...(index === 0
					? { postinstall: "node ./verify-install.cjs" }
					: {}),
			},
			dependencies: {
				vite: "6.1.0",
				...(framework === "react"
					? { react: "19.0.0", "react-dom": "19.0.0" }
					: { vue: "3.5.13" }),
			},
		}
		await writeFile(
			join(directory, "package.json"),
			JSON.stringify(manifest, null, 2),
		)
		await writeFile(
			join(directory, "verify-install.cjs"),
			'require("node:fs").readFileSync("install-input.txt");\n',
		)
		await writeFile(
			join(directory, "install-input.txt"),
			"Source required during installation\n",
		)
		await writeFile(
			join(directory, "vite.config.js"),
			'export default { build: { outDir: "site" } }\n',
		)
		await writeFile(
			join(directory, "index.html"),
			'<div id="app"></div><script type="module" src="/main.js"></script>\n',
		)
		const body =
			framework === "react"
				? 'import React from "react"; import { createRoot } from "react-dom/client"; createRoot(document.getElementById("app")).render(React.createElement("h1", null, import.meta.env.VITE_LABEL));'
				: 'import { createApp, h } from "vue"; createApp({render: () => h("h1", import.meta.env.VITE_LABEL)}).mount("#app");'
		await writeFile(
			join(directory, "main.js"),
			body + "\nconsole.log(import.meta.env.VITE_LEAK);\n",
		)
		await writeFile(
			join(directory, ".env.local"),
			"VITE_LEAK=PRIVATE_BUILD_SENTINEL\nREGISTRY_PASSWORD=PRIVATE_REGISTRY_SENTINEL\n",
		)
		await writeFile(
			join(directory, ".env.build.private.local"),
			"VITE_LEAK=PRIVATE_NESTED_SENTINEL\n",
		)
		await writeFile(
			join(directory, "public", "server.cjs"),
			'const http=require("node:http"),fs=require("node:fs"),path=require("node:path"); http.createServer((q,s)=>{const p=path.join(process.cwd(),q.url.split("?")[0]);s.end(fs.readFileSync(fs.existsSync(p)&&fs.statSync(p).isFile()?p:"index.html"))}).listen(8080,"0.0.0.0");\n',
		)
		if (manager.name === "yarn" && manager.version.startsWith("4."))
			await writeFile(
				join(directory, ".yarnrc.yml"),
				"nodeLinker: node-modules\n",
			)
		const installerImage =
			manager.name === "bun"
				? `oven/bun:${manager.version}`
				: `node:${nodeVersion}-bookworm-slim`
		console.log(
			`Preparing ${framework} / ${manager.name}@${manager.version}`,
		)
		await run(
			"docker",
			[
				"run",
				"--rm",
				"-v",
				`${directory}:/workspace`,
				"-w",
				"/workspace",
				installerImage,
				...manager.install,
			],
			temporary,
		)
		await run(
			"docker",
			[
				"run",
				"--rm",
				"-v",
				`${directory}:/workspace`,
				installerImage,
				"chmod",
				"-R",
				"a+rwX",
				"/workspace",
			],
			temporary,
		)
		const id = `fixture-${index}`
		const config: DeploymentConfig = validateConfig({
			schemaVersion: 1,
			templateVersion: 1,
			application: { directory: ".", name: manifest.name, id },
			build: {
				recipe: "vite-static",
				packageManager: manager.name,
				packageManagerVersion: manager.version,
				lockfile: manager.lockfile,
				nodeVersion,
				command: `${manager.name} run build`,
				outputDirectory: "site",
				architecture: "linux/amd64",
			},
			pipeline: {
				provider: "azure-devops",
				registryConnection: "fixture-registry",
			},
			registry: { hostname: "registry.example.invalid", repository: id },
			environments: [
				{
					branch: "feature/payments",
					id: "feature-payments",
					publicFile: ".env.build.feature-payments",
					secureFile: "fixture-public-override.env",
					hostConnection: "fixture-host",
				},
			],
			serving: {
				mode: "container",
				image: `node:${nodeVersion}-bookworm-slim`,
				command: ["node", "server.cjs"],
				assetPath: "/site",
				containerPort: 8080,
			},
			frontendVariables: ["VITE_LABEL"],
			connectivity: {},
		})
		if (framework === "vue")
			config.serving = {
				mode: "container",
				image: "nginx:alpine",
				command: [],
				assetPath: "/usr/share/nginx/html",
				containerPort: 8080,
				nginx: { spaFallback: true },
			}
		for (const [name, value] of Object.entries(renderFiles(config))) {
			await mkdir(join(directory, name, ".."), { recursive: true })
			await writeFile(join(directory, name), value)
		}
		await writeFile(
			join(directory, ".env.build.feature-payments.override"),
			"VITE_LABEL=Verified frontend\nREGISTRY_PASSWORD=PRIVATE_OVERRIDE_SENTINEL\n",
		)
		const image = `ashokify-verify-${unique}-${index}:test`
		images.push(image)
		await run(
			"bash",
			[
				"scripts/prepare-frontend-env.sh",
				".env.build.feature-payments",
				".env.build.feature-payments.override",
				"--",
				"docker",
				"build",
				"--build-arg",
				"VITE_LABEL",
				"--platform",
				"linux/amd64",
				"-t",
				image,
				".",
			],
			directory,
		)
		const buildImage = `ashokify-verify-${unique}-${index}:build`
		images.push(buildImage)
		await run(
			"bash",
			[
				"scripts/prepare-frontend-env.sh",
				".env.build.feature-payments",
				".env.build.feature-payments.override",
				"--",
				"docker",
				"build",
				"--build-arg",
				"VITE_LABEL",
				"--target",
				"build",
				"-t",
				buildImage,
				".",
			],
			directory,
		)
		await run(
			"docker",
			[
				"run",
				"--rm",
				buildImage,
				"node",
				"-e",
				'const fs=require("node:fs"); for(const path of [".env.local",".env.build.private.local",".env.build.feature-payments.override"]) if(fs.existsSync("/workspace/"+path)) throw Error("Private file entered the Docker context: "+path)',
			],
			directory,
		)
		const container = await run(
			"docker",
			["run", "-d", "--rm", "-p", "127.0.0.1::8080", image],
			directory,
			true,
		)
		containers.push(container)
		const binding = await run(
			"docker",
			["port", container, "8080/tcp"],
			directory,
			true,
		)
		let served = false
		for (let attempt = 0; attempt < 30; attempt++) {
			try {
				const response = await fetch(`http://${binding}/client/route`)
				served =
					response.ok && (await response.text()).includes('id="app"')
				if (served) break
			} catch {
				/* Wait for the isolated serving process to start. */
			}
			await Bun.sleep(200)
		}
		if (!served)
			throw new Error(
				`${framework}/${manager.name} did not serve its SPA route.`,
			)
		const output = join(temporary, `output-${index}`)
		await mkdir(output)
		await run(
			"docker",
			[
				"cp",
				`${container}:${config.serving.mode === "container" ? config.serving.assetPath : "/site"}/.`,
				output,
			],
			directory,
		)
		const built = await contents(output)
		if (!built.includes("Verified frontend") || built.includes("PRIVATE_"))
			throw new Error("Frontend values or private file exclusion failed.")
		if (index < 2)
			sharedFixtures.push({
				directory,
				image,
				config: structuredClone(config),
			})
		if (index === 0) {
			config.serving = {
				mode: "artifact",
				destination: "Fixture artifact export",
			}
			await writeFile(
				join(directory, "Dockerfile"),
				renderFiles(config).Dockerfile!,
			)
			const artifact = join(temporary, "artifact")
			await run(
				"bash",
				[
					"scripts/prepare-frontend-env.sh",
					".env.build.feature-payments",
					".env.build.feature-payments.override",
					"--",
					"docker",
					"buildx",
					"build",
					"--build-arg",
					"VITE_LABEL",
					"--target",
					"artifact",
					"--output",
					`type=local,dest=${artifact}`,
					".",
				],
				directory,
			)
			if (
				!(
					await readFile(join(artifact, "index.html"), "utf8")
				).includes('id="app"')
			)
				throw new Error("Static artifact export is missing index.html.")
		}
		console.log(
			`Verified ${framework}/${manager.name}@${manager.version}: build, serving, SPA fallback and private file exclusion.`,
		)
	}
	await run(
		"docker",
		["network", "create", "--internal", network],
		temporary,
		true,
	)
	networkCreated = true
	for (const [index, fixture] of sharedFixtures.entries()) {
		if (fixture.config.serving.mode !== "container")
			throw new Error("Expected container fixture")
		fixture.config.serving.network = network
		if (fixture.config.serving.nginx) {
			fixture.config.serving.nginx.proxyPath = "/api/"
			fixture.config.serving.nginx.proxyTarget = "http://fixture-0:8080/"
		}
		for (const [name, value] of Object.entries(renderFiles(fixture.config)))
			await writeFile(join(fixture.directory, name), value)
		const environment = {
			ASHOKIFY_IMAGE: fixture.image,
			ASHOKIFY_COMPOSE_PROJECT: `ashokify-coexist-${unique}-${index}`,
		}
		if (fixture.config.serving.nginx)
			await run(
				"bash",
				[
					"scripts/prepare-frontend-env.sh",
					".env.build.feature-payments",
					".env.build.feature-payments.override",
					"--",
					"docker",
					"build",
					"--build-arg",
					"VITE_LABEL",
					"-t",
					fixture.image,
					".",
				],
				fixture.directory,
			)
		composeProjects.push({ directory: fixture.directory, environment })
		const parsed = JSON.parse(
			await run(
				"docker",
				[
					"compose",
					"-f",
					"docker-compose.yml",
					"config",
					"--format",
					"json",
				],
				fixture.directory,
				true,
				environment,
			),
		)
		if (parsed.services[fixture.config.application.id].build)
			throw new Error(
				"Runtime Compose unexpectedly contains build instructions.",
			)
		await run(
			"docker",
			[
				"compose",
				"-f",
				"docker-compose.yml",
				"up",
				"--detach",
				"--no-build",
				"--pull",
				"never",
			],
			fixture.directory,
			false,
			environment,
		)
	}
	await run(
		"docker",
		[
			"run",
			"--rm",
			"--network",
			network,
			`node:${nodeVersion}-bookworm-slim`,
			"node",
			"-e",
			'Promise.all([fetch("http://fixture-0:8080/client/route").then(r=>r.text()),fetch("http://fixture-1:8080/api/server.cjs").then(r=>r.text())]).then(([a,b])=>{if(!a.includes("id=\\\"app\\\"")||!b.includes("createServer"))throw Error("Shared Compose serving or proxy failed")})',
		],
		temporary,
	)
	for (const project of composeProjects) {
		const running = await run(
			"docker",
			[
				"compose",
				"-f",
				"docker-compose.yml",
				"ps",
				"--status",
				"running",
				"-q",
			],
			project.directory,
			true,
			project.environment,
		)
		if (!running)
			throw new Error(
				"One Compose project stopped when the other started.",
			)
	}
	console.log(
		"Verified generated Compose projects coexist on an explicit shared network and the selected Nginx proxy reaches the first application.",
	)
} finally {
	for (const project of composeProjects.reverse())
		await run(
			"docker",
			["compose", "-f", "docker-compose.yml", "down"],
			project.directory,
			true,
			project.environment,
		).catch(() => {})
	for (const container of containers)
		await run("docker", ["rm", "-f", container], temporary, true).catch(
			() => {},
		)
	if (networkCreated)
		await run("docker", ["network", "rm", network], temporary, true).catch(
			() => {},
		)
	for (const image of images)
		await run("docker", ["image", "rm", image], temporary, true).catch(
			() => {},
		)
	await rm(temporary, { recursive: true, force: true })
}
