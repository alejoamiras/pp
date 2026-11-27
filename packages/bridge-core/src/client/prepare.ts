import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { bridgeDataV1, claimSecretHash, deriveClaimSalt } from "@pp/bridge-spec"
import { type Address, isAddress, toHex } from "viem"
import { guarded } from "./boundary"
import { BridgeClientError } from "./errors"
import { brandOf } from "./session"
import type { PreparedBridgeSpend } from "./types"

/** The portal component of a deployment id (`chainId:portal:hub`). */
const portalOf = (deploymentId: string) => deploymentId.split(":")[1]

/**
 * A spend of the note whose commitment is `note`, bridging `amount` to `recipient` through `portal`.
 * The claim salt derives inside the session from that commitment, and the secret hash and `data`
 * from the salt, so no caller supplies a salt, key or secret hash and recovery re-derives every
 * bridge this builds. A re-proof of the same note and recipient yields the same salt and secret hash.
 * @throws BridgeClientError `FORGED_SESSION`; `DEPLOYMENT_MISMATCH` when `portal` is not the session's;
 *   `RECIPIENT_INVALID` when `recipient` is not a point on the curve; the pool client's errors, translated
 */
export function prepareBridgeSpend(
	s: unknown,
	a: { note: bigint; amount: bigint; portal: Address; recipient: AztecAddress },
): Promise<PreparedBridgeSpend> {
	return guarded(async () => {
		const { session, secrets } = brandOf(s)
		const { note, amount, portal } = a
		const recipient = AztecAddress.fromStringUnsafe(String(a.recipient.toString()))
		if (typeof portal !== "string" || !isAddress(portal) || portal.toLowerCase() !== portalOf(session.deploymentId))
			throw new BridgeClientError("DEPLOYMENT_MISMATCH")
		if (!(await recipient.isValid())) throw new BridgeClientError("RECIPIENT_INVALID")
		const claimSalt = deriveClaimSalt(secrets.claimKey, note)
		const secretHash = toHex(await claimSecretHash(claimSalt, recipient), { size: 32 })
		const spend = await session.pool.prepareSpend({ note, amount, processor: portal, data: bridgeDataV1(secretHash) })
		return { ...spend, secretHash, claimSalt, recipient }
	})
}
