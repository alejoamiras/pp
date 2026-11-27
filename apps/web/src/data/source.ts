/**
 * What a build's data layer provides. `#data` resolves to the fixture world or to the adapters at
 * build time, so screens import only this interface and a stack build cannot reach fixture code;
 * either exports `loadSource(): Promise<DataSource>`, which the page awaits before it renders.
 */
import type { AllowListPort, AztecPort, ChainClock, Deployment, ExitPort, L1Port, SessionPort, Timer, WalletPort } from "./ports"

export interface DataSource {
	readonly mode: "fixtures" | "stack"
	readonly deployment: Deployment
	readonly clock: ChainClock
	readonly timer: Timer
	readonly l1: L1Port
	readonly sessions: SessionPort
	/** Raw: the screens wrap it with `guardAztec` over the connection's grant. */
	readonly aztec: AztecPort
	readonly exits: ExitPort
	readonly allowList: AllowListPort
	/** The Aztec wallet connector this build uses, loaded on first call. */
	wallet(): Promise<WalletPort>
}
