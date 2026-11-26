/**
 * Stops what a boot started, newest first. Every step runs even when an earlier one fails, the
 * failures surface together, and a second `run` returns the first run's outcome.
 */
export class Teardown {
	private readonly steps: { name: string; stop: () => Promise<void> }[] = []
	private running?: Promise<void>

	push(name: string, stop: () => Promise<void>): void {
		if (this.running) throw new Error(`teardown already ran; cannot register ${name}`)
		this.steps.push({ name, stop })
	}

	run(): Promise<void> {
		this.running ??= this.runAll()
		return this.running
	}

	private async runAll(): Promise<void> {
		const failures: Error[] = []
		for (const { name, stop } of [...this.steps].reverse()) {
			try {
				await stop()
			} catch (err) {
				failures.push(new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`, { cause: err }))
			}
		}
		if (failures.length) throw new AggregateError(failures, `teardown failed in ${failures.map((f) => f.message).join("; ")}`)
	}
}
