import { type Address, formatEther, type Hex, isAddressEqual } from "viem"
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
/** Sepolia's fee sits near zero for hours, so pricing at today's estimate alone would underfund every key after a spike. */
export const FEE_FLOOR_WEI = 1_000_000_000n
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
 * estimate times the margin, the tip the floor, so a base fee rising to the floor strands nothing and
 * no transaction can pay more per gas than the budget assumed.
 */
export const scriptFees = (maxFeePerGas: bigint): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } => ({
	maxFeePerGas: (maxFeePerGas > FEE_FLOOR_WEI ? maxFeePerGas : FEE_FLOOR_WEI) * FEE_MARGIN,
	maxPriorityFeePerGas: FEE_FLOOR_WEI,
})

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

/** The owner's limits for one `fund` run: what it may send in top-ups, and what the L1 deployer keeps. */
export const FUNDING_LIMITS = { topUpsWei: 800_000_000_000_000_000n, deployerFloorWei: 1_000_000_000_000_000_000n } as const

/**
 * A top-up of `amount`, at most `gasCost` in gas, may go only if the deployer's spending since the run
 * began stays within the top-up limit with it, and the deployer keeps its floor after it. Spending is the
 * fall of its live balance from `start`, or what this run sent if that is more, so a top-up that landed
 * after a wrong "not landed" verdict counts.
 * @throws GuardError `funds` naming the limit and the amounts, never a key
 */
export function assertWithinLimits(o: { start: bigint; now: bigint; sent: bigint; amount: bigint; gasCost: bigint }): void {
	const fallen = o.start > o.now ? o.start - o.now : 0n
	const spent = fallen > o.sent ? fallen : o.sent
	if (spent + o.amount > FUNDING_LIMITS.topUpsWei)
		throw new GuardError(
			"funds",
			`a top-up of ${formatEther(o.amount)} ETH would take this run's spending to ${formatEther(spent + o.amount)} ETH, over its ${formatEther(FUNDING_LIMITS.topUpsWei)} ETH limit`,
		)
	if (o.now < FUNDING_LIMITS.deployerFloorWei + o.amount + o.gasCost)
		throw new GuardError(
			"funds",
			`a top-up of ${formatEther(o.amount)} ETH would leave the deployer under its ${formatEther(FUNDING_LIMITS.deployerFloorWei)} ETH floor (it holds ${formatEther(o.now)} ETH)`,
		)
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
