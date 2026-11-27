import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { PPV2_COMMIT } from "../../../pp-env/src/env/pins.ts"
import { PACKAGE_DIR } from "../support/paths.ts"

/**
 * pp-env deploys the vault from a checkout; this package proves with the npm SDK. Each row is a pair
 * shown to be the same SDK code. Bumping either side fails here until both move together.
 */
const SAME_CODE = [
	{ sdk: "1.0.2", gitHead: "1ee57b03a7a6a26a4bb70e9b3b49a4ca7fe2f6da", checkout: "61fac03acd1fc306164ddc234f7fac4147d04493" },
]

it("pairs the installed SDK with pp-env's pinned checkout", () => {
	const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "node_modules/@0xbow/privacy-pools-v2-sdk/package.json"), "utf8")) as {
		version: string
		gitHead: string
	}
	expect(SAME_CODE).toContainEqual({ sdk: manifest.version, gitHead: manifest.gitHead, checkout: PPV2_COMMIT })
})
