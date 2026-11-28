import type { Address, PublicClient } from "viem"
import { assertTopUp, assertWithinLimits, type Plan } from "../funding"
import { report } from "./common"
import type { l1Sender } from "./wallet"

/** A top-up the send endpoint took must show on the read endpoint by then, or the run stops. */
const VISIBLE_WITHIN_MS = 60_000
const sleep = (ms: number) => new Promise<undefined>((r) => setTimeout(() => r(undefined), ms).unref())

export type TopUpRun = {
	l1: PublicClient
	sender: ReturnType<typeof l1Sender>
	deployer: Address
	/** The deployer's balance when the plan was made; `undefined` skips the live limits. */
	limitsFrom: bigint | undefined
	fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
	/** The deployer's count at the plan's snapshot block: the first top-up's nonce, each next one's one more. */
	nonce: number
}

/**
 * Sends the plan's top-ups one at a time, each shown on the read endpoint and landed before the next.
 * Each is signed at the nonce its place in the plan gives it, never at a count read later: a transaction
 * of the deployer's that lands after the snapshot takes that nonce first, and the top-up fails at the send.
 * @throws SendPathError for a top-up the send path did not admit; Error for one that never showed or landed
 */
export async function sendTopUps(plan: Plan, r: TopUpRun): Promise<void> {
	const { wallet, path } = r.sender
	let sent = 0n
	let nonce = r.nonce
	for (const s of plan.sends) {
		const roles = s.roles.join(" ")
		if (s.amount === 0n) {
			report("funded", { roles, address: s.address, balanceBefore: s.balance, sent: 0n })
			continue
		}
		if (r.limitsFrom !== undefined) {
			const now = await r.l1.getBalance({ address: r.deployer })
			assertWithinLimits({ start: r.limitsFrom, now, sent, amount: s.amount, gasCost: s.transferGas * r.fees.maxFeePerGas })
		}
		const hash = await wallet.sendTransaction({
			to: s.address,
			value: s.amount,
			chain: wallet.chain,
			gas: s.transferGas,
			nonce,
			...r.fees,
		})
		nonce++
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
