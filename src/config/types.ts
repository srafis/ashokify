export type PackageManager = "npm" | "pnpm" | "yarn" | "bun"

export interface DeploymentConfig {
	schemaVersion: 1
	templateVersion: 1
	application: { directory: string; name: string; id: string }
	build: {
		recipe: "vite-static"
		packageManager: PackageManager
		packageManagerVersion: string
		lockfile: string
		nodeConstraint?: string
		nodeVersion: string
		command: string
		outputDirectory: string
		architecture: "linux/amd64" | "linux/arm64"
	}
	pipeline: { provider: "azure-devops"; registryConnection: string }
	registry: { hostname: string; repository: string }
	environments: Array<{
		branch: string
		id: string
		publicFile: string
		secureFile?: string
		hostConnection?: string
	}>
	serving:
		| { mode: "artifact"; destination: string }
		| {
				mode: "container"
				image: string
				command: string[]
				assetPath: string
				containerPort: number
				hostPort?: number
				network?: string
				nginx?: {
					spaFallback: boolean
					proxyPath?: string
					proxyTarget?: string
				}
		  }
	frontendVariables: string[]
	connectivity: { tailscaleSecureFile?: string }
}

export interface ProjectFacts {
	directory: string
	name: string
	packageManager?: PackageManager
	packageManagerVersion?: string
	lockfile?: string
	packageManagerCandidates: PackageManager[]
	nodeConstraint?: string
	nodeVersion?: string
	buildCommand?: string
	outputDirectory: string
	staticStatus: "supported" | "ambiguous" | "unsupported"
	staticBuildIssue?: string
	evidence: string[]
	warnings: string[]
	frontendVariables: string[]
}

export type GeneratedFiles = Record<string, string>

export interface ValidationResult {
	name: string
	status: "passed" | "failed" | "not-run"
	detail: string
}
