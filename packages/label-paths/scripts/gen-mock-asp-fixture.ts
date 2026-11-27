// Writes test/fixtures/mock-asp.json from the pool's own mock ASP (MIT), so the fixture's leaves and root
// come from its code, not ours. Usage: bun scripts/gen-mock-asp-fixture.ts <privacy-pools checkout>/packages/mock-asp
import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const dir = process.argv[2]
if (!dir) throw new Error("usage: gen-mock-asp-fixture.ts <mock-asp package directory>")
const { AspState } = await import(resolve(dir, "src/core/AspState.ts"))
type Hex = `0x${string}`
const state = await AspState.create()

const labels: Hex[] = Array.from({ length: 40 }, (_, i) => `0x${(BigInt(i + 1) * 1_000_003n + 7n).toString(16)}` as Hex)
const revoked = [labels[4], labels[16], labels[29]] as Hex[]
const reapproved = labels[16] as Hex

for (const label of labels) state.commit(await state.planApprove(label), true)
for (const label of revoked) state.commit(await state.planRevoke(label), true)
const last = await state.planApprove(reapproved)
state.commit(last, true)

const fixture = {
	source: "privacy-pools mock-asp AspState",
	labels,
	revoked,
	reapproved,
	leaves: state.leaves.map((l: Hex) => BigInt(l).toString()),
	root: last.root.toString(),
}
const out = fileURLToPath(new URL("../test/fixtures/mock-asp.json", import.meta.url))
writeFileSync(out, `${JSON.stringify(fixture, null, "\t")}\n`)
spawnSync("bunx", ["biome", "format", "--write", out], { stdio: "inherit" })
console.log(`wrote ${fixture.leaves.length} leaves, root ${fixture.root}`)
