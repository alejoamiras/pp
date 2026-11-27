import { type Address, decodeFunctionData, type Hex, toHex } from "viem"
import { describe, expect, it } from "vitest"
import { KEYSTORE_REGISTRATION_ABI } from "../../src/abi.ts"
import { type OwnRegistration, type RegistrationReader, registrationStep } from "../../src/registration.ts"
import type { PoolConfig, RegistrationStep } from "../../src/types.ts"

const owner: Address = "0x00000000000000000000000000000000000000A1"
const pool: Pick<PoolConfig, "poolVault" | "keystore"> = {
	poolVault: "0x00000000000000000000000000000000000000B1",
	keystore: "0x00000000000000000000000000000000000000c1",
}
const own: OwnRegistration = { authDigest: 11n, nullifyingKeyHash: 22n, viewingKey: toHex(33n, { size: 32 }) }
const UNSET = toHex(0n, { size: 32 })
const OTHER = "0x00000000000000000000000000000000000000d1"

type Chain = { keystore?: Address; nullifying: bigint; viewing: Hex }

function reader(chain: Chain, head = 50n) {
	const reads: { functionName: string; blockNumber: bigint; address: Address; args?: readonly unknown[] }[] = []
	const r: RegistrationReader = {
		head: async () => head,
		readContract: async ({ functionName, blockNumber, address, args }) => {
			reads.push({ functionName, blockNumber, address, ...(args ? { args } : {}) })
			return { keystore: chain.keystore ?? pool.keystore, nullifyingKeys: chain.nullifying, viewingKeys: chain.viewing }[functionName]
		},
	}
	return { r, reads }
}

const decoded = (step: RegistrationStep) => {
	if (step.status !== "send") throw new Error(`no call: ${step.status}`)
	const { call } = step
	expect(Object.isFrozen(step) && Object.isFrozen(call)).toBe(true)
	expect({ from: call.from, to: call.to, value: call.value }).toEqual({ from: owner, to: pool.keystore, value: 0n })
	const { functionName, args } = decodeFunctionData({ abi: KEYSTORE_REGISTRATION_ABI, data: call.data })
	expect(call.function).toBe(functionName)
	return { functionName, args }
}

describe("registrationStep", () => {
	it.each([
		["nothing registered: the auth policy first", { nullifying: 0n, viewing: UNSET }, "setAuthPolicy", [11n, 22n]],
		["the viewing key alone set: still the auth policy", { nullifying: 0n, viewing: own.viewingKey }, "setAuthPolicy", [11n, 22n]],
		["the auth policy set: the viewing key next", { nullifying: 22n, viewing: UNSET }, "setViewingKey", [own.viewingKey]],
	] as const)("%s", async (_, chain, functionName, args) => {
		expect(decoded(await registrationStep(reader(chain).r, pool, owner, own))).toEqual({ functionName, args })
	})

	it("is registered once both keys are this client's, the viewing key compared in any case", async () => {
		const chain = { nullifying: 22n, viewing: own.viewingKey.toUpperCase().replace("0X", "0x") as Hex }
		expect(await registrationStep(reader(chain).r, pool, owner, own)).toEqual({ status: "registered" })
	})

	it.each([
		["the vault reads another keystore", { keystore: OTHER, nullifying: 0n, viewing: UNSET }, "KEYSTORE_MISMATCH"],
		["another nullifying key is registered", { nullifying: 23n, viewing: UNSET }, "REGISTERED_TO_OTHER_KEYS"],
		["another viewing key is set", { nullifying: 22n, viewing: toHex(34n, { size: 32 }) }, "REGISTERED_TO_OTHER_KEYS"],
		[
			"another viewing key is set before any auth policy",
			{ nullifying: 0n, viewing: toHex(34n, { size: 32 }) },
			"REGISTERED_TO_OTHER_KEYS",
		],
	] as const)("refuses when %s", async (_, chain, code) => {
		await expect(registrationStep(reader(chain).r, pool, owner, own)).rejects.toMatchObject({ code })
	})

	it("reads the vault's keystore and the owner's keys at one block, never before `after`", async () => {
		const at = async (head: bigint, after?: bigint) => {
			const { r, reads } = reader({ nullifying: 0n, viewing: UNSET }, head)
			await registrationStep(r, pool, owner, own, after)
			return reads
		}
		expect(await at(50n)).toEqual([
			{ functionName: "keystore", blockNumber: 50n, address: pool.poolVault },
			{ functionName: "nullifyingKeys", blockNumber: 50n, address: pool.keystore, args: [owner] },
			{ functionName: "viewingKeys", blockNumber: 50n, address: pool.keystore, args: [owner] },
		])
		expect((await at(50n, 40n)).map((r) => r.blockNumber)).toEqual([50n, 50n, 50n])
		expect((await at(50n, 60n)).map((r) => r.blockNumber)).toEqual([60n, 60n, 60n])
	})
})
