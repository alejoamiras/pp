// fund <deployment file> [--quote] [--rehearse-fork <url>]
// Tops each address in `expected` up to the summed gas budgets of its roles at twice today's fee, from
// the L1 deployer, the one address the owner funds. `--quote` loads no key and sends nothing: it prints
// what the deployer must hold, the top-ups' own gas included, and whether the plan fits FUNDING_LIMITS
// (at most 0.8 ETH spent, at least 1.0 ETH kept). A live run refuses a plan that does not, before reading
// its key, and checks the deployer's live balance against them again before each send. A fork run funds
// fresh keys from the fork's own ETH, so the limits only show in its quote.
import { journalTo } from "@pp/pp-env/send-path"
import { type Address, formatEther, type PublicClient } from "viem"
import { l1AddressOf } from "../accounts"
import { assertTopUp, assertWithinLimits, fundingPlan, limitBreach, type Plan, recipientsOf } from "../funding"
import { GuardError, readKeys } from "../guards"
import { RUN_KEYS } from "../keys"
import { cliArgs, guarded, main, report, sendLogPath } from "./common"
import { l1Sender } from "./wallet"

/** A top-up the send endpoint took must show on the read endpoint by then, or the run stops. */
const VISIBLE_WITHIN_MS = 60_000
const sleep = (ms: number) => new Promise<undefined>((r) => setTimeout(() => r(undefined), ms).unref())

type Run = {
	l1: PublicClient
	sender: ReturnType<typeof l1Sender>
	deployer: Address
	/** The deployer's balance when the plan was made; `undefined` skips the live limits. */
	limitsFrom: bigint | undefined
	maxFeePerGas: bigint
}

/** Sends the plan's top-ups one at a time, each shown on the read endpoint and landed before the next. */
async function sendTopUps(plan: Plan, r: Run): Promise<void> {
	const { wallet, path } = r.sender
	let sent = 0n
	for (const s of plan.sends) {
		const roles = s.roles.join(" ")
		if (s.amount === 0n) {
			report("funded", { roles, address: s.address, balanceBefore: s.balance, sent: 0n })
			continue
		}
		if (r.limitsFrom !== undefined) {
			const now = await r.l1.getBalance({ address: r.deployer })
			assertWithinLimits({ start: r.limitsFrom, now, sent, amount: s.amount, gasCost: s.transferGas * r.maxFeePerGas })
		}
		const hash = await wallet.sendTransaction({ to: s.address, value: s.amount, chain: wallet.chain })
		sent += s.amount
		const accepted = Date.now()
		const visibleMs = await Promise.race([path.visible(hash), sleep(VISIBLE_WITHIN_MS)])
		if (visibleMs === undefined)
			throw new Error(`the top-up ${hash} to ${s.address} did not show on the read endpoint within ${VISIBLE_WITHIN_MS / 1000} s`)
		assertTopUp(await r.l1.waitForTransactionReceipt({ hash, timeout: 600_000 }), hash, r.deployer)
		report("funded", {
			roles,
			address: s.address,
			balanceBefore: s.balance,
			sent: s.amount,
			txHash: hash,
			visibleS: (visibleMs / 1000).toFixed(1),
			receiptS: ((Date.now() - accepted) / 1000).toFixed(1),
		})
	}
}

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
	const topUps = plan.sends.reduce((t, s) => t + s.amount, 0n)
	const breach = limitBreach({ start: deployerBalance, now: deployerBalance, sent: 0n, amount: topUps, gasCost: plan.transferGas })
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
		topUps,
		limits: breach ? `exceeded: ${breach}` : "within",
	})
	if (values.quote) return 0
	if (short > 0n) throw new GuardError("funds", `the deployer ${deployer} needs ${formatEther(short)} ETH more before funding`)
	const live = mode.kind === "live"
	if (live && breach) throw new GuardError("funds", breach)
	const { L1_DEPLOYER_KEY } = readKeys(RUN_KEYS.fund, mode, { env: process.env }, l1AddressOf)
	const sender = l1Sender(d, L1_DEPLOYER_KEY as `0x${string}`, "L1 deployer", deployer, journalTo(sendLogPath(d, "fund", mode)))
	try {
		await sendTopUps(plan, { l1, sender, deployer, limitsFrom: live ? deployerBalance : undefined, maxFeePerGas: fees.maxFeePerGas })
	} finally {
		sender.path.close()
	}
	return 0
})
