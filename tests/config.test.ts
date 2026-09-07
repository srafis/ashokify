import { describe, expect, test } from "bun:test"

import {
	mapBranches,
	normalizeIdentifier,
	resolveNodeVersion,
	validateConfig,
} from "../src/config/index.ts"
import type { DeploymentConfig } from "../src/config/types.ts"

const validConfig = () => ({
	schemaVersion: 1,
	templateVersion: 1,
	application: { directory: ".", name: "portal", id: "portal" },
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
	pipeline: {
		provider: "azure-devops",
		registryConnection: "sifars.azurecr.io",
	},
	registry: { hostname: "sifars.azurecr.io", repository: "portal" },
	environments: [
		{ branch: "main", id: "main", publicFile: ".env.build.main" },
	],
	serving: { mode: "artifact", destination: "dist" },
	frontendVariables: ["VITE_API_URL"],
	connectivity: {},
})

describe("configuration helpers", () => {
	test("normalizes explicit head refs and rejects tag refs", () => {
		expect(
			mapBranches(["refs/heads/main", "main"]).map(
				environment => environment.branch,
			),
		).toEqual(["main"])
		expect(() => mapBranches(["refs/tags/v1"])).toThrow("must be a branch")
	})
	test("normalizes branch and project names into safe identifiers", () => {
		expect(normalizeIdentifier("Feature/Payments v2")).toBe(
			"feature-payments-v2",
		)
		expect(normalizeIdentifier("!!!")).toBe("")
		expect(mapBranches(["main", " feature/payments ", "main"])).toEqual([
			{ branch: "main", id: "main", publicFile: ".env.build.main" },
			{
				branch: "feature/payments",
				id: "feature-payments",
				publicFile: ".env.build.feature-payments",
			},
		])
	})

	test("rejects normalized branch collisions", () => {
		expect(() =>
			mapBranches(["feature/payments", "feature-payments"]),
		).toThrow(/environments/)
		expect(() => mapBranches(["feature/.lock"])).toThrow(/branch/)
		expect(() => mapBranches(["release/v1."])).toThrow(/branch/)
	})

	test("resolves Node 22 first and understands semver ranges", () => {
		expect(resolveNodeVersion()).toBe("22.23.2")
		expect(resolveNodeVersion(">=22")).toBe("22.23.2")
		expect(resolveNodeVersion("~22.23.0")).toBe("22.23.2")
		expect(resolveNodeVersion("^24.0.0")).toBe("24.20.0")
		expect(resolveNodeVersion(">=22.23.0 <23")).toBe("22.23.2")
		expect(resolveNodeVersion("22.23.2-beta.1 || >=22")).toBe("22.23.2")
		expect(() => resolveNodeVersion(">=25")).toThrow(/nodeConstraint/)
		expect(() => resolveNodeVersion("not-a-range")).toThrow(
			/nodeConstraint/,
		)
		expect(() => resolveNodeVersion("^20.0.0")).toThrow(/nodeConstraint/)
	})

	test("returns the validated configuration and reports field-specific security errors", () => {
		expect(validateConfig(validConfig()).build.nodeVersion).toBe("22.23.2")
		expect(() =>
			validateConfig({
				...validConfig(),
				application: {
					...validConfig().application,
					directory: "../other",
				},
			}),
		).toThrow(/application\.directory/)
		expect(() =>
			validateConfig({
				...validConfig(),
				build: {
					...validConfig().build,
					command: "pnpm run build; rm -rf /",
				},
			}),
		).toThrow(/build\.command/)
		expect(() =>
			validateConfig({
				...validConfig(),
				build: {
					...validConfig().build,
					lockfile: "../package-lock.json",
				},
			}),
		).toThrow(/build\.lockfile/)
		expect(() =>
			validateConfig({
				...validConfig(),
				environments: [
					{
						branch: "feature/.lock",
						id: "feature-lock",
						publicFile: ".env.build.feature-lock",
					},
				],
			}),
		).toThrow(/environments\[0\]\.branch/)
		expect(() =>
			validateConfig({
				...validConfig(),
				serving: { mode: "artifact", destination: "../outside" },
			}),
		).toThrow(/serving\.destination/)
	})

	test("accepts immutable container image digests", () => {
		const config = validConfig() as DeploymentConfig
		config.serving = {
			mode: "container",
			image: `sifars.azurecr.io/portal@sha256:${"a".repeat(64)}`,
			command: ["serve", "dist"],
			assetPath: "/usr/share/nginx/html",
			containerPort: 8080,
		}
		expect(validateConfig(config).serving.mode).toBe("container")
	})
})
