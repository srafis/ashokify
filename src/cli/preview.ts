import { createTwoFilesPatch } from "diff"
import type { FileChange } from "../planning/files.ts"

export function safeTerminal(value: string): string {
	return value.replace(
		/[\x00-\x08\x0b-\x1f\x7f]/g,
		character =>
			`\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
	)
}

function previewContent(path: string, content: string | null): string {
	let result = content ?? ""
	if (/(?:^|\/)\.env(?:\.|$)/.test(path)) {
		result = result.replace(
			/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=)(.*)$/gm,
			(_line, key, value: string) =>
				`${key}${value.includes("<set-") ? value : "<value redacted>"}`,
		)
	}
	result = result.replace(
		/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
		"<private key redacted>",
	)
	result = result.replace(
		/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g,
		"$1<credentials redacted>@",
	)
	result = result.replace(
		/((?:password|passwd|secret|access[_-]?token|auth[_-]?key|api[_-]?key|private[_-]?key)[\w-]*["']?\s*[:=]\s*)[^\r\n]+/gi,
		"$1<value redacted>",
	)
	return safeTerminal(result)
}

export function previewChange(change: FileChange): string {
	return createTwoFilesPatch(
		`a/${safeTerminal(change.relativePath)}`,
		`b/${safeTerminal(change.relativePath)}`,
		previewContent(change.relativePath, change.before),
		previewContent(change.relativePath, change.after),
		"",
		"",
		{ context: 3 },
	)
}
