import { resolve } from "node:path"
import * as clack from "@clack/prompts"
import metadata from "../../package.json"
import { setup } from "../workflows/setup.ts"
import { Cancelled, terminalUI } from "./ui.ts"
import { safeTerminal } from "./preview.ts"

export function parseArguments(args: string[]): {
	cwd: string
	help: boolean
	version: boolean
} {
	let cwd = process.cwd()
	let help = false
	let version = false
	let hasCwd = false
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!
		if (argument === "--help" || argument === "-h") help = true
		else if (argument === "--version" || argument === "-v") version = true
		else if (argument === "--cwd" || argument.startsWith("--cwd=")) {
			if (hasCwd) throw new Error("Pass --cwd only once.")
			const value = argument.startsWith("--cwd=")
				? argument.slice(6)
				: args[++index]
			if (!value || value.startsWith("--"))
				throw new Error("--cwd requires an application directory.")
			cwd = resolve(value)
			hasCwd = true
		} else
			throw new Error(
				`Unknown argument: ${argument}. Run ashokify --help for supported options.`,
			)
	}
	return { cwd, help, version }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
	try {
		const options = parseArguments(args)
		if (options.help) {
			console.log(
				`ashokify ${metadata.version}\n\nCreate Docker and Azure pipeline files for a Vite static site.\n\nUsage: ashokify [--cwd <application-directory>]\n\n  --cwd <directory>  Path to the app you want to configure\n  --help, -h         Show help\n  --version, -v      Show version\n\nStart with a clean Git working tree. Review the files before saving them, then choose whether to commit.\nThis command prepares deployment files. It does not create Azure resources or run the pipeline.`,
			)
			return
		}
		if (options.version) {
			console.log(metadata.version)
			return
		}
		if (!process.stdin.isTTY || !process.stdout.isTTY)
			throw new Error(
				"Setup requires an interactive terminal. Run ashokify in a terminal, or use --help to view usage.",
			)
		clack.intro("ashokify")
		const result = await setup(options.cwd, terminalUI)
		clack.outro(
			result.status === "committed"
				? "Deployment files committed locally."
				: result.status === "unchanged"
					? "Deployment files are already up to date."
					: "Deployment files are ready. Follow DEPLOYMENT.md to continue.",
		)
	} catch (error) {
		if (error instanceof Cancelled) {
			clack.cancel(
				"Setup cancelled. Any files saved before cancellation are still on disk.",
			)
			process.exitCode = 130
		} else {
			clack.log.error(safeTerminal((error as Error).message))
			process.exitCode = 1
		}
	}
}
