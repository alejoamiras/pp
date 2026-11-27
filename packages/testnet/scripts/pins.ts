#!/usr/bin/env bun
// Rewrites, or with --check compares, the derived pins: the own pool's creation-code hashes in pp-env's
// fetched build and the L2 class ids. Needs pp-env's fetch and the compiled L2 artifacts.
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { assertNoSeed } from "../src/guards"
import { classIds, committedClassIds, committedPoolCodes, pinMismatches, poolCreationCodes } from "../src/pins"

assertNoSeed(process.env)
const pool = poolCreationCodes()
const classes = await classIds()
if (process.argv.includes("--check")) {
	const bad = [...pinMismatches(pool, committedPoolCodes()), ...pinMismatches(classes, committedClassIds())]
	if (bad.length) {
		console.error(`pins differ:\n  ${bad.join("\n  ")}`)
		process.exit(1)
	}
	console.log(`pins hold: ${Object.keys(pool).length} pool contracts, ${Object.keys(classes).length} class ids`)
} else {
	const write = (file: string, v: unknown) =>
		writeFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), `${JSON.stringify(v, null, "\t")}\n`)
	write("pool-creation-codes.json", pool)
	write("class-ids.json", classes)
	console.log("pins written")
}
