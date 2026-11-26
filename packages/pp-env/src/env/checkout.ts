import { existsSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { CIRCUITS_DIR, CONTRACTS_DIR } from "./pins.ts"

/** packages/pp-env, from this file's location. */
export const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../..")
/** Gitignored symlink to the fetched checkout; the only source for imports, circuits and contracts. */
export const CHECKOUT_LINK = join(PACKAGE_DIR, ".ppv2")

export type Checkout = { src: string; contracts: string; circuits: string; target: string }

export function checkout(): Checkout {
	if (!existsSync(CHECKOUT_LINK))
		throw new Error(`no Privacy Pools v2 checkout at ${CHECKOUT_LINK}; run \`bun run fetch\` in packages/pp-env`)
	const src = realpathSync(CHECKOUT_LINK)
	return { src, contracts: join(src, CONTRACTS_DIR), circuits: join(src, CIRCUITS_DIR), target: dirname(src) }
}
