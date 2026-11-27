import { describe, expect, it } from "vitest"
import { declaredRefusals, fenceArgs } from "./launch"

describe("the fence's switches", () => {
	it("bypass the recorder for owned ports only", () => {
		expect(fenceArgs({ recorderPort: 4000, ownedPorts: [4001, 4002] }, [])).toContain(
			"--proxy-bypass-list=<-loopback>;127.0.0.1:4001;127.0.0.1:4002",
		)
	})

	it("refuse to own a loopback port the fence must refuse, such as the wallet's local prover", () => {
		expect(declaredRefusals()).toContain("127.0.0.1:59834")
		expect(() => fenceArgs({ recorderPort: 4000, ownedPorts: [4001, 59834] })).toThrow(/owned port 59834/)
	})
})
