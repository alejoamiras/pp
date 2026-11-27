import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { computeSiloedPrivateInitializationNullifier } from "@aztec-labs/stdlib/hash"
import { describe, expect, it } from "vitest"
import { tokenBridgeHubArtifact } from "../src/artifacts"
import { deriveHubTokenInstance } from "../src/hub-token"
import type { ManifestToken } from "../src/manifest-v2"
import { deployAccountIfAbsent, deriveInstance, registerHub, registerHubToken } from "./script-l2"

const FACTORY = "0x3333333333333333333333333333333333333333"
const ASP_REGISTRY = `0x${"0".repeat(61)}ab1`
/** The committed LabelledToken class — the same pin as noir-artifact-classids.test.ts. */
const TOKEN_CLASS_ID = "0x1433444ed316fe06e46c3dfb026089b3488dc8b76162d768384a906f6a0c0bbc"
const ERC20 = "0x00000000000000000000000000000000000e2c20"
const HUB_SALT = `0x${"0".repeat(24)}${FACTORY.slice(2)}`

const hubArgs = [Fr.fromHexString(TOKEN_CLASS_ID), EthAddress.fromString(FACTORY), AztecAddress.fromStringUnsafe(ASP_REGISTRY)]

const manifestToken = (l2Token: string): ManifestToken => ({
	erc20: ERC20,
	portal: "0x00000000000000000000000000000000000000a1",
	l2Token,
	nameWord: "0x005465737420546f6b656e000000000000000000000000000000000000000000",
	symbolWord: "0x0054535400000000000000000000000000000000000000000000000000000000",
	decimals: 18,
	displayName: "Test Token",
	displaySymbol: "TST",
	source: "permissionless-mint",
	sourceContract: "TestUsdc",
})

/** Records what a script taught the wallet; `Contract.at` only reads the artifact, never the wallet. */
function fakeWallet() {
	const registered: { classes: number; instances: string[] } = { classes: 0, instances: [] }
	const wallet = {
		registerContractClass: async () => {
			registered.classes += 1
		},
		registerContract: async (instance: { address: { toString: () => string } }) => {
			registered.instances.push(instance.address.toString())
		},
	}
	return { wallet: wallet as unknown as Wallet, registered }
}

describe("script-l2", () => {
	it("deriveInstance is deployer-sensitive: the same salt and args under a different deployer is a different address", async () => {
		const salt = Fr.fromHexString(HUB_SALT)
		const universal = await deriveInstance(tokenBridgeHubArtifact, hubArgs, "constructor", salt, AztecAddress.ZERO)
		const deployed = await deriveInstance(
			tokenBridgeHubArtifact,
			hubArgs,
			"constructor",
			salt,
			AztecAddress.fromStringUnsafe(ASP_REGISTRY),
		)
		expect(universal.address.toString()).not.toBe(deployed.address.toString())
		expect(universal.deployer.isZero()).toBe(true)
	})

	it("registerHub asserts the recorded address, then registers the class and the instance", async () => {
		const expected = await deriveInstance(tokenBridgeHubArtifact, hubArgs, "constructor", Fr.fromHexString(HUB_SALT), AztecAddress.ZERO)
		const record = {
			address: expected.address.toString(),
			salt: HUB_SALT,
			constructorArtifact: "constructor",
			constructorArgs: [TOKEN_CLASS_ID, FACTORY, ASP_REGISTRY],
		}
		const { wallet, registered } = fakeWallet()
		const hub = await registerHub(wallet, record)
		expect(hub.address.toString()).toBe(record.address)
		expect(registered).toEqual({ classes: 1, instances: [record.address] })

		const guard = fakeWallet()
		await expect(registerHub(guard.wallet, { ...record, address: `0x${"11".repeat(32)}` })).rejects.toThrow(
			/manifest hub mismatch: derived .* != recorded/,
		)
	})

	it("registerHubToken asserts the hub's derivation for the token and registers it", async () => {
		const hub = AztecAddress.fromStringUnsafe("0x1234000000000000000000000000000000000000000000000000000000000abc")
		const derived = await deriveHubTokenInstance(
			hub,
			ERC20,
			manifestToken("0x0"),
			TOKEN_CLASS_ID,
			AztecAddress.fromStringUnsafe(ASP_REGISTRY),
		)
		const token = manifestToken(derived.address.toString())

		const { wallet, registered } = fakeWallet()
		const contract = await registerHubToken(wallet, hub, token, TOKEN_CLASS_ID, ASP_REGISTRY)
		expect(contract.address.toString()).toBe(token.l2Token)
		expect(registered.instances).toEqual([token.l2Token])

		const guard = fakeWallet()
		await expect(
			registerHubToken(guard.wallet, hub, { ...token, l2Token: `0x${"11".repeat(32)}` }, TOKEN_CLASS_ID, ASP_REGISTRY),
		).rejects.toThrow(/manifest token TST mismatch/)
	})

	it("deployAccountIfAbsent no-ops when the node serves the account OR its init nullifier exists, else sends NO_FROM with the fee", async () => {
		const log: string[] = []
		const from = AztecAddress.fromStringUnsafe(`0x${"1".padStart(64, "0")}`)
		const instance = { initializationHash: new Fr(7) }
		const expectedNullifier = await computeSiloedPrivateInitializationNullifier(from, instance.initializationHash)
		const refusing = {
			getDeployMethod: async () => {
				throw new Error("must not deploy")
			},
			getInstance: () => instance,
		}
		const served = {
			node: { getContract: async () => ({}), getNullifierMembershipWitness: async () => undefined },
			manager: refusing,
			from,
			fee: { paymentMethod: "sponsored" },
			log: (s: string) => log.push(s),
		}
		await deployAccountIfAbsent(served as never)
		expect(log).toEqual([])

		// An account deploy publishes no instance: the node never serves it, only its init nullifier.
		const witnessed: Fr[] = []
		const initialized = {
			...served,
			node: {
				getContract: async () => undefined,
				getNullifierMembershipWitness: async (_b: string, n: Fr) => {
					witnessed.push(n)
					return n.equals(expectedNullifier) ? {} : undefined
				},
			},
		}
		await deployAccountIfAbsent(initialized as never)
		expect(witnessed).toEqual([expectedNullifier])
		expect(log).toEqual([])

		let sent: { fee: unknown; from: unknown } | undefined
		const absent = {
			node: { getContract: async () => undefined, getNullifierMembershipWitness: async () => undefined },
			manager: {
				getDeployMethod: async () => ({
					send: async (o: { fee: unknown; from: unknown }) => {
						sent = o
					},
				}),
				getInstance: () => instance,
			},
			from,
			fee: { paymentMethod: "sponsored" },
			log: (s: string) => log.push(s),
		}
		await deployAccountIfAbsent(absent as never)
		expect(sent?.from).toBe("NO_FROM")
		expect(sent?.fee).toEqual({ paymentMethod: "sponsored" })
		expect(log).toEqual(["deploying", "deployed"])
	})
})
