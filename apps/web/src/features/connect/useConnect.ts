import { useCallback, useRef, useState } from "react"
import type { DataSource } from "../../data/source"
import { type AztecConnection, ConnectError, connectErrorMessage, type WalletConnector, type WalletOption } from "../../data/wallet/types"

export type ConnectStep =
	| { kind: "idle" }
	| { kind: "discovering"; options: readonly WalletOption[]; done: boolean }
	| { kind: "opening" }
	| { kind: "verifying"; emoji: readonly string[] }
	| { kind: "granting" }
	| { kind: "connected"; connection: AztecConnection }
	| { kind: "error"; message: string }

const isSuperseded = (err: unknown) => err instanceof ConnectError && err.code === "superseded"

/**
 * The Connect flow over whichever connector the build's data source provides. Closing the dialog
 * disconnects first, so the connector drops any continuation still waiting on the wallet.
 */
export function useConnect(source: DataSource) {
	const [step, setStep] = useState<ConnectStep>({ kind: "idle" })
	const connector = useRef<WalletConnector | null>(null)
	const discovery = useRef<AbortController | null>(null)
	const answer = useRef<((matches: boolean) => void) | null>(null)

	const fail = useCallback((err: unknown) => {
		console.error("[pp] connect failed", err)
		setStep({ kind: "error", message: connectErrorMessage(err) })
	}, [])

	const settleEmoji = useCallback((matches: boolean) => {
		const resolve = answer.current
		answer.current = null
		resolve?.(matches)
	}, [])

	const start = useCallback(async () => {
		discovery.current?.abort()
		const ac = new AbortController()
		discovery.current = ac
		setStep({ kind: "discovering", options: [], done: false })
		const addOption = (o: WalletOption) => setStep((s) => (s.kind === "discovering" ? { ...s, options: [...s.options, o] } : s))
		try {
			connector.current ??= await source.wallet()
			await connector.current.discover(addOption, ac.signal)
			setStep((s) => (s.kind === "discovering" ? { ...s, done: true } : s))
		} catch (err) {
			if (!ac.signal.aborted) fail(err)
		}
	}, [source, fail])

	const confirm = useCallback(
		(emoji: readonly string[]) =>
			new Promise<boolean>((resolve) => {
				answer.current = resolve
				setStep({ kind: "verifying", emoji })
			}).then((matches) => {
				if (matches) setStep({ kind: "granting" })
				return matches
			}),
		[],
	)

	const choose = useCallback(
		async (option: WalletOption) => {
			const c = connector.current
			if (!c) return
			discovery.current?.abort()
			setStep({ kind: "opening" })
			try {
				setStep({ kind: "connected", connection: await c.connect(option, confirm) })
			} catch (err) {
				if (!isSuperseded(err)) fail(err)
			}
		},
		[confirm, fail],
	)

	const close = useCallback(async () => {
		discovery.current?.abort()
		setStep({ kind: "idle" })
		await connector.current?.disconnect()
		settleEmoji(false)
	}, [settleEmoji])

	return { step, start, choose, answerEmoji: settleEmoji, close }
}
