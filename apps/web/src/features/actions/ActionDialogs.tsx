import { useApp } from "../../app/context"
import type { HomeAction } from "../balances/AztecPanel"
import { LabelExitDialog, RagequitDialog, WithdrawDialog } from "./ExitDialogs"
import { SendDialog, ShieldDialog, UnshieldDialog } from "./SpendDialogs"

/** The dialog for one Home action, from the connected Aztec account; nothing opens without one. */
export function ActionDialogs({ action, onClose }: { action: HomeAction; onClose(): void }) {
	const { connection } = useApp()
	const account = connection?.accounts[0]
	if (!account) return null
	switch (action.kind) {
		case "send":
			return <SendDialog account={account} balance={action.balance} onClose={onClose} />
		case "unshield":
			return <UnshieldDialog account={account} balance={action.balance} onClose={onClose} />
		case "ragequit":
			return <RagequitDialog account={account} balance={action.balance} onClose={onClose} />
		case "shield":
			return <ShieldDialog account={account} amount={action.amount} onClose={onClose} />
		case "withdraw":
			return <WithdrawDialog account={account} amount={action.amount} onClose={onClose} />
		case "exit":
			return <LabelExitDialog account={account} balance={action.balance} onClose={onClose} />
	}
}
