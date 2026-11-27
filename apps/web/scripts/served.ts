/** Probes for a server this package starts, shared by both modes of `test:headers`. */
import { setTimeout as sleep } from "node:timers/promises"
import type { Group } from "./proc"

export const START_TIMEOUT_MS = 30_000

export async function answers(port: number): Promise<boolean> {
	try {
		await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) })
		return true
	} catch {
		return false
	}
}

/** Resolves once the server answers; rejects if it exits or stays silent past the timeout. */
export async function untilUp(name: string, port: number, g: Group): Promise<void> {
	let exited = false
	void g.exited.then(() => {
		exited = true
	})
	const deadline = Date.now() + START_TIMEOUT_MS
	while (Date.now() < deadline) {
		if (exited) throw new Error(`${name} exited before answering:\n${g.output()}`)
		if (await answers(port)) return
		await sleep(200)
	}
	throw new Error(`${name} did not answer within ${START_TIMEOUT_MS} ms:\n${g.output()}`)
}

/** The reply to `path` and its body, once every header in `expected` is checked. */
export async function assertServed(
	name: string,
	port: number,
	path: string,
	expected: Readonly<Record<string, string>>,
): Promise<{ res: Response; body: ArrayBuffer }> {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { accept: "text/html,*/*" } })
	const body = await res.arrayBuffer()
	const wrong = Object.entries(expected).filter(([header, value]) => res.headers.get(header) !== value)
	if (wrong.length > 0) throw new Error(`${name} ${path} (HTTP ${res.status}): wrong or missing ${wrong.map(([n]) => n).join(", ")}`)
	console.log(`ok   ${name} ${path} (HTTP ${res.status}) carries all ${Object.keys(expected).length} headers`)
	return { res, body }
}

/** `g` must exit non-zero without ever answering, and its output must name `reason`. */
export async function assertRefusal(g: Group, port: number, what: string, reason: string): Promise<void> {
	try {
		const code = await Promise.race([g.exited, sleep(START_TIMEOUT_MS, "timeout" as const, { ref: false })])
		if (code === 0 || code === "timeout") throw new Error(`${what} did not fail to start (${code})`)
		if (await answers(port)) throw new Error(`${what} still answers on :${port}`)
		if (!g.output().includes(reason)) throw new Error(`${what} failed for another reason:\n${g.output()}`)
		console.log(`ok   ${what}: refuses to start (exit ${code})`)
	} finally {
		await g.stop()
	}
}
