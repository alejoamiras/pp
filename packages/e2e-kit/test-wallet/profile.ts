/** The wallet shapes the suite connects the app to: `plain` is a stock wallet-sdk wallet, `full` also
 *  answers the Nulo wallet's token-registration RPCs. */
export type TestWalletProfile = "plain" | "full"

export const PROFILES: readonly TestWalletProfile[] = ["plain", "full"]

/** The app id the app connects under; every other dApp is refused. */
export const APP_ID = "pp"

export function parseProfile(raw: string | null): TestWalletProfile {
	if (raw === null) return "plain"
	if ((PROFILES as readonly string[]).includes(raw)) return raw as TestWalletProfile
	throw new Error(`test wallet: unknown profile "${raw}" (expected ${PROFILES.join(" | ")})`)
}

/** What the wallet's build bakes in: the sandbox's node + chain identity and the one origin it serves. */
export interface TestWalletIdentity {
	nodeUrl: string
	l1ChainId: number
	rollupVersion: number
	appOrigin: string
}

/** An actor the suite created in Node: the same Nulo derivation runs here, so the address matches. */
export interface Seed {
	secret: `0x${string}`
	salt: string
}
