import { execFileSync } from "node:child_process"
import {
	lstat,
	mkdtemp,
	mkdir,
	readdir,
	readFile,
	rm,
	writeFile,
	symlink,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const temporary = await mkdtemp(join(tmpdir(), "ashokify-package-"))
const run = (command: string, args: string[], cwd = process.cwd()) =>
	execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" })
try {
	run("bun", ["pm", "pack", "--destination", temporary])
	const archive = (await readdir(temporary)).find(name =>
		name.endsWith(".tgz"),
	)!
	run("tar", ["-xzf", join(temporary, archive), "-C", temporary])
	const directory = join(temporary, "package")
	const metadata = JSON.parse(
		await readFile(join(directory, "package.json"), "utf8"),
	)
	const entrypoint = join(directory, metadata.bin.ashokify)
	const contents = run("tar", ["-tzf", join(temporary, archive)])
	if (/package\/(?:src|tests|node_modules|\.env)(?:\/|\.)/.test(contents))
		throw new Error("The archive contains development or private files.")
	const binaryDirectory = join(temporary, "bin")
	await mkdir(binaryDirectory)
	for (const binary of ["node", "git"])
		await symlink(
			binary === "node" && process.env.ASHOKIFY_TEST_NODE
				? resolve(process.env.ASHOKIFY_TEST_NODE)
				: run("which", [binary]).trim(),
			join(binaryDirectory, binary),
		)
	const environment = { ...process.env, PATH: binaryDirectory, NO_COLOR: "1" }
	const installedBin = join(binaryDirectory, "ashokify")
	await symlink(entrypoint, installedBin)
	const help = execFileSync(installedBin, ["--help"], {
		env: environment,
		encoding: "utf8",
	})
	if (!help.includes("--cwd"))
		throw new Error("Packed CLI help did not run using Node alone.")
	const version = execFileSync(installedBin, ["--version"], {
		env: environment,
		encoding: "utf8",
	}).trim()
	if (version !== metadata.version)
		throw new Error("Packed CLI version differs from package metadata.")
	const fixture = join(temporary, "fixture")
	await mkdir(fixture)
	await writeFile(
		join(fixture, "package.json"),
		JSON.stringify({
			name: "package-smoke",
			packageManager: "npm@10.8.2",
			scripts: { build: "vite build" },
			devDependencies: { vite: "6.1.0" },
		}),
	)
	await writeFile(
		join(fixture, "package-lock.json"),
		'{"lockfileVersion":3,"packages":{}}\n',
	)
	await writeFile(
		join(fixture, "index.html"),
		"<h1>Package smoke test</h1>\n",
	)
	await writeFile(join(fixture, "vite.config.ts"), "export default {}\n")
	run("git", ["init", "-q"], fixture)
	run(
		"git",
		[
			"-c",
			"user.name=Package test",
			"-c",
			"user.email=test@example.invalid",
			"add",
			".",
		],
		fixture,
	)
	run(
		"git",
		[
			"-c",
			"user.name=Package test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-qm",
			"fixture",
		],
		fixture,
	)
	execFileSync(
		"python",
		[
			resolve("scripts/package-smoke.py"),
			installedBin,
			fixture,
			binaryDirectory,
		],
		{ timeout: 90_000, stdio: "inherit" },
	)
	for (const file of ["Dockerfile", "azure-pipelines.yml", "DEPLOYMENT.md"])
		await readFile(join(fixture, file))
	for (const path of ["ashokify.config.json", ".ashokify"])
		if (
			await lstat(join(fixture, path)).then(
				() => true,
				error => {
					if (error.code === "ENOENT") return false
					throw error
				},
			)
		)
			throw new Error(`Unexpected saved generator state: ${path}`)
	if (run("git", ["diff", "--cached", "--name-only"], fixture))
		throw new Error("Declining commit staged files.")
	console.log(
		`Packed ${archive}: Node-only help, version and interactive generation passed.`,
	)
} finally {
	await rm(temporary, { recursive: true, force: true })
}
