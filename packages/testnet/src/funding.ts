import { type Address, formatEther, formatGwei, type Hex, isAddressEqual } from "viem"
import { GuardError } from "./errors"
import type { TestnetDeployment } from "./schema"

/**
 * Gas each L1 key spends over one target's runs, deploy to the last canary, at Prague prices: the
 * rehearsals run on anvil and fail when a key's measured spend exceeds its budget, so these are upper
 * bounds checked on every rehearsal. `fund` scales them by {@link LIVE_RATIO_PERCENT}.
 */
export const FUNDING_GAS = {
	l1Deployer: 8_000_000n,
	poolDeployer: 40_000_000n,
	aspPostman: 3_000_000n,
	guardian: 500_000n,
	canaryOwner: 5_000_000n,
	canarySender: 5_000_000n,
	// A canary's bridge-then-collect costs its sender about 1.05 M gas, so this is about four hand tests.
	demoSender: 5_000_000n,
	// Registration, then several approvals, deposits and a ragequit, all by hand.
	demoOwner: 5_000_000n,
} as const satisfies Record<string, bigint>

export type FundedRole = keyof typeof FUNDING_GAS

/**
 * Live Sepolia's gas over Prague's, in percent, for each kind of transaction a role sends, from the same
 * `eth_estimateGas` probes on the chain and on anvil 1.7.1 at `--hardfork prague` (2026-11-27): a
 * creation costs up to 7.67 times as much (a 24 KB runtime), a fresh storage slot 5.00 times. Sepolia's
 * fork since 2026-10-06 reprices state creation, which no rehearsal on this Foundry's anvil can show.
 */
export const LIVE_RATIO_PERCENT = { creation: 767n, freshSlot: 501n } as const

/** The kind of transaction that dominates each role's spend. */
const KIND_OF: Record<FundedRole, keyof typeof LIVE_RATIO_PERCENT> = {
	l1Deployer: "creation",
	poolDeployer: "creation",
	aspPostman: "freshSlot",
	guardian: "freshSlot",
	canaryOwner: "freshSlot",
	canarySender: "freshSlot",
	demoSender: "freshSlot",
	demoOwner: "freshSlot",
}

/** A role's budget in live gas: its Prague budget times its kind's live ratio, rounded up. */
export const liveGasOf = (role: FundedRole): bigint => (FUNDING_GAS[role] * LIVE_RATIO_PERCENT[KIND_OF[role]] + 99n) / 100n

/** Each budget is priced at twice the fee estimate when funded, so a fee spike mid-run still clears. */
export const FEE_MARGIN = 2n
/**
 * The lowest fee per gas a budget and forge's max fee are priced at, and forge's tip. Sepolia's estimate
 * sits near zero for hours, so a budget priced at it alone would fall short after a spike. As a tip,
 * 0.1 gwei was at or above the fifth-percentile tip of 1,015 of 1,024 Sepolia blocks to 2026-11-28.
 */
export const FEE_FLOOR_WEI = 100_000_000n
export type Recipient = { role: Exclude<FundedRole, "l1Deployer">; address: Address }

/** The keys `fund` tops up from the deployer: the file's committed addresses, never ones a key derives. */
export function recipientsOf(e: NonNullable<TestnetDeployment["expected"]>): Recipient[] {
	const out: Recipient[] = []
	if (e.poolDeployer) out.push({ role: "poolDeployer", address: e.poolDeployer })
	if (e.aspPostman) out.push({ role: "aspPostman", address: e.aspPostman })
	out.push(
		{ role: "guardian", address: e.guardian },
		{ role: "canaryOwner", address: e.canaryOwner },
		{ role: "canarySender", address: e.canarySender },
	)
	if (e.demoOwner) out.push({ role: "demoOwner", address: e.demoOwner })
	if (e.demoSender) out.push({ role: "demoSender", address: e.demoSender })
	// The schema refuses the zero address already; a top-up there would burn the deployer's ether.
	const zero = out.find((r) => /^0x0{40}$/.test(r.address))
	if (zero) throw new GuardError("fund", `${zero.role} is the zero address`)
	return out
}

/**
 * Fee caps for a forge script, matching what its budget was funded at: the max fee is the floored
 * estimate times the margin, so a base fee rising inside that margin strands nothing and no transaction
 * pays more per gas than the budget assumed; the tip is the floor.
 */
export const scriptFees = (maxFeePerGas: bigint): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } => ({
	maxFeePerGas: (maxFeePerGas > FEE_FLOOR_WEI ? maxFeePerGas : FEE_FLOOR_WEI) * FEE_MARGIN,
	maxPriorityFeePerGas: FEE_FLOOR_WEI,
})

/**
 * Why `deploy-pool` must not start: its budget at caps priced from the fee estimate `maxFeePerGas` costs
 * more than the pool deployer's `balance`, which `fund` tops up to that budget at its own estimate. After
 * a `fund` at an estimate under the floor, that is any estimate above the floor, or a balance spent since.
 */
export function feeAboveBudget(o: { maxFeePerGas: bigint; balance: bigint }): string | undefined {
	const need = needOf("poolDeployer", o.maxFeePerGas)
	if (o.balance >= need) return undefined
	return `the pool deployer holds ${formatEther(o.balance)} ETH, under the ${formatEther(need)} ETH its budget costs at the fee estimate of ${formatGwei(o.maxFeePerGas)} gwei; fund budgeted it at a lower fee, so wait for the estimate to fall and run again`
}

export const needOf = (role: FundedRole, maxFeePerGas: bigint): bigint =>
	liveGasOf(role) * (maxFeePerGas > FEE_FLOOR_WEI ? maxFeePerGas : FEE_FLOOR_WEI) * FEE_MARGIN

/** One top-up per address: roles that share an address share its balance, so their needs add up. */
export type Send = { roles: Recipient["role"][]; address: Address; balance: bigint; need: bigint; amount: bigint; transferGas: bigint }

/**
 * A recipient as the node sees it: its balance, and the node's gas estimate for a transfer to it, which on
 * Sepolia is about ten times a plain transfer's when the transfer creates the account.
 */
export type FundedRecipient = Recipient & { balance: bigint; transferGas: bigint }

export type Plan = { sends: Send[]; deployerNeed: bigint; transferGas: bigint; total: bigint }

/**
 * What each distinct address lacks of its roles' summed needs, and the total the deployer must hold: its
 * own need, every top-up, and each top-up's own gas estimate at `maxFeePerGas`. A role at the deployer's
 * own address adds to the deployer's need and gets no top-up.
 */
export function fundingPlan(deployer: Address, recipients: readonly FundedRecipient[], maxFeePerGas: bigint): Plan {
	let deployerNeed = needOf("l1Deployer", maxFeePerGas)
	const byAddress = new Map<string, Send>()
	for (const r of recipients) {
		const need = needOf(r.role, maxFeePerGas)
		const shared = byAddress.get(r.address.toLowerCase())
		if (isAddressEqual(r.address, deployer)) deployerNeed += need
		else if (shared) {
			shared.roles.push(r.role)
			shared.need += need
		} else {
			const { role, address, balance, transferGas } = r
			byAddress.set(address.toLowerCase(), { roles: [role], address, balance, need, amount: 0n, transferGas })
		}
	}
	const sends = [...byAddress.values()].map((s) => ({ ...s, amount: s.balance < s.need ? s.need - s.balance : 0n }))
	const transferGas = sends.reduce((t, s) => (s.amount > 0n ? t + s.transferGas * maxFeePerGas : t), 0n)
	return { sends, deployerNeed, transferGas, total: deployerNeed + transferGas + sends.reduce((t, s) => t + s.amount, 0n) }
}

/** The owner's limits for one live `fund` run: what it may send in top-ups, and what the L1 deployer keeps. */
export const FUNDING_LIMITS = { topUpsWei: 800_000_000_000_000_000n, deployerFloorWei: 1_000_000_000_000_000_000n } as const

export type SpendCheck = { start: bigint; now: bigint; sent: bigint; amount: bigint; gasCost: bigint }

/**
 * Why sending `amount`, at most `gasCost` in gas, would break {@link FUNDING_LIMITS}, or undefined when it
 * would not: the deployer's spending since the run began must stay within the top-up limit with it, and the
 * deployer must keep its floor after it. Spending is the fall of its live balance from `start`, or what the
 * run sent if that is more, so a top-up that landed after a wrong "not landed" verdict counts.
 */
export function limitBreach(o: SpendCheck): string | undefined {
	const fallen = o.start > o.now ? o.start - o.now : 0n
	const spent = fallen > o.sent ? fallen : o.sent
	if (spent + o.amount > FUNDING_LIMITS.topUpsWei)
		return `sending ${formatEther(o.amount)} ETH would take this run's spending to ${formatEther(spent + o.amount)} ETH, over its ${formatEther(FUNDING_LIMITS.topUpsWei)} ETH limit`
	if (o.now < FUNDING_LIMITS.deployerFloorWei + o.amount + o.gasCost)
		return `sending ${formatEther(o.amount)} ETH would leave the deployer under its ${formatEther(FUNDING_LIMITS.deployerFloorWei)} ETH floor (it holds ${formatEther(o.now)} ETH)`
	return undefined
}

/** @throws GuardError `funds` with {@link limitBreach}'s reason, never a key */
export function assertWithinLimits(o: SpendCheck): void {
	const breach = limitBreach(o)
	if (breach) throw new GuardError("funds", breach)
}

/** The deployer's transaction count at the block a plan's balances were read at, and pending on each endpoint. */
export type SnapshotCounts = { block: bigint; atSnapshot: number; pendingRead: number; pendingSend: number }

/**
 * Why balances read at `block` must not be planned from, or undefined when they may: that block must hold
 * every transaction of the deployer's either endpoint knows, landed or pending, so its count there equals
 * the higher pending count. Otherwise a top-up that landed after the block, or is still pending, is
 * planned again. Endpoints that both lag leave the next send at a spent nonce, which fails at the send.
 */
export function staleSnapshot(c: SnapshotCounts): string | undefined {
	const pending = Math.max(c.pendingRead, c.pendingSend)
	if (c.atSnapshot === pending) return undefined
	return `the deployer's count is ${c.atSnapshot} at block ${c.block} but ${c.pendingRead} pending on the read endpoint and ${c.pendingSend} on the send endpoint, so the balances read at that block may miss a transaction of its; run again`
}

/**
 * The mined top-up is the one sent, from the deployer, and succeeded. viem's receipt wait returns a
 * replacement's receipt when one is mined in the sent transaction's place.
 * @throws Error naming both hashes on a replacement, or the sent hash on a failure
 */
export function assertTopUp(receipt: { transactionHash: Hex; status: string; from: Address }, sent: Hex, deployer: Address): void {
	if (receipt.transactionHash.toLowerCase() !== sent.toLowerCase())
		throw new Error(`the top-up ${sent} was replaced: the mined receipt is for ${receipt.transactionHash}`)
	if (receipt.status !== "success" || !isAddressEqual(receipt.from, deployer)) throw new Error(`the top-up ${sent} did not succeed`)
}
