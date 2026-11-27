import { useApp } from "../../app/context"
import type { AztecAction } from "../../data/capabilities"
import { messageOf } from "../../data/errors"
import type { LabelView } from "../../data/labels"
import type { TxAction } from "../../data/tx"

/**
 * Why an Aztec action is closed, first reason first: the grant or stage, a send already in flight, one
 * from this account that may still land, or the finality wait, then the label's state. `undefined`
 * when it is open. `label` is `null` while the allow list is still being read, which closes the
 * checked spends only.
 */
export function useActionReason() {
	const { refusal, tx, connection } = useApp()
	return (action: AztecAction & TxAction, label?: LabelView | null): string | undefined => {
		const code = refusal(action) ?? tx.blocked(action, connection?.accounts[0] ?? null)
		if (code !== null) return messageOf(code)
		if (label === undefined || action === "ragequit") return undefined
		if (label === null) return "Reading the allow list…"
		const open = action === "transferPrivate" ? label.can.send : label.can.unshield
		return open ? undefined : label.reason
	}
}
