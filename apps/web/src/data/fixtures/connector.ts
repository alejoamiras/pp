/**
 * A wallet that answers at once, so `dev` and component tests pass Connect without a network. It grants
 * what it is asked, as the kit's test wallet does, and its answer goes through the same grant parser
 * as a real wallet's; `declineNextGrant` drops the contract scope, `disconnect` from the control is
 * a remote disconnect.
 */
import type { Manifest } from "../capabilities"
import type { WalletPort } from "../ports"
import { parseGrant } from "../wallet/grant"
import { type AztecConnection, emojiMismatchError, noAccountsError, supersededError, type WalletOption } from "../wallet/types"
import { ACCOUNTS } from "./seed"
import type { World } from "./world"

const OPTION: WalletOption = { key: 0, id: "fixture-wallet", name: "Fixture wallet", kind: "web" }
const EMOJI = ["🔵", "🦋", "🎯", "🐼", "🌟", "🎲", "🦊", "🐸", "💎"] as const

function answerTo(manifest: Manifest, declining: boolean): unknown {
	const granted = manifest.capabilities
		.filter((c) => !(declining && c.type === "contracts"))
		.map((c) => (c.type === "accounts" ? { ...c, accounts: [{ alias: "Fixture account", item: ACCOUNTS.aztec }] } : c))
	return { version: "1.0", granted, wallet: { name: "Fixture wallet", version: "0.0.0" } }
}

export function fixtureConnector(w: World, manifest: Manifest): WalletPort & { remoteDisconnect(): void } {
	let run = 0
	let live = false
	const listeners = new Set<() => void>()
	return {
		async discover(onOption, signal) {
			if (!signal.aborted) onOption(OPTION)
		},
		async connect(_option, confirm): Promise<AztecConnection> {
			const mine = ++run
			live = false
			const matches = await confirm(EMOJI)
			if (mine !== run) throw supersededError()
			if (!matches) throw emojiMismatchError()
			const declining = w.s.declineNextGrant
			if (declining)
				w.update((s) => {
					s.declineNextGrant = false
				})
			const grant = parseGrant(manifest, answerTo(manifest, declining))
			if (grant.accounts.length === 0) throw noAccountsError()
			live = true
			return { epoch: mine, walletName: OPTION.name, accounts: grant.accounts, grant }
		},
		async disconnect() {
			run++
			live = false
		},
		onDisconnect(f) {
			listeners.add(f)
			return () => void listeners.delete(f)
		},
		remoteDisconnect() {
			if (!live) return
			live = false
			run++
			for (const f of [...listeners]) f()
		},
	}
}
