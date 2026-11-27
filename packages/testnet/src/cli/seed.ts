// seed <deployment file> [--recipient <address> | --demo] [--rehearse-fork <url>]
// Registers the canary owner's keystore and makes the canary deposit: a note of `amounts.note` whose
// wallet debit must equal `amounts.debit`, checked against the entrypoint's asset config before anything
// is signed and as the balance change after. With `--recipient`, the owner deposits that note for
// another address instead, which must already hold a registered viewing key; the owner's keystore is
// left as it is. `--demo` first registers the demo owner's keystore, signed and paid by the demo owner's
// own key, then deposits for it as `--recipient` does. Prints the label the ASP approves: the depositor
// is the canary owner every way. The own pool's ASP must already be running: the deposit encrypts its
// label to the key the ASP serves.
import { type Address, erc20Abi, getAddress, type Hex, isAddress, isAddressEqual } from "viem"
import { l1AddressOf } from "../accounts"
import { GuardError, type Mode, readKeys } from "../guards"
import { RUN_KEYS } from "../keys"
import { SEPOLIA } from "../network"
import type { TestnetDeployment } from "../schema"
import { checkDepositDebit } from "../verify"
import { cliArgs, guarded, logLine, main, report } from "./common"
import { assertOwnTarget } from "./context"

type Expected = NonNullable<TestnetDeployment["expected"]>

/** `--recipient`, checksummed; never the owner, whose own deposit is the canary path. */
function recipientOf(value: string | undefined, owner: Address): Address | undefined {
	if (value === undefined) return undefined
	if (!isAddress(value, { strict: false })) throw new GuardError("argv", "--recipient takes an address")
	if (isAddressEqual(value, owner)) throw new GuardError("argv", "--recipient is the canary owner; leave it out for the canary deposit")
	return getAddress(value)
}

/** The file's demo owner, which must be its own account: a deposit for the canary owner would join the canary's notes. */
function demoOwnerOf(e: Expected): Address {
	if (!e.demoOwner) throw new GuardError("file", "--demo needs expected.demoOwner; commit it from `addresses`")
	if (isAddressEqual(e.demoOwner, e.canaryOwner)) throw new GuardError("file", "expected.demoOwner is the canary owner")
	return e.demoOwner
}

/** The keys this run signs with, each checked against the address the file commits. */
function signingKeys(e: Expected, mode: Mode, demo: Address | undefined): { owner: Hex; demo?: Hex } {
	const keys = readKeys(demo ? RUN_KEYS["seed-demo"] : RUN_KEYS.seed, mode, { env: process.env }, l1AddressOf)
	const owner = keys.CANARY_OWNER_KEY as Hex
	if (!isAddressEqual(l1AddressOf(owner), e.canaryOwner))
		throw new GuardError("account", `the owner key is for ${l1AddressOf(owner)}, the file expects ${e.canaryOwner}`)
	if (!demo) return { owner }
	const demoKey = keys.DEMO_OWNER_KEY as Hex
	if (!isAddressEqual(l1AddressOf(demoKey), demo))
		throw new GuardError("account", `the demo owner key is for ${l1AddressOf(demoKey)}, the file expects ${demo}`)
	return { owner, demo: demoKey }
}

await main(async () => {
	const { file, mode, values } = cliArgs(process.argv.slice(2), {
		"no-register": { type: "boolean" },
		recipient: { type: "string" },
		demo: { type: "boolean" },
	})
	if (mode.kind === "rehearse")
		throw new GuardError("argv", "the local stack seeds through its own harness; seed runs live or on a Sepolia fork")
	if (values["no-register"])
		throw new GuardError("operator", "--no-register checks an operator app's registration, which this build does not have yet")
	if (values.demo && values.recipient !== undefined) throw new GuardError("argv", "--demo and --recipient exclude each other")
	const { d, l1 } = await guarded(file, mode, ["expected", "pool"], false)
	assertOwnTarget(d)
	const demo = values.demo ? demoOwnerOf(d.expected) : undefined
	const recipient = demo ?? recipientOf(values.recipient as string | undefined, d.expected.canaryOwner)
	const keys = signingKeys(d.expected, mode, demo)
	const owner = l1AddressOf(keys.owner)
	const { poolVault, entrypoint, keystore, aspRegistry, deployBlock, asset, aspApiUrl } = d.pool
	await checkDepositDebit(l1, entrypoint, asset, d.expected.amounts)
	// Past the guards: this entry loads the pool checkout, which a refusal must not need.
	const { sepoliaPoolUser } = await import("@pp/pp-env/sepolia")
	const userOf = (key: Hex) =>
		sepoliaPoolUser({
			rpcUrl: d.network.l1Rpc,
			chainId: SEPOLIA,
			deployment: { pool: poolVault, entrypoint, keystore, aspRegistry, deployBlock },
			aspUrl: aspApiUrl,
			key,
			circuitBundle: d.bundle,
		})
	const user = await userOf(keys.owner)
	const balance = () => l1.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [owner] })
	const before = await balance()
	const value = d.expected.amounts.note
	if (keys.demo) await (await userOf(keys.demo)).registerKeystore()
	else if (!recipient) await user.registerKeystore()
	// A registration takes blocks, and the SDK sizes its approval from the fee it reads next.
	if (keys.demo || !recipient) await checkDepositDebit(l1, entrypoint, asset, d.expected.amounts)
	const { label, commitment } = recipient ? await user.depositFor({ asset, value, recipient }) : await user.deposit({ asset, value })
	const debit = before - (await balance())
	report("seeded", { owner, recipient: recipient ?? owner, label, commitment, debit })
	if (debit !== d.expected.amounts.debit) {
		logLine(`the deposit debited ${debit}, the file expects ${d.expected.amounts.debit}`)
		return 1
	}
	return 0
})
