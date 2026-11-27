// fund <deployment file> [--quote] [--rehearse-fork <url>]
// Tops each address in `expected` up to the summed gas budgets of its roles at twice today's fee, from
// the L1 deployer, the one address the owner funds. `--quote` loads no key and sends nothing: it prints
// what the deployer must hold, the top-ups' own gas included. Before each send the deployer's live
// balance must keep the run within FUNDING_LIMITS: at most 0.8 ETH spent, at least 1.0 ETH kept.
import { journalTo } from "@pp/pp-env/send-path"
import { formatEther } from "viem"
import { l1AddressOf } from "../accounts"
import { assertTopUp, assertWithinLimits, fundingPlan, recipientsOf } from "../funding"
import { GuardError, readKeys } from "../guards"
import { RUN_KEYS } from "../keys"
import { cliArgs, guarded, main, report, sendLogPath } from "./common"
import { l1Sender } from "./wallet"

/** A top-up the send endpoint took must show on the read endpoint by then, or the run stops. */
const VISIBLE_WITHIN_MS = 60_000
const sleep = (ms: number) => new Promise<undefined>((r) => setTimeout(() => r(undefined), ms).unref())

await main(async () => {
	const { file, mode, values } = cliArgs(process.argv.slice(2), { quote: { type: "boolean" } })
	if (mode.kind === "rehearse")
		throw new GuardError("argv", "the local stack's anvil accounts are funded; fund runs live or on a Sepolia fork")
	const { d, l1 } = await guarded(file, mode, ["expected"], false)
	const deployer = d.expected.l1Deployer
	const recipients = recipientsOf(d.expected)
	const [fees, deployerBalance, ...balances] = await Promise.all([
		l1.estimateFeesPerGas(),
		l1.getBalance({ address: deployer }),
		...recipients.map((r) => l1.getBalance({ address: r.address })),
	])
	// A nonzero value, so a transfer to an account that does not exist yet is priced as the one creating it.
	const transferGas = await Promise.all(recipients.map((r) => l1.estimateGas({ account: deployer, to: r.address, value: 1n })))
	const plan = fundingPlan(
		deployer,
		recipients.map((r, i) => ({ ...r, balance: balances[i] as bigint, transferGas: transferGas[i] as bigint })),
		fees.maxFeePerGas,
	)
	const short = plan.total > deployerBalance ? plan.total - deployerBalance : 0n
	for (const s of plan.sends)
		report("funding-need", { roles: s.roles.join(","), address: s.address, balance: s.balance, need: s.need, topUp: s.amount })
	report("funding-quote", {
		deployer,
		deployerBalance,
		deployerNeed: plan.deployerNeed,
		total: plan.total,
		transferGas: plan.transferGas,
		short,
		shortEth: formatEther(short),
	})
	if (values.quote) return 0
	if (short > 0n) throw new GuardError("funds", `the deployer ${deployer} needs ${formatEther(short)} ETH more before funding`)
	const { L1_DEPLOYER_KEY } = readKeys(RUN_KEYS.fund, mode, { env: process.env }, l1AddressOf)
	const journal = journalTo(sendLogPath(d, "fund", mode))
	const { wallet, path } = l1Sender(d, L1_DEPLOYER_KEY as `0x${string}`, "L1 deployer", deployer, journal)
	let sent = 0n
	try {
		for (const s of plan.sends) {
			const roles = s.roles.join(" ")
			if (s.amount === 0n) {
				report("funded", { roles, address: s.address, balanceBefore: s.balance, sent: 0n })
				continue
			}
			const now = await l1.getBalance({ address: deployer })
			assertWithinLimits({ start: deployerBalance, now, sent, amount: s.amount, gasCost: s.transferGas * fees.maxFeePerGas })
			const hash = await wallet.sendTransaction({ to: s.address, value: s.amount, chain: wallet.chain })
			sent += s.amount
			const accepted = Date.now()
			const visibleMs = await Promise.race([path.visible(hash), sleep(VISIBLE_WITHIN_MS)])
			if (visibleMs === undefined)
				throw new Error(`the top-up ${hash} to ${s.address} did not show on the read endpoint within ${VISIBLE_WITHIN_MS / 1000} s`)
			assertTopUp(await l1.waitForTransactionReceipt({ hash, timeout: 600_000 }), hash, deployer)
			const receiptS = ((Date.now() - accepted) / 1000).toFixed(1)
			report("funded", {
				roles,
				address: s.address,
				balanceBefore: s.balance,
				sent: s.amount,
				txHash: hash,
				visibleS: (visibleMs / 1000).toFixed(1),
				receiptS,
			})
		}
	} finally {
		path.close()
	}
	return 0
})
