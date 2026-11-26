#!/usr/bin/env bun
// Runs the pinned forge on pp-env's fixture contracts, with their dependencies remapped to wherever
// the package manager installed them: `bun scripts/forge-fixtures.ts test -vv`.
import { FIXTURES_DIR, fixtureForge, withFixtureLock } from "../src/env/deploy.ts"
import { forgeBin } from "../src/env/tools.ts"

const [subcommand, ...rest] = process.argv.slice(2)
if (!subcommand) {
	console.error("usage: forge-fixtures.ts <build|test|...> [forge args]")
	process.exit(2)
}
const { args, env } = fixtureForge()
const code = await withFixtureLock(FIXTURES_DIR, () => {
	const proc = Bun.spawn([forgeBin(), subcommand, ...args, ...rest], { stdio: ["inherit", "inherit", "inherit"], env })
	return proc.exited
})
process.exit(code)
