import { type Note, NoteStatus } from "@0xbow/privacy-pools-v2-sdk"
import { expect, it } from "vitest"
import { toNoteView } from "../../src/client.ts"

it("maps all seven SDK statuses", () => {
	const view = (status: NoteStatus) =>
		toNoteView({
			commitment: "0x01",
			label: "0x02",
			value: "0x03",
			tokenId: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
			status,
		} as unknown as Note).status
	expect(Object.values(NoteStatus).map(view)).toEqual(["inactive", "pending", "approved", "spent", "exiting", "exited", "revoked"])
	expect(Object.values(NoteStatus)).toEqual(["INACTIVE", "PENDING", "ACTIVE", "SPENT", "EXIT_PENDING", "EXITED", "REJECTED"])
})
