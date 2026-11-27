import { describe, expect, test, vi } from "vitest"
import { fixtureAztec } from "./aztec"
import { ACCOUNTS, LABELS } from "./seed"
import { createWorld } from "./world"

describe("the fixture Aztec port", () => {
	test.each(["transferPrivate", "unshield"] as const)(
		"%s refuses before the handoff what one transaction cannot spend, as the stack port does",
		async (op) => {
			const w = createWorld({ chainId: 31337, storage: null })
			const aztec = fixtureAztec(w)
			const owner = ACCOUNTS.aztec
			const total = (await aztec.notesByLabel(owner, LABELS.active)).reduce((a, b) => a + b, 0n)
			const handoff = vi.fn()
			const a = { to: owner, amount: total + 1n, label: LABELS.active, origin: 0 as const }
			await expect(aztec[op](owner, a, { epoch: 0, handoff })).rejects.toMatchObject({ code: "OVER_NOTE_CAP" })
			expect(handoff).not.toHaveBeenCalled()
		},
	)
})
