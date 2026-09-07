import * as clack from "@clack/prompts"
import { safeTerminal } from "./preview.ts"

export class Cancelled extends Error {
	constructor() {
		super("Setup cancelled.")
	}
}

export interface Choice<T extends string> {
	value: T
	label: string
	disabled?: boolean
	hint?: string
}

export interface UserInterface {
	text(
		id: string,
		message: string,
		initial?: string,
		validate?: (value: string) => string | undefined,
		placeholder?: string,
	): Promise<string>
	confirm(id: string, message: string, initial?: boolean): Promise<boolean>
	select<T extends string>(
		id: string,
		message: string,
		options: Choice<T>[],
		initial?: T,
	): Promise<T>
	multi(
		id: string,
		message: string,
		options: Choice<string>[],
		initial: string[],
	): Promise<string[]>
	info(message: string): void
	warn(message: string): void
}

async function answer<T>(result: Promise<T | symbol>): Promise<T> {
	const value = await result
	if (clack.isCancel(value)) throw new Cancelled()
	return value as T
}

export const terminalUI: UserInterface = {
	text: (_id, message, initial = "", validate, placeholder) =>
		answer(
			clack.text({
				message: safeTerminal(message),
				initialValue: safeTerminal(initial),
				placeholder:
					placeholder === undefined
						? undefined
						: safeTerminal(placeholder),
				validate: value => validate?.(value ?? ""),
			}),
		),
	confirm: (_id, message, initial = false) =>
		answer(clack.confirm({ message, initialValue: initial })),
	async select<T extends string>(
		_id: string,
		message: string,
		options: Choice<T>[],
		initial?: T,
	): Promise<T> {
		return (await answer(
			clack.select<string>({ message, options, initialValue: initial }),
		)) as T
	},
	multi: (_id, message, options, initial) =>
		answer(
			clack.multiselect({
				message,
				options,
				initialValues: initial,
				required: false,
			}),
		),
	info: message => clack.log.info(safeTerminal(message)),
	warn: message => clack.log.warn(safeTerminal(message)),
}
