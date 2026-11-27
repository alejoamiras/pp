import { BaseError, ContractFunctionRevertedError, decodeFunctionData } from "viem"
import { expect, inject, it } from "vitest"
import { KEYSTORE_REGISTRATION_ABI } from "../../src/abi.ts"
import { openPoolClient, type RegistrationStep } from "../../src/index.ts"
import { poolConfig, type UpEnv } from "../support/env.ts"
import { circuitsDir } from "../support/paths.ts"
import { seeder } from "../support/seed.ts"
import { anvilAccount, derivationSignature } from "../support/users.ts"

const env = JSON.parse(inject("poolEnv")) as UpEnv
const pool = poolConfig(env)
/** No other suite registers this account. */
const OWNER = 7
const SUBMITTER = 11

const callOf = (step: RegistrationStep) => {
	if (step.status !== "send") throw new Error("expected a call")
	return step.call
}

it("registers one step at a time across a reload, spends after it, and a registered owner's seed sends nothing", async () => {
	const seed = seeder(env)
	const owner = anvilAccount(OWNER).address
	const signature = await derivationSignature(OWNER)
	const open = () => openPoolClient({ pool, l1Address: owner, signature, artifacts: { kind: "dir", path: circuitsDir() } })

	const first = callOf(await (await open()).registrationStep())
	expect(first).toMatchObject({ function: "setAuthPolicy", from: owner, to: pool.keystore, value: 0n })
	const mined = await seed.send(OWNER, first)

	// What a resent first step does: the keystore refuses a second auth policy for the same sender.
	const { args } = decodeFunctionData({ abi: KEYSTORE_REGISTRATION_ABI, data: first.data })
	const again = await seed.client
		.simulateContract({
			account: owner,
			address: pool.keystore,
			abi: KEYSTORE_REGISTRATION_ABI,
			functionName: "setAuthPolicy",
			args: args as [bigint, bigint],
		})
		.then(
			() => null,
			(e: unknown) => (e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null),
		)
	expect(again instanceof ContractFunctionRevertedError ? again.data?.errorName : again).toBe("Keystore_AuthPolicyAlreadySet")

	const resumed = await open()
	const second = callOf(await resumed.registrationStep(mined.blockNumber))
	expect(second).toMatchObject({ function: "setViewingKey", from: owner, to: pool.keystore, value: 0n })
	const done = await seed.send(OWNER, second)
	expect(await resumed.registrationStep(done.blockNumber)).toEqual({ status: "registered" })

	const user = await seed.user(OWNER)
	expect(await user.register()).toEqual([])
	await seed.mint(owner, 10n)
	const note = await user.deposit(10n)
	await seed.approveLabel(note.label)
	const stub = await seed.deployStub()
	await resumed.notes()
	const spend = await resumed.prepareSpend({ note: note.commitment, amount: 4n, processor: stub, data: "0x01" })
	expect(await seed.submit(stub, spend, SUBMITTER)).toMatchObject({ amount: 4n })
})
