import { describe, expect, it } from "vitest"
import { deployerWalletOptions } from "./stack-bridge"

describe("deployerWalletOptions", () => {
	it("keeps a real deployer's PXE store off dataDir, so createL2Wallet puts it on tmpfs", () => {
		const base = { aztecNode: "http://127.0.0.1:1", dataDir: "/run/data" }
		expect(deployerWalletOptions({ ...base, l2Deployer: { secret: "0x01", salt: 1n } })).toEqual({
			nodeUrl: base.aztecNode,
			proverEnabled: false,
			sandboxKeysOnly: false,
		})
		expect(deployerWalletOptions({ ...base, proverEnabled: true })).toEqual({
			nodeUrl: base.aztecNode,
			proverEnabled: true,
			sandboxKeysOnly: true,
			dataDirectory: "/run/data/pxe",
		})
	})
})
