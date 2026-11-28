// seed <deployment file> [--no-register | --recipient <address> | --demo] [--rehearse-fork <url>]
// Registers the canary owner's keystore and makes the canary deposit: a note of `amounts.note` whose
// wallet debit must equal `amounts.debit`, checked against the entrypoint's asset config and the owner's
// asset balance before anything is signed, and as the balance change after. On an operator target the
// pool is re-read against `operator` first. `--no-register` registers nothing and checks instead that
// the keystore already holds the owner under the keys its signature derives. With `--recipient`, the
// owner deposits that note for another address instead, which must already hold a registered viewing
// key; the owner's keystore is left as it is. `--demo` first registers the demo owner's keystore, signed
// and paid by the demo owner's own key, then deposits for it as `--recipient` does. Prints the label the
// ASP approves: the depositor is the canary owner every way. The pool's ASP must already be serving: the
// deposit encrypts its label to the key the ASP serves.
import type { SepoliaPoolUser } from "@pp/pp-env/sepolia"
import { type Address, erc20Abi, getAddress, type Hex, isAddress, isAddressEqual } from "viem"
import { l1AddressOf } from "../accounts"
import { GuardError, type Mode, readKeys } from "../guards"
import { RUN_KEYS } from "../keys"
import { SEPOLIA } from "../network"
import { checkOperator } from "../operator"
import type { TestnetDeployment } from "../schema"
import { checkDepositDebit } from "../verify"
import { cliArgs, guarded, logLine, main, report, sendLogPath } from "./common"
import { sendRpcOf } from "./wallet"

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

/** Refuses before any signature when the owner holds less of the asset than the deposit debits. */
function assertBalance(owner: Address, asset: Address, held: bigint, debit: bigint): void {
	if (held < debit)
		throw new GuardError("balance", `${owner} holds ${held} of ${asset}, ${debit - held} short of the deposit's debit ${debit}`)
}

/**
 * Registers `registrant`'s keystore, which refuses before sending when a half is already set under other
 * keys than its signature derives; with no registrant, `--no-register` checks the owner's registration.
 * @returns whether a registration ran, which may have sent transactions
 */
async function prepareKeystore(registrant: SepoliaPoolUser | undefined, owner: SepoliaPoolUser, noRegister: boolean): Promise<boolean> {
	if (registrant) {
		await registrant.registerKeystore()
		return true
	}
	if (noRegister) await owner.checkKeystore()
	return false
}

await main(async () => {
	const { file, mode, values } = cliArgs(process.argv.slice(2), {
		"no-register": { type: "boolean" },
		recipient: { type: "string" },
		demo: { type: "boolean" },
	})
	if (mode.kind === "rehearse")
		throw new GuardError("argv", "the local stack seeds through its own harness; seed runs live or on a Sepolia fork")
	const noRegister = values["no-register"] === true
	if ([noRegister, values.demo === true, values.recipient !== undefined].filter(Boolean).length > 1)
		throw new GuardError("argv", "--no-register, --recipient and --demo exclude each other")
	const { d, l1 } = await guarded(file, mode, ["expected", "pool"], false)
	await checkOperator(l1, d)
	const demo = values.demo ? demoOwnerOf(d.expected) : undefined
	const recipient = demo ?? recipientOf(values.recipient as string | undefined, d.expected.canaryOwner)
	const keys = signingKeys(d.expected, mode, demo)
	const owner = l1AddressOf(keys.owner)
	const { poolVault, entrypoint, keystore, aspRegistry, deployBlock, asset, aspApiUrl } = d.pool
	await checkDepositDebit(l1, entrypoint, asset, d.expected.amounts)
	const balance = () => l1.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [owner] })
	const before = await balance()
	assertBalance(owner, asset, before, d.expected.amounts.debit)
	// Past the guards: this entry loads the pool checkout, which a refusal must not need.
	const { sepoliaPoolUser } = await import("@pp/pp-env/sepolia")
	const userOf = (key: Hex) =>
		sepoliaPoolUser({
			rpcUrl: d.network.l1Rpc,
			sendRpcUrl: sendRpcOf(d),
			journalPath: sendLogPath(d, "seed", mode),
			chainId: SEPOLIA,
			deployment: { pool: poolVault, entrypoint, keystore, aspRegistry, deployBlock },
			aspUrl: aspApiUrl,
			key,
			circuitBundle: d.bundle,
		})
	const user = await userOf(keys.owner)
	const value = d.expected.amounts.note
	const registrant = keys.demo ? await userOf(keys.demo) : !recipient && !noRegister ? user : undefined
	// A registration takes blocks, and the SDK sizes its approval from the fee it reads next.
	if (await prepareKeystore(registrant, user, noRegister)) await checkDepositDebit(l1, entrypoint, asset, d.expected.amounts)
	const { label, commitment } = recipient ? await user.depositFor({ asset, value, recipient }) : await user.deposit({ asset, value })
	const debit = before - (await balance())
	report("seeded", { owner, recipient: recipient ?? owner, label, commitment, debit })
	if (debit !== d.expected.amounts.debit) {
		logLine(`the deposit debited ${debit}, the file expects ${d.expected.amounts.debit}`)
		return 1
	}
	return 0
})
