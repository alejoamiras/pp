import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ExecutionPayload } from "@aztec-labs/stdlib/tx"
import { exitContentV1 } from "@pp/bridge-spec"
import { type Address, isAddressEqual } from "viem"
import { tokenBridgeHubArtifact } from "../artifacts"
import { guarded } from "./boundary"
import type { ClientDeployment } from "./deployment"
import { BridgeClientError } from "./errors"
import { callPayload, sponsored } from "./payload"

/**
 * The hub's `exit_public` of `amount` of the sender's public balance of the deployment's token to
 * `payee`, paid by the SponsoredFPC, for the holder's wallet to send. The hub burns that balance and
 * sends the v1 exit content to the portal; the ticket it publishes is what `exitTickets` reads.
 * @throws BridgeClientError `SPEND_MISMATCH` naming the refused field in `source`: a payee that is
 * zero, wider than 160 bits or the portal (which would burn and never settle), an amount of zero or
 * of 2^128 or more
 */
export function exitPublicPayload(d: ClientDeployment, a: { payee: Address; amount: bigint }): Promise<ExecutionPayload> {
	return guarded(async () => {
		exitContentV1(a)
		if (isAddressEqual(a.payee, d.portal)) throw new BridgeClientError("SPEND_MISMATCH", { source: "PayeeIsPortal" })
		const args = [AztecAddress.fromStringUnsafe(d.token), EthAddress.fromString(a.payee), a.amount]
		return sponsored(await callPayload(tokenBridgeHubArtifact, AztecAddress.fromStringUnsafe(d.hub), "exit_public", args))
	})
}
