import { type AztecConnection, emojiMismatchError, supersededError, type WalletConnector, type WalletOption } from "../wallet/types"

const OPTION: WalletOption = { key: 0, id: "fixture-wallet", name: "Fixture wallet", kind: "web" }
const ACCOUNT = `0x${"0f".repeat(32)}`
const EMOJI = ["🔵", "🦋", "🎯", "🐼", "🌟", "🎲", "🦊", "🐸", "💎"] as const

/** A wallet that answers at once, so `dev` and component tests pass Connect without a network. */
export function fixtureConnector(): WalletConnector {
	let run = 0
	return {
		async discover(onOption, signal) {
			if (!signal.aborted) onOption(OPTION)
		},
		async connect(_option, confirm): Promise<AztecConnection> {
			const mine = ++run
			const matches = await confirm(EMOJI)
			if (mine !== run) throw supersededError()
			if (!matches) throw emojiMismatchError()
			return { epoch: mine, walletName: OPTION.name, accounts: [ACCOUNT] }
		},
		async disconnect() {
			run++
		},
	}
}
