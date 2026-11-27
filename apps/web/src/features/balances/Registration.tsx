/**
 * The pool's keystore step after sign-in. Until the keystore holds the owner's two keys, it stands in
 * for the pool notes: an unregistered account can hold none this app reads, and senders cannot find it.
 */
import { useQuery } from "@tanstack/react-query"
import { type ReactNode, useState } from "react"
import { isAddressEqual } from "viem"
import { useApp } from "../../app/context"
import { useLive } from "../../app/live"
import { codeOf, messageOf, type UiCode } from "../../data/errors"
import type { Session } from "../../data/ports"
import { type RegisterResult, registerOwner } from "../../data/register"
import type { RegistrationCall } from "../../data/stack-types"
import { ActionButton, Callout, shortHex } from "../../ui"

export const REGISTRATION_KEY = "registration"

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

function RegisterStep({ session, next, onCheck }: { session: Session; next: RegistrationCall["function"]; onCheck(): void }) {
	const { source, live, refresh } = useApp()
	const [state, setState] = useState<{ kind: "idle" } | { kind: "registering" } | { kind: "failed"; failed: Failed }>({ kind: "idle" })
	const block = useRegisterBlock(session, state.kind === "registering")
	const register = async () => {
		setState({ kind: "registering" })
		const r = await registerOwner({ session, live: live.context, chainId: source.deployment.chainId })
		setState(r.ok ? { kind: "idle" } : { kind: "failed", failed: r })
		refresh()
	}
	const calls = next === "setAuthPolicy" ? "two Ethereum transactions" : "one more Ethereum transaction"
	return (
		<Callout tone="attn" title="Register with the pool" role="status">
			<div data-testid="register-step" data-next={next} className="grid gap-2">
				<p>
					The pool's keystore holds no keys for {shortHex(session.owner)} yet, so it has no pool notes this app can read.
					Registering sends {calls} from that account, paid in its ETH: one sets the key that authorises your spends, one the key
					senders encrypt your notes to.
				</p>
				<div>
					<ActionButton variant="primary" disabledReason={block} onClick={() => void register()}>
						Register
					</ActionButton>
				</div>
				{state.kind === "failed" ? <RegisterFailed failed={state.failed} onCheck={onCheck} /> : null}
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
