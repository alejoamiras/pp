import { readFileSync } from "node:fs"
import { type Hex, parseAspSnapshot, readRootRecord } from "@pp/label-paths"
import { describe, expect, it } from "vitest"

const MANIFEST = process.env.PP_STACK_MANIFEST
const RUN = process.env.PP_BOT_INTEGRATION === "1" && MANIFEST !== undefined

type Manifest = { aztecNode: string; bridge?: { registry: Hex }; bot?: { url: string; poster: Hex } }

describe.skipIf(!RUN)("the stack's own bot", () => {
	it("is in the manifest and serves the record its registry holds", async () => {
		const m = JSON.parse(readFileSync(MANIFEST as string, "utf8")) as Manifest
		expect(m.bot, "manifest.bot").toBeDefined()
		expect(m.bridge, "manifest.bridge").toBeDefined()
		const { bot, bridge } = m as Required<Manifest>
		const snap = parseAspSnapshot(await (await fetch(`${bot.url}/v1/snapshots/latest`)).json())
		const record = await readRootRecord({ aztecNode: m.aztecNode, registry: bridge.registry })
		expect(record.sequence).toBeGreaterThan(0n)
		expect([snap.sequence, snap.poolRoot, snap.birthRoot]).toEqual([record.sequence, record.poolRoot, record.birthRoot])
	})
})
