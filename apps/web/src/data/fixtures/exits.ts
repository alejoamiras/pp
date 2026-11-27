/** Fixture exit tickets: proving until two Aztec blocks after the burn (the epoch proof), then ready, then settled. */
import { type Address, type Hash, isAddressEqual } from "viem"
import type { ExitTicket } from "../stack-types"
import { BridgeFailure, ProviderError, type UiCode } from "../errors"
import type { ExitPort, ExitView } from "../ports"
import { selectedAccount } from "./l1"
import type { FixtureExit } from "./seed"
import type { World } from "./world"

function ticketOf(w: World, e: FixtureExit): ExitTicket {
	const base = { token: w.deployment.token, payee: e.payee, amount: e.amount, l2TxHash: e.l2TxHash, messageIndexInTx: e.messageIndexInTx }
	return e.kind === "ragequit" ? { kind: "ragequit", ...base, label: e.label } : { kind: "public", ...base }
}

function viewOf(w: World, e: FixtureExit): ExitView {
	const status = e.settledTx ? "settled" : w.aztecBlock() >= e.readyAtAztecBlock ? "ready" : "proving"
	return { key: { deployment: e.deployment, l2TxHash: e.l2TxHash, messageIndexInTx: e.messageIndexInTx }, ticket: ticketOf(w, e), status }
}

export function fixtureExits(w: World): ExitPort {
	return {
		tickets: async (payee: Address) => w.s.exits.filter((e) => isAddressEqual(e.payee, payee)).map((e) => viewOf(w, e)),
		async settle(t, from, on) {
			const fault = w.takeFault("settle")
			if (fault !== null) throw new BridgeFailure(fault as UiCode)
			// The fixture world has no demo sender, so a demo choice names no account it would sign for.
			if (from.demo || !isAddressEqual(from.sender, selectedAccount(w))) throw new ProviderError(4100, "not the selected account")
			const e = w.s.exits.find((x) => x.l2TxHash === t.l2TxHash && x.messageIndexInTx === t.messageIndexInTx)
			if (!e) throw new BridgeFailure("TICKET_NOT_FOUND")
			if (e.settledTx) return e.settledTx
			if (viewOf(w, e).status !== "ready") throw new BridgeFailure("EXIT_NOT_READY")
			on.handoff()
			const tx: Hash = w.nextHex(32)
			w.update((s) => {
				e.settledTx = tx
				s.l1Block++
			})
			return tx
		},
	}
}
