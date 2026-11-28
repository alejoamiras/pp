import type { Address } from "viem"

/** A keystore registration's two halves for one owner; the SDK reads a half as set when it is not zero. */
export type KeystoreKeys = { nullifyingKeyHash: bigint; viewingKey: bigint }

const HALF_NAME: Record<keyof KeystoreKeys, string> = { nullifyingKeyHash: "nullifying key", viewingKey: "viewing key" }

/** Throws naming the first half `held` sets to other keys than `derived`; an unset half passes. */
function assertNoForeignHalf(owner: Address, held: KeystoreKeys, derived: KeystoreKeys, suffix: string): void {
	for (const half of ["nullifyingKeyHash", "viewingKey"] as const)
		if (held[half] !== 0n && held[half] !== derived[half])
			throw new Error(`${owner} is registered under another ${HALF_NAME[half]} than its signature derives${suffix}`)
}

/**
 * Registers the halves `held` leaves unset. A half already set under other keys is refused before
 * anything is sent: the SDK would register only the other half and leave the owner with notes it
 * cannot spend. Both halves already the owner's send nothing.
 * @throws Error naming the foreign half, or when a registration transaction reverts
 */
export async function registerMissingHalves(o: {
	owner: Address
	held: KeystoreKeys
	derived: KeystoreKeys
	send(): Promise<readonly { status: boolean }[]>
}): Promise<void> {
	assertNoForeignHalf(o.owner, o.held, o.derived, "; nothing was sent")
	if (o.held.nullifyingKeyHash !== 0n && o.held.viewingKey !== 0n) return
	const receipts = await o.send()
	if (receipts.some((r) => !r.status)) throw new Error("keystore registration reverted")
}

/**
 * Both halves set, and set to the keys the owner's signature derives.
 * @throws Error when either half is unset or set to other keys
 */
export function assertRegistered(owner: Address, held: KeystoreKeys, derived: KeystoreKeys): void {
	if (held.nullifyingKeyHash === 0n || held.viewingKey === 0n) throw new Error(`the keystore holds no complete registration for ${owner}`)
	assertNoForeignHalf(owner, held, derived, "")
}
