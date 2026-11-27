/**
 * Withdrawals to Ethereum for a stack build. The public row's withdraw is the hub's `exit_public`
 * alone. The label row's screened exit is `[sponsor, unshield, exit_public]` in one transaction: the
 * unshield's public credit, which checks the label's roots again, runs before the exit burns it, so a
 * revert of the check leaves neither. Both go out like every other Aztec send, through
 * `sendThroughWallet`, and only after the payload is checked call by call against what was confirmed.
 */
import { AztecAddress as SdkAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { type ContractArtifact, encodeArguments, type FunctionCall, FunctionSelector, getAllFunctionAbis } from "@aztec-labs/aztec.js/abi"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { ExecutionPayload, mergeExecutionPayloads } from "@aztec-labs/aztec.js/tx"
import type { BridgeClient } from "@pp/bridge-core"
import { labelledTokenArtifact, tokenBridgeHubArtifact } from "@pp/bridge-core/artifacts"
import type { Address } from "viem"
import { assertSpendable } from "../chunks"
import { BridgeFailure } from "../errors"
import { parseAztecAddress } from "../parse"
import type { AztecPort, AztecSendHooks, Sent } from "../ports"
import type { AztecAddress, LabelPath, Origin } from "../stack-types"
import { type AztecDeps, boundTo, sendThroughWallet } from "./aztec"
import { checkedPath, spendPayloads, type TokenSendDeps } from "./token-sends"

export interface WithdrawDeps extends TokenSendDeps {
	/** Builds `exit_public` with bridge-core's payee and amount refusals; nothing on it writes. */
	client: Pick<BridgeClient, "exitPublicPayload">
	/** A label's note values as the connected wallet reports them when called. */
	notes: AztecPort["notesByLabel"]
	/** The account's public balance as the connected wallet reports it when called. */
	publicBalance: AztecPort["publicBalance"]
}

/** What the user confirmed; every call in the payload must carry exactly these values. */
export type ScreenedExit = Readonly<{ payee: Address; amount: bigint; label: bigint; origin: Origin }>

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
	const same =
		c !== undefined &&
		parseAztecAddress(c.to.toString()) === e.to &&
		c.selector.equals(selector) &&
		(fn === null || fn === undefined || c.type === fn.functionType) &&
		!c.hideMsgSender &&
		!c.isStatic &&
		c.args.length === args.length &&
		c.args.every((a, i) => a.equals(args[i] as Fr))
	if (!same) throw new BridgeFailure("SPEND_MISMATCH")
}

/**
 * Checks `p` is exactly `calls`, in order, paid by `fpc`.
 * @throws BridgeFailure `SPEND_MISMATCH` on any other call, order, argument, flag or fee payer
 */
async function expectPayload(p: ExecutionPayload, fpc: AztecAddress, calls: Expected[]): Promise<void> {
	if (p.calls.length !== calls.length + 1 || parseAztecAddress(p.feePayer?.toString() ?? "") !== fpc)
		throw new BridgeFailure("SPEND_MISMATCH")
	await expectCall(p.calls[0], { to: fpc, artifact: null, name: SPONSOR, args: [] })
	for (const [i, e] of calls.entries()) await expectCall(p.calls[i + 1], e)
}

const pathArg = (p: LabelPath) => ({ index: p.index, depth: p.depth, siblings: [...p.siblings] })

export function stackWithdraw(d: WithdrawDeps): Pick<AztecPort, "exitPublic" | "unshieldAndExit"> {
	const { hub, token } = d.aztec.deployment
	const exitCall = (payee: Address, amount: bigint): Expected => ({
		to: hub,
		artifact: tokenBridgeHubArtifact,
		name: "exit_public",
		args: [SdkAddress.fromStringUnsafe(token), EthAddress.fromString(payee), amount],
	})
	const send = (aztec: AztecDeps, from: AztecAddress, payload: ExecutionPayload, on: AztecSendHooks): Promise<Sent> =>
		sendThroughWallet(aztec, { epoch: on.epoch, from, payload, contracts: ["hub", "token"], handoff: () => on.handoff() })
	return {
		async exitPublic(from, a, on) {
			const { payee, amount } = a
			const payload = await d.client.exitPublicPayload({ payee, amount })
			await expectPayload(payload, d.sponsoredFpc, [exitCall(payee, amount)])
			// A balance spent since the form fails the wallet's simulation past the handoff, which holds the account.
			if ((await d.publicBalance(from)) < amount) throw new BridgeFailure("OVER_PUBLIC_BALANCE")
			return send(d.aztec, from, payload, on)
		},
		async unshieldAndExit(from, a, on) {
			const x: ScreenedExit = { payee: a.payee, amount: a.amount, label: a.label, origin: a.origin }
			// The exit first, checked as built: a refused payee or a wrong payload costs no allow-list check.
			const exit = await d.client.exitPublicPayload({ payee: x.payee, amount: x.amount })
			await expectPayload(exit, d.sponsoredFpc, [exitCall(x.payee, x.amount)])
			const path = await checkedPath(d.allowList, x.label, x.origin)
			const unshield = await spendPayloads({ token, sponsoredFpc: d.sponsoredFpc }).unshield(
				boundTo(d.aztec, on.epoch).wallet,
				{ amount: x.amount, label: x.label },
				path,
			)
			const exitOnly = new ExecutionPayload(
				exit.calls.filter((c) => c.name !== SPONSOR),
				exit.authWitnesses,
				exit.capsules,
				exit.extraHashedArgs,
				exit.feePayer,
			)
			const payload = mergeExecutionPayloads([unshield, exitOnly])
			await expectPayload(payload, d.sponsoredFpc, [
				{ to: token, artifact: labelledTokenArtifact, name: "unshield", args: [x.amount, new Fr(x.label), pathArg(path)] },
				exitCall(x.payee, x.amount),
			])
			// The notes as they are now: one spend takes at most the label's 8 largest.
			assertSpendable(await d.notes(from, x.label), x.amount)
			return send(d.aztec, from, payload, on)
		},
	}
}
