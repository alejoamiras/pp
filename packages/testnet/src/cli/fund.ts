// fund <deployment file> [--quote] [--rehearse-fork <url>]
// Tops each address in `expected` up to the summed gas budgets of its roles at twice today's fee, from
// the L1 deployer, the one address the owner funds. Every balance is read at one block, which must hold
// every transaction of the deployer's either endpoint knows; else the run is refused, to be run again.
// `--quote` loads no key and sends nothing: it prints what the deployer must hold, the top-ups' own gas
// included, and whether the plan fits FUNDING_LIMITS (at most 0.8 ETH spent, at least 1.0 ETH kept). A
// live run refuses a plan that does not, before reading its key, and checks the deployer's live balance
// against them again before each send. A fork run funds fresh keys from the fork's own ETH, so the limits
// only show in its quote. Each top-up carries the gas limit and fee caps it was checked at, and the nonce
// the snapshot gives it, so a transaction that lands after the snapshot makes it fail rather than repeat.
import { journalTo } from "@pp/pp-env/send-log"
import { type Address, createPublicClient, formatEther, type PublicClient } from "viem"
import { l1AddressOf } from "../accounts"
import { fundingPlan, limitBreach, type Recipient, recipientsOf, type SnapshotCounts, staleSnapshot } from "../funding"
import { GuardError, readKeys } from "../guards"
import { RUN_KEYS } from "../keys"
import type { TestnetDeployment } from "../schema"
import { cliArgs, guarded, main, report, sendLogPath } from "./common"
import { sendTopUps } from "./top-ups"
import { l1Read, l1Sender, sendRpcOf } from "./wallet"

/**
 * Every balance the plan needs and the deployer's count, at one block, then the deployer's pending count
 * on each endpoint, read after it so a transaction that lands in between shows as pending.
 */
async function readState(d: TestnetDeployment, l1: PublicClient, deployer: Address, recipients: readonly Recipient[]) {
	const block = await l1.getBlockNumber()
	const at = { blockNumber: block }
	const [fees, deployerBalance, atSnapshot, ...balances] = await Promise.all([
		l1.estimateFeesPerGas(),
		l1.getBalance({ address: deployer, ...at }),
		l1.getTransactionCount({ address: deployer, ...at }),
		...recipients.map((r) => l1.getBalance({ address: r.address, ...at })),
	])
	const send = createPublicClient({ transport: l1Read(sendRpcOf(d)) })
	const [pendingRead, pendingSend] = await Promise.all(
		[l1, send].map((c) => c.getTransactionCount({ address: deployer, blockTag: "pending" })),
	)
	const counts: SnapshotCounts = { block, atSnapshot, pendingRead: pendingRead as number, pendingSend: pendingSend as number }
	return { fees, deployerBalance, balances: balances as bigint[], counts }
}

await main(async () => {
	const { file, mode, values } = cliArgs(process.argv.slice(2), { quote: { type: "boolean" } })
	if (mode.kind === "rehearse")
		throw new GuardError("argv", "the local stack's anvil accounts are funded; fund runs live or on a Sepolia fork")
	const { d, l1 } = await guarded(file, mode, ["expected"], false)
	const deployer = d.expected.l1Deployer
	const recipients = recipientsOf(d.expected)
	const { fees, deployerBalance, balances, counts } = await readState(d, l1, deployer, recipients)
	const stale = staleSnapshot(counts)
	// A nonzero value, so a transfer to an account that does not exist yet is priced as the one creating it.
	const transferGas = await Promise.all(recipients.map((r) => l1.estimateGas({ account: deployer, to: r.address, value: 1n })))
	const plan = fundingPlan(
		deployer,
		recipients.map((r, i) => ({ ...r, balance: balances[i] as bigint, transferGas: transferGas[i] as bigint })),
		fees.maxFeePerGas,
	)
	const short = plan.total > deployerBalance ? plan.total - deployerBalance : 0n
	const topUps = plan.sends.reduce((t, s) => t + s.amount, 0n)
	const breach = limitBreach({ start: deployerBalance, now: deployerBalance, sent: 0n, amount: topUps, gasCost: plan.transferGas })
	for (const s of plan.sends)
		report("funding-need", { roles: s.roles.join(","), address: s.address, balance: s.balance, need: s.need, topUp: s.amount })
	report("funding-quote", {
		deployer,
		deployerBalance,
		snapshotBlock: counts.block,
		snapshot: stale ? `stale: ${stale}` : "holds every known transaction",
		deployerNeed: plan.deployerNeed,
		total: plan.total,
		transferGas: plan.transferGas,
		short,
		shortEth: formatEther(short),
		topUps,
		limits: breach ? `exceeded: ${breach}` : "within",
	})
	if (values.quote) return 0
	if (stale) throw new GuardError("funds", stale)
	if (short > 0n) throw new GuardError("funds", `the deployer ${deployer} needs ${formatEther(short)} ETH more before funding`)
	const live = mode.kind === "live"
	if (live && breach) throw new GuardError("funds", breach)
	const { L1_DEPLOYER_KEY } = readKeys(RUN_KEYS.fund, mode, { env: process.env }, l1AddressOf)
	const sender = l1Sender(d, L1_DEPLOYER_KEY as `0x${string}`, "L1 deployer", deployer, journalTo(sendLogPath(d, "fund", mode)))
	try {
		const caps = { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }
		const limitsFrom = live ? deployerBalance : undefined
		await sendTopUps(plan, { l1, sender, deployer, limitsFrom, fees: caps, nonce: counts.atSnapshot })
	} finally {
		sender.path.close()
	}
	return 0
})
