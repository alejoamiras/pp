// open <deployment file> --factory <address>
// Opens entries with the guardian's own key once checkBeforeOpen passes on the file's expectations, and
// only while the guardian holds gas for this open and three pauses at twice today's fee estimate.
import { type GuardianWallet, openDeployedEntries } from "@pp/bridge-core/deploy"
import { PORTAL_FACTORY_ABI, PUBLIC_CHAIN_TIMING } from "@pp/bridge-core"
import { formatEther, isAddress, isAddressEqual } from "viem"
import { GuardError, readKeys } from "../guards"
import { RUN_KEYS } from "../keys"
import { journalTo } from "@pp/pp-env/send-path"
import { cliArgs, guarded, main, report, sendLogPath } from "./common"
import { assertOwnTarget, openContextOf } from "./context"
import { l1AddressOf } from "../accounts"
import { l1Wallet } from "./wallet"

/** Sends the guardian must be able to pay for before an open: the open and three pauses. */
const SENDS = 4n

await main(async () => {
	const { file, mode, values } = cliArgs(process.argv.slice(2), { factory: { type: "string" } })
	const { d, l1, node } = await guarded(file, mode, ["expected", "pool", "bridge"], true)
	assertOwnTarget(d)
	const factory = values.factory as string | undefined
	if (!factory || !isAddress(factory) || !isAddressEqual(factory, d.bridge.factory))
		throw new GuardError("factory", `--factory must be the file's factory ${d.bridge.factory}`)
	const { GUARDIAN_KEY } = readKeys(RUN_KEYS.open, mode, { env: process.env }, l1AddressOf)
	const guardian = l1Wallet(d, GUARDIAN_KEY as `0x${string}`, "guardian", d.expected.guardian, journalTo(sendLogPath(d, "open", mode)))
	const [gas, fees, balance] = await Promise.all([
		l1.estimateContractGas({
			address: d.bridge.factory,
			abi: PORTAL_FACTORY_ABI,
			functionName: "setEntriesPaused",
			args: [false],
			account: guardian.account,
		}),
		l1.estimateFeesPerGas(),
		l1.getBalance({ address: guardian.account.address }),
	])
	const need = SENDS * gas * fees.maxFeePerGas * 2n
	if (balance < need)
		throw new GuardError("gas", `the guardian holds ${formatEther(balance)} ETH, an open and three pauses need ${formatEther(need)}`)
	const hash = await openDeployedEntries(openContextOf(d, l1, node), guardian as unknown as GuardianWallet, {
		timing: PUBLIC_CHAIN_TIMING,
		onSigned: (s) => report("open-signed", { factory, nonce: s.nonce, hash: s.hash }),
	})
	report("opened", { factory, hash })
	return 0
})
