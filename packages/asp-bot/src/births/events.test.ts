import { labelledTokenArtifact } from "@pp/labelled-token"
import { describe, expect, it } from "vitest"
import { eventMeta } from "./events"

describe("the token's birth events", () => {
	// The reader decodes these by field name: a renamed or retyped field must fail here, not match nothing.
	it("keep the selectors and fields the reader decodes", async () => {
		const [announced, debited] = await Promise.all([
			eventMeta(labelledTokenArtifact, "BirthAnnouncement"),
			eventMeta(labelledTokenArtifact, "ShieldDebited"),
		])
		expect([announced.eventSelector.toString(), announced.fieldNames]).toEqual(["0x778870e7", ["label", "secret", "owner", "amount"]])
		expect([debited.eventSelector.toString(), debited.fieldNames]).toEqual(["0xeefdfab5", ["birth_id", "owner", "amount"]])
		await expect(eventMeta(labelledTokenArtifact, "Missing")).rejects.toThrow("has no event Missing")
	})
})
