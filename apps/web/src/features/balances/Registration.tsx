/**
 * The pool's keystore step after sign-in. Until the keystore holds both of the owner's keys, it stands
 * in for the note list: senders cannot encrypt to the owner, or its spends have no keystore leaf.
 * Notes this client already found under its own viewing key still count in the total above it.
 */
import { useIsMutating, useMutation, useMutationState, useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { isAddressEqual } from "viem"
import { useApp } from "../../app/context"
import { useLive } from "../../app/live"
import { REGISTRATION_KEY } from "../../app/queries"
import { codeOf, messageOf, type UiCode } from "../../data/errors"
import type { Session } from "../../data/ports"
import { type RegisterResult, registerOwner } from "../../data/register"
import type { RegistrationCall } from "../../data/stack-types"
import { ActionButton, Callout, shortHex } from "../../ui"

type Failed = Extract<RegisterResult, { ok: false }>

const CHECK_FIRST = "Check again before registering again: a repeated first step fails on Ethereum and still costs gas."

/** Where the page's sentence for a code speaks of a bridge, registration says what it means for the keystore. */
const REGISTER_MESSAGES: Partial<Record<UiCode, string>> = {
	UNCERTAIN: `This page could not confirm whether your wallet sent the registration. ${CHECK_FIRST}`,
	TX_UNCONFIRMED: `Your wallet sent the registration, but the page could not read whether it landed. ${CHECK_FIRST}`,
	REVERTED: "The registration reverted on Ethereum and set nothing. Check again: another tab may have registered this account first.",
	RPC_INCONSISTENT: "The registration mined, but the keystore does not show it yet. Wait a moment, then check again.",
}

const UNCONFIRMED: ReadonlySet<UiCode> = new Set(["UNCERTAIN", "TX_UNCONFIRMED", "RPC_INCONSISTENT", "REVERTED"])

function RegisterFailed({ failed, onCheck }: { failed: Failed; onCheck(): void }) {
	return (
		<div className="mt-2 grid gap-1" role="alert" data-testid="register-failed" data-code={failed.code}>
			<p>{REGISTER_MESSAGES[failed.code] ?? messageOf(failed.code)}</p>
			{failed.done ? (
				<p className="text-xs" title={failed.done}>
					An earlier transaction of this registration mined and set its key: {shortHex(failed.done)}.
				</p>
			) : null}
			{failed.txHash ? (
				<p className="font-mono text-xs" title={failed.txHash}>
					Transaction {shortHex(failed.txHash)}
				</p>
			) : null}
			{UNCONFIRMED.has(failed.code) ? (
				<div>
					<ActionButton onClick={onCheck}>Check again</ActionButton>
				</div>
			) : null}
		</div>
	)
}

/** Why the owner cannot register from here now, or `undefined`. */
function useRegisterBlock(session: Session, busy: boolean): string | undefined {
	const { source, live } = useApp()
	const { account, chainId } = useLive(live)
	if (busy) return "Your Ethereum wallet has the registration."
	if (account === null || !isAddressEqual(account, session.owner)) return messageOf("REGISTER_FROM_OWNER")
	if (chainId !== source.deployment.chainId) return messageOf("CHAIN_MISMATCH")
	return undefined
}

/**
 * The run lives in the page's mutation cache, not in this step: leaving Balances while the wallet holds
 * a call keeps Register blocked when it shows again, and keeps the run's outcome.
 */
function useRegisterRun(session: Session) {
	const { source, live, refresh } = useApp()
	const mutationKey = [REGISTRATION_KEY, "run", session.owner]
	const run = useMutation({
		mutationKey,
		mutationFn: () => registerOwner({ session, live: live.context, chainId: source.deployment.chainId }),
		onSettled: () => refresh(),
	})
	const busy = useIsMutating({ mutationKey }) > 0
	const latest = useMutationState({ filters: { mutationKey }, select: (m) => m.state }).at(-1)
	const result = latest?.status === "success" ? (latest.data as RegisterResult) : undefined
	const failed: Failed | undefined =
		result?.ok === false ? result : latest?.status === "error" ? { ok: false, code: codeOf(latest.error) ?? "UNKNOWN" } : undefined
	return { register: () => run.mutate(), busy, failed }
}

function RegisterStep({ session, next, onCheck }: { session: Session; next: RegistrationCall["function"]; onCheck(): void }) {
	const { register, busy, failed } = useRegisterRun(session)
	const block = useRegisterBlock(session, busy)
	const calls = next === "setAuthPolicy" ? "two Ethereum transactions" : "one more Ethereum transaction"
	return (
		<Callout tone="attn" title="Register with the pool" role="status">
			<div data-testid="register-step" data-next={next} className="grid gap-2">
				<p>
					The pool's keystore does not hold both of {shortHex(session.owner)}'s keys yet. Registering sends {calls} from that
					account, paid in its ETH: one sets the key that authorises your spends, one the key senders encrypt your notes to.
				</p>
				<div>
					<ActionButton variant="primary" disabledReason={block} onClick={register}>
						Register
					</ActionButton>
				</div>
				{failed && !busy ? <RegisterFailed failed={failed} onCheck={onCheck} /> : null}
			</div>
		</Callout>
	)
}

/** `children` once the owner is registered; until then, the step that registers it. */
export function RegistrationGate({ session, children }: { session: Session; children: ReactNode }) {
	const step = useQuery({ queryKey: [REGISTRATION_KEY, session.owner], queryFn: () => session.registrationStep() })
	const check = () => void step.refetch()
	if (step.isPending) return <Callout tone="wait" busy role="status" title="Checking your pool registration…" />
	if (step.isError)
		return (
			<Callout tone="bad" title="We could not read your pool registration" role="alert">
				<p>{messageOf(codeOf(step.error) ?? "RPC_FAILED")}</p>
				<div className="mt-2">
					<ActionButton onClick={check}>Try again</ActionButton>
				</div>
			</Callout>
		)
	if (step.data.status === "registered") return children
	return <RegisterStep session={session} next={step.data.call.function} onCheck={check} />
}
