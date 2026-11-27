/**
 * The pool view of a stack build, against the local stack's seeded pool. Payer: none; nothing is
 * sent. Estimated 30 s, measured 5 s on a 192-core host: one in-browser sign-in with its note
 * sync, one pool client in Node, and the three proving files over loopback.
 */
import { expect, test } from "@pp/e2e-kit/fixtures/test.ts"
import { PROVED_PINS as p } from "../src/data/adapters/circuit"
import { formatAmount, labelHex } from "../src/ui/format"
import { seededStack } from "./stack"
import { signInToPool, watchPage } from "./support"

test.use({ family: "pool", cells: 0, spares: 0 })
test.skip(({ run }) => run.mode !== "stack", "the sandbox build shows the fixture world's pool, not a chain's")

// Fails if the stack build's session does not open in the browser (pool-client and the bridge client
// under the CSP, cross-origin isolation and the polyfills), if the notes it lists by label differ from
// what pool-client reads in Node for the same keys, in the decimals the factory registered, if the CSP refuses the ASP API, the bot or the
// page's own proving-file routes, or if `serve` hands out bytes other than the pinned ones.
test("lists the seeded user's notes by label as pool-client reads them, every stack origin under the CSP", async ({ page, run }) => {
	const watch = await watchPage(page)
	const { manifest, pool, decimals } = await seededStack(run)
	const expected = (await pool.notes()).filter((n) => n.value > 0n && n.status === "approved")
	expect(expected.length, "two approved notes with value left, a bridged note's change included").toBe(2)

	const aspOrigin = new URL(manifest.pool.aspApiUrl).origin
	const aspStatuses: number[] = []
	page.on("response", (r) => {
		if (new URL(r.url()).origin === aspOrigin) aspStatuses.push(r.status())
	})
	await page.goto("/")
	await signInToPool(page)
	const rows = page.getByTestId("note-row")
	await expect(rows).toHaveCount(expected.length)
	for (const note of expected) {
		const row = page.locator(`[data-testid="note-row"][data-commitment="${note.commitment}"]`)
		await expect(row.locator("[data-label]")).toHaveAttribute("data-label", labelHex(note.label))
		await expect(row).toContainText(formatAmount(note.value, decimals, 2))
	}
	expect(aspStatuses, "the page read the ASP API").toContain(200)

	// Sign-in fetches no bot snapshot, and its proving-file prefetch shows the test no bytes, so the
	// page fetches them itself: its own CSP applies, and the digests prove which bytes `serve` handed out.
	const pins = [
		[p.wasm, p.wasmSha256],
		[p.provingKey, p.provingKeySha256],
		[p.verificationKey, p.verificationKeySha256],
	]
	const fetched = await page.evaluate(
		async ({ botUrl, cids }) => {
			const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("")
			const bot = (await fetch(botUrl)).status
			const digests = await Promise.all(
				cids.map(async (cid) => hex(await crypto.subtle.digest("SHA-256", await (await fetch(`/${cid}`)).arrayBuffer()))),
			)
			return { bot, digests }
		},
		{ botUrl: new URL("/v1/snapshots/latest", manifest.bot.url).href, cids: pins.map(([cid]) => cid as string) },
	)
	expect(fetched.bot, "the bot's latest snapshot").toBe(200)
	expect(fetched.digests).toEqual(pins.map(([, sha]) => sha?.toLowerCase().replace(/^0x/, "")))
	await watch.clean()
})
