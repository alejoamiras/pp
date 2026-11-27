import { expect, test } from "vitest"
import { assertPrerequisites, PREPARE_COMMAND } from "./prerequisites.ts"

test("a missing checkout or forge artifact fails at once, naming each path and the prepare command", () => {
	const t0 = performance.now()
	expect(() => assertPrerequisites(["/x/.ppv2", "/x/out/PortalFactory.sol/PortalFactory.json"])).toThrow(
		`missing /x/.ppv2, /x/out/PortalFactory.sol/PortalFactory.json; run \`${PREPARE_COMMAND}\` first`,
	)
	expect(() => assertPrerequisites([])).not.toThrow()
	expect(performance.now() - t0).toBeLessThan(1_000)
})
