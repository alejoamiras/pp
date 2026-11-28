import { describe, expect, it, mock } from "bun:test"
import { assertRegistered, registerMissingHalves } from "./keystore.ts"

const owner = "0x00000000000000000000000000000000000000aa"
const derived = { nullifyingKeyHash: 11n, viewingKey: 22n }
const sent = () => mock(async () => [{ status: true }])

describe("registering a keystore's missing halves", () => {
	it.each([
		["nullifying key", { nullifyingKeyHash: 99n, viewingKey: 0n }],
		["viewing key", { nullifyingKeyHash: 0n, viewingKey: 99n }],
	])("refuses a %s already set under other keys and sends nothing", async (half, held) => {
		const send = sent()
		await expect(registerMissingHalves({ owner, held, derived, send })).rejects.toThrow(
			`${owner} is registered under another ${half} than its signature derives; nothing was sent`,
		)
		expect(send).not.toHaveBeenCalled()
	})

	it("sends nothing for an owner whose halves are both its own, sends for a fresh one, and refuses a reverted send", async () => {
		const ours = sent()
		await registerMissingHalves({ owner, held: derived, derived, send: ours })
		expect(ours).not.toHaveBeenCalled()
		const fresh = sent()
		await registerMissingHalves({ owner, held: { nullifyingKeyHash: 0n, viewingKey: 0n }, derived, send: fresh })
		expect(fresh).toHaveBeenCalledTimes(1)
		const reverted = mock(async () => [{ status: true }, { status: false }])
		await expect(
			registerMissingHalves({ owner, held: { nullifyingKeyHash: 11n, viewingKey: 0n }, derived, send: reverted }),
		).rejects.toThrow("keystore registration reverted")
	})
})

describe("checking an existing registration", () => {
	it("passes both halves the owner's, and refuses one half unset or a half under other keys", () => {
		expect(() => assertRegistered(owner, derived, derived)).not.toThrow()
		for (const held of [
			{ nullifyingKeyHash: 11n, viewingKey: 0n },
			{ nullifyingKeyHash: 0n, viewingKey: 22n },
		])
			expect(() => assertRegistered(owner, held, derived)).toThrow(`the keystore holds no complete registration for ${owner}`)
		expect(() => assertRegistered(owner, { nullifyingKeyHash: 11n, viewingKey: 99n }, derived)).toThrow(
			`${owner} is registered under another viewing key than its signature derives`,
		)
		expect(() => assertRegistered(owner, { nullifyingKeyHash: 99n, viewingKey: 22n }, derived)).toThrow(
			`${owner} is registered under another nullifying key than its signature derives`,
		)
	})
})
