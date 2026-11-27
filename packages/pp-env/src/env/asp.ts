/**
 * Bun 1.4.2's `closeAllConnections()` also stops the listener (Node's does not), so the mock ASP's
 * `stop()` then fails in `close()` although its port is already free. Accepted only once the port refuses.
 */
export async function stopAsp(asp: { url: string; stop(): Promise<void> }): Promise<void> {
	try {
		await asp.stop()
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") throw err
		if (
			await fetch(asp.url).then(
				() => true,
				() => false,
			)
		)
			throw err
	}
}
