/**
 * STRICT schema for the generation manifest (`schema: 2`): one L1 factory + one L2 hub per network,
 * plus the tokens whose portals were pre-created. The local-network harness writes one per boot.
 * `bridge: null` is a legal manifest: the network has no bridge.
 *
 * Every derivable address is RE-DERIVED on parse (portal = CREATE2 of the factory; hub = its
 * salt-and-args instantiation, the salt being the factory itself; l2Token = the hub's in-circuit
 * derivation) and a mismatch fails validation: the manifest may carry a value the contracts would
 * never produce only if the check is skipped, and a stale carried address is the failure this
 * schema exists to make impossible.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { getContractInstanceFromInstantiationParams } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { PublicKeys } from "@aztec-labs/aztec.js/keys"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import type { Hex } from "viem"
import z from "zod"
import { tokenBridgeHubArtifact } from "./artifacts"
import { deriveHubTokenInstance } from "./hub-token"
import { predictPortal } from "./portal-address"

export const evmAddressV2 = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte 0x hex address")
const aztecAddress = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte 0x hex address")
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte 0x hex word")

const l2RecordSchema = z
	.object({
		address: aztecAddress,
		salt: bytes32,
		constructorArtifact: z.string().min(1),
		constructorArgs: z.array(z.unknown()),
	})
	.strict()

export const manifestTokenSchema = z
	.object({
		erc20: evmAddressV2,
		portal: evmAddressV2,
		l2Token: aztecAddress,
		nameWord: bytes32,
		symbolWord: bytes32,
		decimals: z.number().int().min(0).max(255),
		displayName: z.string().min(1),
		displaySymbol: z.string().min(1),
		source: z.enum(["permissionless-mint", "canonical"]),
		sourceContract: z.enum(["MintableERC20", "TestUsdc"]).optional(),
		maxWholePerTx: z.number().positive().optional(),
	})
	.strict()

export const bridgeBlockSchema = z
	.object({
		l1: z
			.object({
				registry: evmAddressV2,
				factory: evmAddressV2,
				implementation: evmAddressV2,
				guardian: evmAddressV2,
			})
			.strict(),
		l2: z
			.object({
				hub: l2RecordSchema,
				guardian: aztecAddress,
				tokenClassId: bytes32,
				tokenArtifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
			})
			.strict(),
		tokens: z.array(manifestTokenSchema),
	})
	.strict()

export const manifestV2Schema = z
	.object({
		schema: z.literal(2),
		network: z.string().min(1),
		l1ChainId: z.number().int().positive(),
		walletChainId: z.number().int().positive(),
		bridge: bridgeBlockSchema.nullable(),
		privateClaimMode: z.literal("salt-v2"),
	})
	.strict()
	.superRefine((m, ctx) => {
		if (!m.bridge) return
		const hubArgs = m.bridge.l2.hub.constructorArgs
		if (
			hubArgs.length !== 3 ||
			hubArgs[0] !== m.bridge.l2.tokenClassId ||
			String(hubArgs[1]).toLowerCase() !== m.bridge.l1.factory.toLowerCase() ||
			hubArgs[2] !== m.bridge.l2.guardian
		) {
			ctx.addIssue({
				code: "custom",
				path: ["bridge", "l2", "hub", "constructorArgs"],
				message: "hub constructorArgs must be [tokenClassId, factory, guardian] matching the manifest",
			})
		}
		if (m.bridge.l2.hub.constructorArtifact !== "constructor") {
			ctx.addIssue({ code: "custom", path: ["bridge", "l2", "hub", "constructorArtifact"], message: "the hub has one constructor" })
		}
		// One factory, one hub: the salt IS the factory address, so a carried hub cannot outlive its generation.
		if (m.bridge.l2.hub.salt.toLowerCase() !== `0x${m.bridge.l1.factory.slice(2).padStart(64, "0")}`.toLowerCase()) {
			ctx.addIssue({
				code: "custom",
				path: ["bridge", "l2", "hub", "salt"],
				message: "hub salt must be the factory address as a field",
			})
		}
		const seen = new Set<string>()
		m.bridge.tokens.forEach((t, i) => {
			const key = t.erc20.toLowerCase()
			if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["bridge", "tokens", i, "erc20"], message: "duplicate token" })
			seen.add(key)
			if (t.source === "permissionless-mint" && !t.sourceContract) {
				ctx.addIssue({
					code: "custom",
					path: ["bridge", "tokens", i, "sourceContract"],
					message: "required for permissionless-mint",
				})
			}
			const expectedPortal = predictPortal(m.bridge?.l1.factory ?? "", m.bridge?.l1.implementation ?? "", t.erc20)
			if (t.portal.toLowerCase() !== expectedPortal) {
				ctx.addIssue({
					code: "custom",
					path: ["bridge", "tokens", i, "portal"],
					message: `portal is not the factory's CREATE2 for this token (expected ${expectedPortal})`,
				})
			}
		})
	})

export type ManifestV2 = z.infer<typeof manifestV2Schema>
export type ManifestToken = z.infer<typeof manifestTokenSchema>
export type BridgeBlock = z.infer<typeof bridgeBlockSchema>

/** Parse-or-throw with path-annotated issues; the synchronous half (no L2 derivation). */
export function parseManifestV2(raw: unknown): ManifestV2 {
	const result = manifestV2Schema.safeParse(raw)
	if (!result.success) {
		const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
		throw new Error(`bridge manifest v2 failed strict validation — ${issues}`)
	}
	return result.data
}

/**
 * The asynchronous half: every token's `l2Token` must be the address the hub derives from the
 * manifest's words (the app registers that instance with the PXE; a wrong one is never minted to).
 */
/** The hub instance the manifest record derives to — every token derivation hangs off this address. */
export async function deriveManifestHub(b: NonNullable<ManifestV2["bridge"]>) {
	const [tokenClassId, factory, guardian] = b.l2.hub.constructorArgs as [string, string, string]
	return getContractInstanceFromInstantiationParams(tokenBridgeHubArtifact, {
		constructorArgs: [Fr.fromHexString(tokenClassId), EthAddress.fromString(factory), AztecAddress.fromStringUnsafe(guardian)],
		constructorArtifact: b.l2.hub.constructorArtifact,
		salt: Fr.fromHexString(b.l2.hub.salt),
		deployer: AztecAddress.ZERO,
		publicKeys: PublicKeys.default(),
	})
}

export async function assertManifestTokensDerive(m: ManifestV2): Promise<void> {
	if (!m.bridge) return
	const derivedHub = await deriveManifestHub(m.bridge)
	if (derivedHub.address.toString().toLowerCase() !== m.bridge.l2.hub.address.toLowerCase()) {
		throw new Error(
			`bridge manifest v2: hub ${m.bridge.l2.hub.address} is not the instantiation of its own record (${derivedHub.address.toString()})`,
		)
	}
	const hub = derivedHub.address
	for (const t of m.bridge.tokens) {
		const inst = await deriveHubTokenInstance(
			hub,
			t.erc20,
			{ nameWord: t.nameWord as Hex, symbolWord: t.symbolWord as Hex, decimals: t.decimals },
			m.bridge.l2.tokenClassId,
		)
		if (inst.address.toString().toLowerCase() !== t.l2Token.toLowerCase()) {
			throw new Error(
				`bridge manifest v2: tokens[${t.erc20}].l2Token ${t.l2Token} is not the hub's derivation ${inst.address.toString()}`,
			)
		}
	}
}

/** Both halves. */
export async function parseManifestV2Strict(raw: unknown): Promise<ManifestV2> {
	const m = parseManifestV2(raw)
	await assertManifestTokensDerive(m)
	return m
}

/** The token record for an ERC-20, or undefined when the manifest does not carry it (a first-time token). */
export function manifestToken(m: ManifestV2, erc20: string): ManifestToken | undefined {
	return m.bridge?.tokens.find((t) => t.erc20.toLowerCase() === erc20.toLowerCase())
}
