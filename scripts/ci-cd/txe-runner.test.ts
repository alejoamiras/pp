import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const RUNNER = join(import.meta.dir, "..", "..", "contracts/bridge/aztec/scripts/run-txe-tests.sh")

// `env.deploy` loads the crate's own contract from target/, so without a rebuild a source change is
// tested against its stale artifact and a `should_fail_with` on a changed message still passes.
test("the TXE runner rebuilds the crate under test before it runs the suite", () => {
	const script = readFileSync(RUNNER, "utf8")
	const build = script.search(/^[^#\n]*scripts\/compile\.sh" "\$crate"/m)
	const suite = script.search(/^[^#\n]*"\$NARGO" test /m)
	expect(build).toBeGreaterThan(-1)
	expect(suite).toBeGreaterThan(build)
})
