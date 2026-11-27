import { encodeErrorResult } from "viem"
import { expect, it } from "vitest"
import { POOL_VAULT_ERRORS_ABI } from "../../src/abi.ts"
import { spendRevertCode } from "../../src/fresh.ts"

const revert = (errorName: (typeof POOL_VAULT_ERRORS_ABI)[number]["name"]) => encodeErrorResult({ abi: POOL_VAULT_ERRORS_ABI, errorName })

it("maps the three stale-root reverts to their codes and nothing else", () => {
	expect(spendRevertCode(revert("PoolVault_UnknownStateRoot"))).toBe("STATE_ROOT_STALE")
	expect(spendRevertCode(revert("PoolVault_UnknownKeystoreRoot"))).toBe("KEYSTORE_ROOT_STALE")
	expect(spendRevertCode(revert("PoolVault_InvalidASPRoot"))).toBe("ASP_ROOT_STALE")
	expect(spendRevertCode(revert("PoolVault_ProofContextMismatch"))).toBeNull()
	expect(spendRevertCode("0xdeadbeef")).toBeNull()
	expect(spendRevertCode("0x")).toBeNull()
})
