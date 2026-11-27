import { readFileSync } from "node:fs"
import { expect, test } from "vitest"
import { deriveHandoff, type Handoff, handoffPath } from "../scripts/handoff"

// A hub's `derive_token` is pinned to these addresses, so the file must follow every class-id change.
test("bench/handoff.json matches a fresh derivation from the committed artifact", async () => {
	const committed = JSON.parse(readFileSync(handoffPath, "utf8")) as Handoff
	const fresh = await deriveHandoff()
	expect(committed).toEqual(fresh)
	expect(new Set(fresh.cases.map((c) => c.address)).size).toBe(fresh.cases.length)
})
