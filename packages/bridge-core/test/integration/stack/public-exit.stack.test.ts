import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { describe, expect, it } from "vitest"
import { labelledTokenArtifact } from "../../../src/artifacts"
import { callPayload, sponsored } from "../../../src/client/payload"
import { labelBalance, publicBalance, send, sender } from "./support/actors"
import { exitKit, freshPayee } from "./support/exit-kit"
import { poolPath } from "./support/pool-path"

const k = exitKit("public-exit")

describe("public exit", () => {
	it("X1 unshields 25 of a claimed 40, exits that public balance through the client, and settles exactly 25", async () => {
		await k.timed("X1", async () => {
			const { client, holder, label } = await k.claimed(100n, [40n])
			const dev = k.dev()
			// The suite runs one file at a time and every approval is an actor's own call, so no other
			// label is approved between this read and the unshield's inclusion.
			const path = await poolPath(k.m, dev, label)
			const arg = { index: path.index, depth: path.depth, siblings: [...path.siblings] }
			const unshield = await callPayload(labelledTokenArtifact, dev.token, "unshield", [25n, new Fr(label), arg])
			await send(dev, holder.address, await sponsored(unshield))
			expect(await labelBalance(dev, holder.address, label)).toBe(15n)
			expect(await publicBalance(dev, holder.address)).toBe(25n)

			const payee = freshPayee()
			const burn = await send(dev, holder.address, await client.exitPublicPayload({ payee, amount: 25n }))
			expect(await publicBalance(dev, holder.address)).toBe(0n)

			const [ticket, ...rest] = await client.exitTickets({ payee })
			expect(rest).toEqual([])
			expect(ticket).toMatchObject({ kind: "public", payee, amount: 25n, l2TxHash: burn.txHash.toString() })
			await k.until(client, ticket!, "ready")
			await client.settle(ticket!, await sender(k.m))
			expect(await k.balanceOf(payee)).toBe(25n)
			expect(await client.exitStatus(ticket!)).toBe("settled")
		})
	})
})
