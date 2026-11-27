// verify-inputs <deployment file>
// Loads no key. Checks, in order: the deployment file and its pinned endpoints, the frozen lockfile, the
// forge binary's digest (PP_FORGE or PATH), FFI off, a forced bridge build against its pins, the own
// pool's pins, the L2 class ids, and both endpoints' reads. Prints one line per check; exits 1 if any fails.
import { assertTransport, GuardError } from "../guards"
import {
	type CheckResult,
	checkBuild,
	checkClassIds,
	checkFfi,
	checkForge,
	checkLockfile,
	checkPoolPins,
	probeL1,
	probeNode,
	resolveForge,
} from "../inputs"
import { clientsOf, cliArgs, loadDeployment, main, report } from "./common"

await main(async () => {
	const { file, mode, rest } = cliArgs(process.argv.slice(2), {})
	if (mode.kind !== "live" || rest.length > 0)
		throw new GuardError("argv", "verify-inputs takes the deployment file alone and checks live inputs")
	const d = loadDeployment(file)
	assertTransport(d, mode, true)
	const forge = resolveForge(process.env)
	const results: CheckResult[] = [checkLockfile(), checkForge(forge)]
	if (forge && results.every((r) => r.ok)) results.push(checkFfi(forge), checkBuild(forge))
	if (d.target === "own") results.push(checkPoolPins())
	results.push(await checkClassIds())
	const { l1, node } = clientsOf(d)
	results.push(await probeL1(l1, d), await probeNode(node() as never, d))
	for (const r of results) report("check", r)
	return results.every((r) => r.ok) ? 0 : 1
})
