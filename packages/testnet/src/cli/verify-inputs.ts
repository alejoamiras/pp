// verify-inputs <deployment file>
// Loads no key. Checks, in order: the deployment file and its pinned endpoints, a clean working tree
// (its line names the HEAD commit), the frozen lockfile, the forge binary's digest (PP_FORGE or PATH),
// FFI off, a forced bridge build against its pins, the own pool's pins or an operator's pool against its
// `operator` block, the L2 class ids, and both endpoints' reads. Prints one line per check; exits 1 if any fails.
import { assertTransport, GuardError } from "../guards"
import {
	type CheckResult,
	checkBuild,
	checkClassIds,
	checkFfi,
	checkForge,
	checkLockfile,
	checkPoolPins,
	checkTree,
	probeL1,
	probeNode,
	resolveForge,
} from "../inputs"
import { checkOperator } from "../operator"
import type { TestnetDeployment } from "../schema"
import { clientsOf, cliArgs, loadDeployment, main, report } from "./common"

/** An operator's pool against the file's `operator` block, as every signing command will re-read it. */
async function operatorPins(l1: Parameters<typeof checkOperator>[0], d: TestnetDeployment): Promise<CheckResult> {
	try {
		if (!d.pool) return { name: "operator", ok: false, detail: "the file has no pool section" }
		return { name: "operator", ok: true, detail: `matches at block ${await checkOperator(l1, { ...d, pool: d.pool })}` }
	} catch (e) {
		return { name: "operator", ok: false, detail: e instanceof Error ? e.message : String(e) }
	}
}

await main(async () => {
	const { file, mode, rest } = cliArgs(process.argv.slice(2), {})
	if (mode.kind !== "live" || rest.length > 0)
		throw new GuardError("argv", "verify-inputs takes the deployment file alone and checks live inputs")
	const d = loadDeployment(file)
	assertTransport(d, mode, true)
	const forge = resolveForge(process.env)
	const results: CheckResult[] = [checkTree(), checkLockfile(), checkForge(forge)]
	if (forge && results.every((r) => r.ok)) results.push(checkFfi(forge), checkBuild(forge))
	if (d.target === "own") results.push(checkPoolPins())
	const { l1, node } = clientsOf(d)
	if (d.target !== "own") results.push(await operatorPins(l1, d))
	results.push(await checkClassIds())
	results.push(await probeL1(l1, d), await probeNode(node() as never, d))
	for (const r of results) report("check", r)
	return results.every((r) => r.ok) ? 0 : 1
})
