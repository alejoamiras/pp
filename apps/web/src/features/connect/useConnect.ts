import { useCallback, useEffect, useRef, useState } from "react"
import type { WalletPort } from "../../data/ports"
import type { DataSource } from "../../data/source"
import { type AztecConnection, ConnectError, connectErrorMessage, type WalletOption } from "../../data/wallet/types"

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
 * disconnects first, so the connector drops any continuation still waiting on the wallet; a remote
 * disconnect returns the panel to idle. `onConnection` hears every change of the live connection
 * synchronously, before React renders it, and hears `null` as soon as a new attempt starts.
 */
export function useConnect(source: DataSource, onConnection: (c: AztecConnection | null) => void = () => {}) {
	const [step, setStep] = useState<ConnectStep>({ kind: "idle" })
	const connector = useRef<WalletPort | null>(null)
	const discovery = useRef<AbortController | null>(null)
	const answer = useRef<((matches: boolean) => void) | null>(null)
	const offDisconnect = useRef<(() => void) | null>(null)
	const notify = useRef(onConnection)
	notify.current = onConnection

	useEffect(() => () => offDisconnect.current?.(), [])

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
			if (!connector.current) {
				const c = await source.wallet()
				connector.current = c
				offDisconnect.current = c.onDisconnect(() => {
					notify.current(null)
					setStep({ kind: "idle" })
				})
			}
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
			notify.current(null)
			setStep({ kind: "opening" })
			try {
				const connection = await c.connect(option, confirm)
				notify.current(connection)
				setStep({ kind: "connected", connection })
			} catch (err) {
				if (!isSuperseded(err)) fail(err)
			}
		},
		[confirm, fail],
	)

	const close = useCallback(async () => {
		discovery.current?.abort()
		notify.current(null)
		setStep({ kind: "idle" })
		await connector.current?.disconnect()
		settleEmoji(false)
	}, [settleEmoji])

	return { step, start, choose, answerEmoji: settleEmoji, close }
}

export type Connect = ReturnType<typeof useConnect>
