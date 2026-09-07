import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

await mkdir("dist", { recursive: true })
const result = await Bun.build({
	entrypoints: ["src/cli/bin.ts"],
	outdir: "dist",
	naming: "cli.js",
	target: "node",
	format: "esm",
	packages: "bundle",
	minify: false,
})
if (!result.success) {
	for (const log of result.logs) console.error(log)
	process.exitCode = 1
} else {
	await chmod("dist/cli.js", 0o755)
	const metadata = JSON.parse(await readFile("package.json", "utf8"))
	const notices = new Map<string, string>()
	async function includeLicense(name: string): Promise<void> {
		if (notices.has(name)) return
		const directory = join("node_modules", name)
		const dependency = JSON.parse(
			await readFile(join(directory, "package.json"), "utf8"),
		)
		const license = (await readdir(directory)).find(file =>
			/^licen[cs]e(?:\.(?:txt|md))?$/i.test(file),
		)
		if (!license)
			throw new Error(`Bundled dependency ${name} has no license file.`)
		notices.set(
			name,
			`${name}@${dependency.version}\n${await readFile(join(directory, license), "utf8")}`,
		)
		for (const child of Object.keys(dependency.dependencies ?? {}))
			await includeLicense(child)
	}
	for (const name of Object.keys(metadata.dependencies))
		await includeLicense(name)
	await writeFile(
		"dist/THIRD_PARTY_LICENSES.txt",
		[...notices]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([, notice]) => notice)
			.join("\n\n"),
	)
}
