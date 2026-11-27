import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"
import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import type { ExecutionPayload } from "@aztec-labs/stdlib/tx"
import { aspLeaf, BN254_P, exitContentV1, type LabelPath, leanImtRoot, SpecRangeError } from "@pp/bridge-spec"
import type { Address } from "viem"
import { labelledTokenArtifact, tokenBridgeHubArtifact } from "../artifacts"
import { hubRegistryAt } from "../hub-l2"
import { guarded } from "./boundary"
import type { ClientDeployment } from "./deployment"
import { BridgeClientError } from "./errors"
import { assertExitPayee } from "./exits-chain"
import { callPayload, sponsored } from "./payload"

export type ExitPrivateNode = Pick<AztecNode, "getContract" | "getPublicStorageAt">

export type ExitPrivateRequest = { payee: Address; amount: bigint; label: bigint; path: LabelPath }

let committed: Promise<{ hub: string; token: string }> | undefined

/** The committed artifacts' class ids, computed once per process; a failed computation is retried. */
function committedClasses(): Promise<{ hub: string; token: string }> {
	committed ??= (async () => ({
		hub: (await getContractClassFromArtifact(tokenBridgeHubArtifact)).id.toString(),
		token: (await getContractClassFromArtifact(labelledTokenArtifact)).id.toString(),
	}))().catch((e: unknown) => {
		committed = undefined
		throw e
	})
	return committed
}

/**
 * A deployment builds the private exit only with this commit's hub and token, neither of which can be
 * upgraded, and a registry for the token's check to read: an older generation's hub has no
 * `exit_private`, and a hub built over another token class calls a token without the checked burn.
 */
async function assertPrivateExitStage(d: ClientDeployment, node: ExitPrivateNode): Promise<void> {
	const [hub, token] = await Promise.all([
		node.getContract(AztecAddress.fromStringUnsafe(d.hub)),
		node.getContract(AztecAddress.fromStringUnsafe(d.token)),
	])
	if (!hub || !token) throw new BridgeClientError("DEPLOYMENT_MISMATCH")
	const want = await committedClasses()
	if (hub.currentContractClassId.toString() !== want.hub) throw new BridgeClientError("STAGE_UNSUPPORTED", { source: "HubClass" })
	if (token.currentContractClassId.toString() !== want.token) throw new BridgeClientError("STAGE_UNSUPPORTED", { source: "TokenClass" })
	// The hub's class fixes its layout, so only now does the slot name its registry.
	const registry = await hubRegistryAt(node, d.hub)
	if (registry.isZero() || !(await node.getContract(AztecAddress.fromFieldUnsafe(registry))))
		throw new BridgeClientError("STAGE_UNSUPPORTED", { source: "NoRegistry" })
}

/**
 * The hub's `exit_private` of `amount` of the sender's `label` notes to `payee`, checked against
 * `path` in the tree of the selected notes' origin, paid by the SponsoredFPC, for the holder's wallet
 * to send. The hub sends the public exit's content and ticket, which `exitTickets` reads and `settle`
 * pays. At most 8 notes of the label are spent; the change keeps the label. `a` must be the caller's
 * copy: it is read after the awaits.
 * @throws BridgeClientError `SPEND_MISMATCH` naming the refused field in `source`: what
 * `exitPublicPayload` refuses, a label outside [1, p), a path the circuit's format rejects;
 * `STAGE_UNSUPPORTED` (`HubClass`, `TokenClass`, `NoRegistry`); `DEPLOYMENT_MISMATCH` for a missing
 * instance
 */
export function exitPrivatePayload(
	c: { deployment: ClientDeployment; node: ExitPrivateNode },
	a: ExitPrivateRequest,
): Promise<ExecutionPayload> {
	return guarded(async () => {
		const d = c.deployment
		exitContentV1(a)
		assertExitPayee(d.portal, a.payee)
		if (typeof a.label !== "bigint" || a.label < 1n || a.label >= BN254_P)
			throw new SpecRangeError("LabelOutOfRange", "label", String(a.label))
		// Format only; whether the label is in the root is the circuit's to prove.
		leanImtRoot(aspLeaf(a.label), a.path)
		await assertPrivateExitStage(d, c.node)
		const path = { index: a.path.index, depth: a.path.depth, siblings: [...a.path.siblings] }
		const args = [AztecAddress.fromStringUnsafe(d.token), EthAddress.fromString(a.payee), a.amount, new Fr(a.label), path]
		return sponsored(await callPayload(tokenBridgeHubArtifact, AztecAddress.fromStringUnsafe(d.hub), "exit_private", args))
	})
}
