import type { ConnectorMode, PublicTarget } from "./build/target"
import type { FixtureControl } from "./data/fixtures"

declare global {
	/** Inlined by `vite.config.ts`; read only through `src/target.ts`. */
	const __PP_TARGET__: PublicTarget
	/** Inlined apart from the target so the unused connector is dead code at build time. */
	const __PP_CONNECTOR__: ConnectorMode
	interface Window {
		/** Fixture builds only; a stack build that names it fails the guard. */
		__ppFixtures?: FixtureControl
	}
}
