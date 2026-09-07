import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
	mkdtemp,
	mkdir,
	copyFile,
	writeFile,
	rm,
	lstat,
} from "node:fs/promises"
import { join, relative, dirname } from "node:path"
import { tmpdir } from "node:os"
import type { DeploymentConfig, ValidationResult } from "../config/types.ts"
import type { FilePlan } from "../planning/files.ts"

const exec = promisify(execFile)

export async function validateTemporaryCopy(
	root: string,
	directory: string,
	plan: FilePlan,
	config: DeploymentConfig,
): Promise<ValidationResult[]> {
	const checks: ValidationResult[] = [
		{
			name: "docker-build",
			status: "not-run",
			detail: "Build and test the image before deployment. See DEPLOYMENT.md for commands.",
		},
	]
	if (config.serving.mode !== "container") return checks
	const deleted = new Set(
		plan.changes
			.filter(change => change.after === null)
			.map(change => change.path),
	)
	try {
		await exec("docker", ["compose", "version"], { timeout: 10_000 })
	} catch {
		return [
			...checks,
			{
				name: "Docker Compose",
				status: "not-run",
				detail: "Docker Compose is not available. Follow DEPLOYMENT.md to check the Compose files before deployment.",
			},
		]
	}
	const temporary = await mkdtemp(join(tmpdir(), "ashokify-validate-"))
	try {
		const listing = await exec(
			"git",
			["ls-files", "-z", "--", relative(root, directory) || "."],
			{ cwd: root, maxBuffer: 10 * 1024 * 1024 },
		)
		for (const repositoryPath of listing.stdout
			.split("\0")
			.filter(Boolean)) {
			const source = join(root, repositoryPath)
			const localPath = relative(directory, source)
			if (
				deleted.has(source) ||
				localPath.startsWith("..") ||
				/(^|\/)\.env(?:\.|$)/.test(localPath)
			)
				continue
			const stat = await lstat(source)
			if (!stat.isFile() || stat.isSymbolicLink()) continue
			const destination = join(temporary, localPath)
			await mkdir(dirname(destination), { recursive: true })
			await copyFile(source, destination)
		}
		for (const change of plan.changes) {
			if (change.after === null) continue
			const path = join(temporary, change.relativePath)
			await mkdir(dirname(path), { recursive: true })
			await writeFile(path, change.after)
		}
		const toolEnvironment = Object.fromEntries(
			[
				"PATH",
				"HOME",
				"DOCKER_CONFIG",
				"XDG_CONFIG_HOME",
				"SystemRoot",
			].flatMap(key =>
				process.env[key] ? [[key, process.env[key]!]] : [],
			),
		)
		const environment = {
			...toolEnvironment,
			...Object.fromEntries(
				config.frontendVariables.map(key => [key, "validation"]),
			),
			ASHOKIFY_IMAGE: `${config.registry.hostname}/${config.registry.repository}:validation`,
			ASHOKIFY_COMPOSE_PROJECT: `ashokify-${config.application.id}-${config.environments[0]!.id}`,
		}
		await exec(
			"docker",
			["compose", "-f", "docker-compose.yml", "config", "--quiet"],
			{ cwd: temporary, env: environment, timeout: 30_000 },
		)
		await exec(
			"docker",
			[
				"compose",
				"-f",
				"docker-compose.yml",
				"-f",
				"docker-compose.override.yml",
				"config",
				"--quiet",
			],
			{ cwd: temporary, env: environment, timeout: 30_000 },
		)
		checks.push({
			name: "Docker Compose",
			status: "passed",
			detail: "Runtime and explicit build file combinations validate in a temporary copy with nonsecret values.",
		})
	} catch (error) {
		checks.push({
			name: "Docker Compose",
			status: "failed",
			detail: `Temporary configuration check failed: ${(error as Error).message}`,
		})
	} finally {
		await rm(temporary, { recursive: true, force: true })
	}
	return checks
}
