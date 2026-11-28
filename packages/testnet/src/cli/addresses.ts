// addresses <deployment file> [--rehearse <manifest> | --rehearse-fork <url>]
// Prints every key's public address, so `expected` can be committed before any run signs. No network
// call and no file written; it checks only the deployment file: it parses and names the mode's chain.
import { addressesOf, l1AddressOf } from "../accounts"
import { assertTransport, GuardError, readKeys } from "../guards"
import { KEY_NAMES } from "../keyfile"
import { cliArgs, loadDeployment, main, report } from "./common"

await main(async () => {
	const { file, mode, rest } = cliArgs(process.argv.slice(2), {})
	if (rest.length > 0) throw new GuardError("argv", "addresses takes the deployment file alone")
	assertTransport(loadDeployment(file), mode, false)
	report("addresses", await addressesOf(KEY_NAMES, readKeys(KEY_NAMES, mode, { env: process.env }, l1AddressOf)))
	return 0
})
