// addresses <deployment file> <run>
// Prints the public addresses of one run's keys, so `expected` can be committed before any keyed run.
// No network call and no file written; it checks only the file and that the environment holds that
// run's variables and no other `PP_TESTNET_` one.
import { addressesOf, l1AddressOf } from "../accounts"
import { GuardError, readKeys } from "../guards"
import { type KeyedRun, RUN_KEYS } from "../keys"
import { cliArgs, loadDeployment, main, report } from "./common"

await main(async () => {
	const { file, mode, rest } = cliArgs(process.argv.slice(2), {})
	if (mode.kind !== "live") throw new GuardError("argv", "addresses derives a live template's addresses; a rehearsal has its own keys")
	loadDeployment(file)
	const [run, ...extra] = rest
	if (!run || extra.length > 0 || !(run in RUN_KEYS)) throw new GuardError("argv", `name one run: ${Object.keys(RUN_KEYS).join(", ")}`)
	const specs = RUN_KEYS[run as KeyedRun]
	const wanted = new Set(specs.map((s) => `PP_TESTNET_${s.name}`))
	const stray = Object.keys(process.env).filter((k) => k.startsWith("PP_TESTNET_") && !wanted.has(k))
	if (stray.length) throw new GuardError("keys", `variables outside the ${run} template are set: ${stray.join(", ")}`)
	report("addresses", { run, ...(await addressesOf(specs, readKeys(specs, mode, process.env, l1AddressOf))) })
	return 0
})
