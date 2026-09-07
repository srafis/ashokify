import { realpath } from "node:fs/promises"
import { relative, sep } from "node:path"
import { previewChange } from "../cli/preview.ts"
import { preflight, assertSnapshot, commitReviewed } from "../adapters/git.ts"
import { applyPlan, planFiles } from "../planning/files.ts"
import { inspectProject } from "../inspection/index.ts"
import type { ValidationResult } from "../config/types.ts"
import { configure } from "../cli/configure.ts"
import { Cancelled, type UserInterface } from "../cli/ui.ts"
import { renderFiles } from "../recipes/vite-static/index.ts"
import { validateGenerated } from "../validation/index.ts"
import { validateTemporaryCopy } from "./temporary-validation.ts"

export interface SetupResult {
	status: "unchanged" | "written" | "committed"
	files: string[]
	validation: ValidationResult[]
}

export async function setup(
	cwd: string,
	ui: UserInterface,
): Promise<SetupResult> {
	const directory = await realpath(cwd)
	const snapshot = await preflight(directory)
	const facts = await inspectProject(directory, snapshot.root)
	const config = await configure(facts, snapshot.root, ui)
	const generated = renderFiles(config)
	const plan = await planFiles(directory, generated)
	if (plan.changes.some(change => change.operation !== "unchanged"))
		ui.info(
			"Review the file changes below. This preview hides environment values and recognized credentials.",
		)
	for (const change of plan.changes) {
		if (change.operation === "unchanged") continue
		ui.info(previewChange(change))
		if (change.conflict) {
			ui.warn(`${change.relativePath}: ${change.conflict}`)
			if (
				!(await ui.confirm(
					`adopt:${change.relativePath}`,
					`Replace ${change.relativePath} with the version shown above?`,
					false,
				))
			)
				throw new Cancelled()
			delete change.conflict
		}
	}
	plan.conflicts = plan.changes.filter(change => change.conflict)
	const effective = Object.fromEntries(
		plan.changes
			.filter(change => change.after !== null)
			.map(change => [change.relativePath, change.after!]),
	)
	const validation = validateGenerated(config, effective)
	if (!validation.some(result => result.status === "failed")) {
		const additional = await validateTemporaryCopy(
			snapshot.root,
			directory,
			plan,
			config,
		)
		validation.push(
			...additional.filter(
				result =>
					!validation.some(existing => existing.name === result.name),
			),
		)
	}
	const passed = validation.filter(result => result.status === "passed")
	if (passed.length) ui.info(`${passed.length} configuration checks passed.`)
	for (const result of validation.filter(
		result => result.status !== "passed",
	))
		ui.warn(
			`${result.name.replaceAll("-", " ")}: ${result.status.replaceAll("-", " ")}. ${result.detail}`,
		)
	const failures = validation.filter(result => result.status === "failed")
	if (failures.length)
		throw new Error(
			`Generated configuration failed validation. No files were written.\n${failures.map(result => `${result.name}: ${result.detail}`).join("\n")}`,
		)
	ui.info(
		"Before running the pipeline, follow the Azure setup steps in DEPLOYMENT.md.",
	)
	const changed = plan.changes.filter(
		change => change.operation !== "unchanged",
	)
	if (!changed.length) {
		await assertSnapshot(snapshot)
		ui.info("Your deployment files already match these settings.")
		return { status: "unchanged", files: [], validation }
	}
	if (
		!(await ui.confirm(
			"apply",
			`Apply these changes to ${changed.length} ${changed.length === 1 ? "file" : "files"}?`,
			false,
		))
	)
		throw new Cancelled()
	await assertSnapshot(snapshot)
	await applyPlan(plan)
	const files = changed.map(change =>
		relative(snapshot.root, change.path).split(sep).join("/"),
	)
	ui.info(
		`Updated ${files.length} ${files.length === 1 ? "file" : "files"}. See DEPLOYMENT.md for build and deployment steps.`,
	)
	if (
		await ui.confirm(
			"commit",
			"Create a local Git commit with these changes?",
			false,
		)
	) {
		await commitReviewed(
			snapshot,
			plan.changes,
			"chore(deploy): configure Azure DevOps frontend deployment",
		)
		return { status: "committed", files, validation }
	}
	ui.info(
		"Changes are saved and unstaged. Edit the deployment files directly when you need to change the setup.",
	)
	return { status: "written", files, validation }
}
