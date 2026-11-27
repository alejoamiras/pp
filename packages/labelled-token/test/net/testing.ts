/**
 * `@pp/labelled-token/testing`: what another package's network suite needs to run births against this
 * token on a `@pp/bridge-core/sandbox` network: deploy the stage with a real registry, post roots and
 * move the intake, fund and shield, and read the announcement, the debit and the nullifiers. Run it under
 * Bun, as this package's suites run: its imports are extensionless TypeScript, which native Node cannot load.
 * The wallet internals it uses are re-checked on every `@aztec-labs` bump (see `internals.ts`).
 */
export {
	announcements,
	type BirthAnnouncement,
	birthAnnouncementEvent,
	nullifiersOf,
	type ShieldDebited,
	type Shielded,
	shield,
	shieldDebitedEvent,
	shieldDebits,
} from "./births"
export { land, type Proven, prove } from "./internals"
export { deployRegistry, type PathArg, type Registry, type Tree, tree } from "./registry"
export {
	attach,
	balance,
	type Deployed,
	type Device,
	deployOpts,
	deployStage,
	labels,
	publicBalance,
	sendOpts,
	stubArtifact,
	values,
} from "./token"
