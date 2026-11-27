import { AttachRefused, refuseAttach } from "./attach.ts"
import { newRunId } from "./run-dir.ts"

const USAGE = "usage: bun run demo [--keep]"
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const

type StepLine = { step: string; seconds: number }

/** The slice of a booted stack the CLI prints and stops. */
export type CliStack = {
	manifestPath: string
	manifest: { l1Rpc: string; aztecNode: string }
	seeded: { user: string; sender: string }
	/** pp-env's checkout supplies the circuits; a server of the proving files reads this line. */
	pool: { clientConfig: { circuitsDir: string } }
	stop(): Promise<void>
}

export type CliDeps = {
	startStack(o: { runId: string; signal: AbortSignal; onStep: (s: StepLine) => void }): Promise<CliStack>
	newRunId(): string
	env: Record<string, string | undefined>
	log(line: string): void
	error(line: string): void
	/** Installs one persistent handler for SIGINT, SIGTERM and SIGHUP; it stays for the process's life. */
	onSignal(handler: (signal: string) => void): void
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Parses `demo [--keep]`; undefined for anything else. */
export function parseArgs(args: readonly string[]): { keep: boolean } | undefined {
	const [command, ...flags] = args
	if (command !== "demo" || flags.some((f) => f !== "--keep")) return undefined
	return { keep: flags.includes("--keep") }
}

/**
 * Boots a stack and prints how to reach it. Exit codes: 0 after a clean run without `--keep`, 130
 * after a signal, 2 for bad arguments or set attach variables, 1 for a failed boot or teardown.
 * A signal during boot latches an abort that takes effect once the current step returns.
 */
export async function runCli(args: readonly string[], deps: CliDeps): Promise<number> {
	const parsed = parseArgs(args)
	if (!parsed) {
		deps.error(USAGE)
		return 2
	}
	try {
		refuseAttach(deps.env)
	} catch (err) {
		deps.error(`[stack] ${message(err)}`)
		return 2
	}
	const runId = deps.newRunId()
	deps.log(`[stack] run ${runId} pid ${process.pid}`)
	const abort = new AbortController()
	const { promise: signalled, resolve } = Promise.withResolvers<string>()
	deps.onSignal((signal) => {
		deps.log(`[stack] ${signal}: stopping once the current step returns`)
		if (abort.signal.aborted) return
		abort.abort(new Error(`${signal} received`))
		resolve(signal)
	})
	const t0 = performance.now()
	let stack: CliStack
	try {
		stack = await deps.startStack({
			runId,
			signal: abort.signal,
			onStep: (s) => deps.log(`[stack] ${s.step} up in ${s.seconds.toFixed(1)} s`),
		})
	} catch (err) {
		deps.error(`[stack] ${abort.signal.aborted ? "boot stopped" : "boot failed"}: ${message(err)}`)
		return abort.signal.aborted ? 130 : err instanceof AttachRefused ? 2 : 1
	}
	// Before the ready line, so a reader that sees ready has already seen this.
	deps.log(`[stack] circuits ${stack.pool.clientConfig.circuitsDir}`)
	deps.log(`[stack] ready in ${((performance.now() - t0) / 1000).toFixed(1)} s — PP_STACK_MANIFEST=${stack.manifestPath}`)
	deps.log(`[stack] pool user ${stack.seeded.user} (two approved notes of 100); bridge sender ${stack.seeded.sender}`)
	deps.log(`SANDBOX_L1_RPC=${stack.manifest.l1Rpc} SANDBOX_NODE_URL=${stack.manifest.aztecNode}`)
	if (parsed.keep) await signalled
	try {
		await stack.stop()
	} catch (err) {
		deps.error(`[stack] teardown failed: ${message(err)}`)
		return 1
	}
	return abort.signal.aborted ? 130 : 0
}

if (import.meta.main) {
	const code = await runCli(process.argv.slice(2), {
		// Loaded on first use, so bad arguments and attach variables exit 2 even where the harnesses cannot load.
		startStack: async (o) => (await import("./stack.ts")).startStack(o),
		newRunId,
		env: process.env,
		log: (line) => console.log(line),
		error: (line) => console.error(line),
		onSignal: (handler) => {
			for (const signal of SIGNALS) process.on(signal, () => handler(signal))
		},
	})
	process.exit(code)
}
