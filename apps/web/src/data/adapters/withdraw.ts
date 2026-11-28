import { AztecAddress as SdkAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import {
	type ContractArtifact,
	encodeArguments,
	type FunctionCall,
	FunctionSelector,
	FunctionType,
	getAllFunctionAbis,
} from "@aztec-labs/aztec.js/abi"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { ExecutionPayload } from "@aztec-labs/aztec.js/tx"
import type { BridgeClient } from "@pp/bridge-core"
import { tokenBridgeHubArtifact } from "@pp/bridge-core/artifacts"
import { assertSpendable } from "../chunks"
import { BridgeFailure } from "../errors"
import { parseAztecAddress } from "../parse"
import type { AztecPort, AztecSendHooks, Sent } from "../ports"
import type { AztecAddress } from "../stack-types"
import { type AztecDeps, sendThroughWallet } from "./aztec"
import { checkedPath, pathArg, type TokenSendDeps } from "./token-sends"

export interface WithdrawDeps extends TokenSendDeps {
	/** Builds `exit_public` and `exit_private` with bridge-core's refusals; nothing on it writes. */
	client: Pick<BridgeClient, "exitPublicPayload" | "exitPrivatePayload">
}

const SPONSOR = "sponsor_unconditionally"

/** One expected call: its target, its function in `artifact` (or the sponsor's no-argument call), and its arguments. */
type Expected = { to: AztecAddress; artifact: ContractArtifact | null; name: string; args: unknown[] }

async function expectCall(c: FunctionCall | undefined, e: Expected): Promise<void> {
	const fn = e.artifact && getAllFunctionAbis(e.artifact).find((f) => f.name === e.name)
	if (e.artifact && !fn) throw new BridgeFailure("SPEND_MISMATCH")
	const selector = fn
		? await FunctionSelector.fromNameAndParameters(fn.name, fn.parameters)
		: await FunctionSelector.fromSignature(`${e.name}()`)
	const args = fn ? encodeArguments(fn, e.args) : []
	// The sponsor is a private call; routed as public, it would never pay.
	const type = fn ? fn.functionType : FunctionType.PRIVATE
	const same =
		c !== undefined &&
		parseAztecAddress(c.to.toString()) === e.to &&
		c.name === e.name &&
		c.selector.equals(selector) &&
		c.type === type &&
		!c.hideMsgSender &&
		!c.isStatic &&
		c.args.length === args.length &&
		c.args.every((a, i) => a.equals(args[i] as Fr))
	if (!same) throw new BridgeFailure("SPEND_MISMATCH")
}

/**
 * Checks `p` is the sponsor, then exactly `call`, paid by `fpc`, with no witnesses, capsules or hashed
 * arguments of its own: neither call takes any. A wallet grant scopes targets and function names only,
 * so the confirmed arguments are compared here.
 * @throws BridgeFailure `SPEND_MISMATCH` on any other call, order, argument, flag, fee payer or extra input
 */
async function expectPayload(p: ExecutionPayload, fpc: AztecAddress, call: Expected): Promise<void> {
	const bare = p.authWitnesses.length === 0 && p.capsules.length === 0 && p.extraHashedArgs.length === 0
	if (!bare || p.calls.length !== 2 || parseAztecAddress(p.feePayer?.toString() ?? "") !== fpc) throw new BridgeFailure("SPEND_MISMATCH")
	await expectCall(p.calls[0], { to: fpc, artifact: null, name: SPONSOR, args: [] })
	await expectCall(p.calls[1], call)
}

export function stackWithdraw(d: WithdrawDeps): Pick<AztecPort, "exitPublic" | "exitPrivate"> {
	const { hub, token } = d.aztec.deployment
	const hubCall = (name: "exit_public" | "exit_private", args: unknown[]): Expected => ({
		to: hub,
		artifact: tokenBridgeHubArtifact,
		name,
		args: [SdkAddress.fromStringUnsafe(token), ...args],
	})
	const send = (aztec: AztecDeps, from: AztecAddress, payload: ExecutionPayload, on: AztecSendHooks): Promise<Sent> =>
		sendThroughWallet(aztec, { epoch: on.epoch, from, payload, contracts: ["hub", "token"], handoff: () => on.handoff() })
	return {
		async exitPublic(from, a, on) {
			const { payee, amount } = a
			const payload = await d.client.exitPublicPayload({ payee, amount })
			await expectPayload(payload, d.sponsoredFpc, hubCall("exit_public", [EthAddress.fromString(payee), amount]))
			// A balance spent since the form fails the wallet's simulation past the handoff, which holds the account.
			if ((await d.publicBalance(from)) < amount) throw new BridgeFailure("OVER_PUBLIC_BALANCE")
			return send(d.aztec, from, payload, on)
		},
		async exitPrivate(from, a, on) {
			const { payee, amount, label } = a
			const path = await checkedPath(d.allowList, label, a.origin)
			const payload = await d.client.exitPrivatePayload({ payee, amount, label, path })
			await expectPayload(
				payload,
				d.sponsoredFpc,
				hubCall("exit_private", [EthAddress.fromString(payee), amount, new Fr(label), pathArg(path)]),
			)
			// The notes as they are now: one spend takes at most the label's 8 largest.
			assertSpendable(await d.notes(from, label), amount)
			return send(d.aztec, from, payload, on)
		},
	}
}
