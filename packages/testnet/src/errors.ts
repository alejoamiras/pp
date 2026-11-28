/** Refusals carry the guard's name, so a caller and a test can tell which check stopped the run. */
export class GuardError extends Error {
	override readonly name = "GuardError"
	constructor(
		readonly guard: string,
		detail: string,
	) {
		super(`${guard}: ${detail}`)
	}
}
