// seed <deployment file> [--rehearse-fork <url>]
// Registers the canary owner's keystore and makes the canary deposit: a note of `amounts.note` whose
// wallet debit must equal `amounts.debit`. Prints the label the ASP approves. The own pool's ASP must
// already be running: the deposit encrypts its label to the key the ASP serves.
import { sepoliaPoolUser } from "@pp/pp-env/sepolia"
import { erc20Abi, isAddressEqual } from "viem"
import { l1AddressOf } from "../accounts"
import { GuardError, readKeys } from "../guards"
import { RUN_KEYS } from "../keys"
import { SEPOLIA } from "../network"
import { assertOwnTarget } from "./context"
import { cliArgs, guarded, main, report } from "./common"

await main(async () => {
	const { file, mode, values } = cliArgs(process.argv.slice(2), { "no-register": { type: "boolean" } })
	if (mode.kind === "rehearse")
		throw new GuardError("argv", "the local stack seeds through its own harness; seed runs live or on a Sepolia fork")
	if (values["no-register"])
		throw new GuardError("operator", "--no-register checks an operator app's registration, which this build does not have yet")
	const { d, l1 } = await guarded(file, mode, ["expected", "pool"], false)
	assertOwnTarget(d)
	const key = readKeys(RUN_KEYS.seed, mode, { env: process.env }, l1AddressOf).CANARY_OWNER_KEY as `0x${string}`
	const owner = l1AddressOf(key)
	if (!isAddressEqual(owner, d.expected.canaryOwner))
		throw new GuardError("account", `the owner key is for ${owner}, the file expects ${d.expected.canaryOwner}`)
	const { poolVault, entrypoint, keystore, aspRegistry, deployBlock, asset, aspApiUrl } = d.pool
	const user = await sepoliaPoolUser({
		rpcUrl: d.network.l1Rpc,
		chainId: SEPOLIA,
		deployment: { pool: poolVault, entrypoint, keystore, aspRegistry, deployBlock },
		aspUrl: aspApiUrl,
		key,
		circuitBundle: d.bundle,
	})
	const balance = () => l1.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [owner] })
	const before = await balance()
	await user.registerKeystore()
	const { label, commitment } = await user.deposit({ asset, value: d.expected.amounts.note })
	const debit = before - (await balance())
	report("seeded", { owner, label, commitment, debit })
	if (debit !== d.expected.amounts.debit) {
		process.stderr.write(`the deposit debited ${debit}, the file expects ${d.expected.amounts.debit}\n`)
		return 1
	}
	return 0
})
