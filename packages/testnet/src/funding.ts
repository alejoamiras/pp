import type { Address } from "viem"
import type { TestnetDeployment } from "./schema"

/**
 * Gas each L1 key spends over one target's runs, deploy to the last canary. The rehearsal fails when a
 * key's measured spend exceeds its budget, so these are upper bounds checked on every rehearsal.
 */
export const FUNDING_GAS = {
	l1Deployer: 8_000_000n,
	poolDeployer: 60_000_000n,
	aspPostman: 3_000_000n,
	guardian: 500_000n,
	canaryOwner: 5_000_000n,
	canarySender: 2_000_000n,
} as const satisfies Record<string, bigint>

export type FundedRole = keyof typeof FUNDING_GAS

/** Each budget is priced at twice the fee estimate when funded, so a fee spike mid-run still clears. */
export const FEE_MARGIN = 2n

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
	return out
}

export const needOf = (role: FundedRole, maxFeePerGas: bigint): bigint => FUNDING_GAS[role] * maxFeePerGas * FEE_MARGIN

export type Plan = { sends: (Recipient & { balance: bigint; amount: bigint })[]; deployerNeed: bigint; total: bigint }

/** What each recipient lacks of its need, and the total the deployer must hold to send it and keep its own. */
export function fundingPlan(recipients: readonly (Recipient & { balance: bigint })[], maxFeePerGas: bigint): Plan {
	const sends = recipients.map((r) => {
		const need = needOf(r.role, maxFeePerGas)
		return { ...r, amount: r.balance < need ? need - r.balance : 0n }
	})
	const deployerNeed = needOf("l1Deployer", maxFeePerGas)
	return { sends, deployerNeed, total: deployerNeed + sends.reduce((s, r) => s + r.amount, 0n) }
}
