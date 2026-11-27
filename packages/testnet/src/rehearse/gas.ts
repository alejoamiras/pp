/** What each funded L1 role spent in a rehearsal, against its budget in `FUNDING_GAS`. */
import { createPublicClient, type Hex, http, numberToHex } from "viem"
import { FUNDING_GAS, type FundedRole } from "../funding"

/** Gas each sender spent in blocks after `from`, by lower-case address. */
export async function gasBySender(url: string, from: bigint): Promise<Map<string, bigint>> {
	const client = createPublicClient({ transport: http(url) })
	const head = await client.getBlockNumber()
	const gas = new Map<string, bigint>()
	for (let n = from + 1n; n <= head; n++) {
		const receipts = (await client.request({ method: "eth_getBlockReceipts", params: [numberToHex(n)] } as never)) as {
			from: string
			gasUsed: Hex
		}[]
		for (const r of receipts) gas.set(r.from.toLowerCase(), (gas.get(r.from.toLowerCase()) ?? 0n) + BigInt(r.gasUsed))
	}
	return gas
}

const ROLE_KEY: Record<FundedRole, string> = {
	l1Deployer: "L1_DEPLOYER_KEY",
	poolDeployer: "POOL_DEPLOYER_KEY",
	aspPostman: "ASP_POSTMAN_KEY",
	guardian: "GUARDIAN_KEY",
	canaryOwner: "CANARY_OWNER_KEY",
	canarySender: "CANARY_SENDER_KEY",
}

/** Each funded role's gas, from `addresses` keyed by key name; any over its budget fails the rehearsal. */
export function budgetCheck(gas: Map<string, bigint>, addresses: Record<string, string>): Partial<Record<FundedRole, bigint>> {
	const out: Partial<Record<FundedRole, bigint>> = {}
	for (const [role, name] of Object.entries(ROLE_KEY) as [FundedRole, string][]) {
		const used = gas.get((addresses[name] ?? "").toLowerCase()) ?? 0n
		if (used > FUNDING_GAS[role]) throw new Error(`${role} spent ${used} gas, over its budget of ${FUNDING_GAS[role]}`)
		out[role] = used
	}
	return out
}
