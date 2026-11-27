/** `vite` on a port claimed from the host registry, in its own group; the claim and the group end together. */
import { claimPort } from "./ports"
import { bunRun } from "./proc"

const { port, release } = await claimPort("dev")
const vite = bunRun(["vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort", ...process.argv.slice(2)])

// A signal and vite's own exit can both arrive; each waits for the one cleanup before exiting.
let cleanup: Promise<void> | undefined
async function shutdown(code: number): Promise<never> {
	cleanup ??= vite.stop().then(release)
	await cleanup
	process.exit(code)
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void shutdown(130))
void shutdown((await vite.exited) ?? 1)
