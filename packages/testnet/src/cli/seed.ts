// seed <deployment file> [--recipient <address>] [--rehearse-fork <url>]
// Registers the canary owner's keystore and makes the canary deposit: a note of `amounts.note` whose
// wallet debit must equal `amounts.debit`. With `--recipient`, the owner deposits that note for another
// address instead, which must already hold a registered viewing key; the owner's keystore is left as it
// is. Prints the label the ASP approves: the depositor is the canary owner either way. The own pool's
// ASP must already be running: the deposit encrypts its label to the key the ASP serves.
import { sepoliaPoolUser } from "@pp/pp-env/sepolia"
import { type Address, erc20Abi, getAddress, isAddress, isAddressEqual } from "viem"
import { l1AddressOf } from "../accounts"
import { GuardError, readKeys } from "../guards"
import { RUN_KEYS } from "../keys"
import { SEPOLIA } from "../network"
import { cliArgs, guarded, logLine, main, report } from "./common"
import { assertOwnTarget } from "./context"

/** `--recipient`, checksummed; never the owner, whose own deposit is the canary path. */
function recipientOf(value: string | undefined, owner: Address): Address | undefined {
	if (value === undefined) return undefined
	if (!isAddress(value, { strict: false })) throw new GuardError("argv", "--recipient takes an address")
	if (isAddressEqual(value, owner)) throw new GuardError("argv", "--recipient is the canary owner; leave it out for the canary deposit")
	return getAddress(value)
}

await main(async () => {
	const { file, mode, values } = cliArgs(process.argv.slice(2), {
		"no-register": { type: "boolean" },
		recipient: { type: "string" },
	})
	if (mode.kind === "rehearse")
		throw new GuardError("argv", "the local stack seeds through its own harness; seed runs live or on a Sepolia fork")
	if (values["no-register"])
		throw new GuardError("operator", "--no-register checks an operator app's registration, which this build does not have yet")
	const { d, l1 } = await guarded(file, mode, ["expected", "pool"], false)
	assertOwnTarget(d)
	const recipient = recipientOf(values.recipient as string | undefined, d.expected.canaryOwner)
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
	const value = d.expected.amounts.note
	if (!recipient) await user.registerKeystore()
	const { label, commitment } = recipient ? await user.depositFor({ asset, value, recipient }) : await user.deposit({ asset, value })
	const debit = before - (await balance())
	report("seeded", { owner, recipient: recipient ?? owner, label, commitment, debit })
	if (debit !== d.expected.amounts.debit) {
		logLine(`the deposit debited ${debit}, the file expects ${d.expected.amounts.debit}`)
		return 1
	}
	return 0
})
