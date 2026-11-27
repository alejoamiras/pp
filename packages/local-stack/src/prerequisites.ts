import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { missingDeployArtifacts } from "@pp/bridge-core/deploy"

export const PREPARE_COMMAND = "bun run demo:prepare"

/** pp-env's fetched checkout: the `.ppv2` link its `fetch` writes beside its `src/`. */
function ppEnvCheckout(): string {
	return join(dirname(fileURLToPath(import.meta.resolve("@pp/pp-env"))), "..", ".ppv2")
}

/** What `bun run demo:prepare` leaves behind and the boot cannot do without: empty when it can run. */
export function missingPrerequisites(): string[] {
	const checkout = ppEnvCheckout()
	return [...(existsSync(checkout) ? [] : [checkout]), ...missingDeployArtifacts()]
}

/**
 * Fails before anything starts, so a fresh clone learns the one command it needs in under a second
 * instead of after the network boots.
 * @throws Error naming each missing path and `bun run demo:prepare`
 */
export function assertPrerequisites(missing: readonly string[] = missingPrerequisites()): void {
	if (missing.length) throw new Error(`missing ${missing.join(", ")}; run \`${PREPARE_COMMAND}\` first`)
}
