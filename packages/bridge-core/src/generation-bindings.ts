/**
 * A generation's L1 bindings read back from chain and compared with what its deployer chose. Nothing
 * can sweep a clone, so a spend accepted by a portal bound to another hub, vault or cap is stuck for
 * good: the guardian opens entries only once this passes.
 */
import type { Address, Hex, PublicClient } from "viem"
import { PORTAL_FACTORY_ABI, PROCESSOR_PORTAL_ABI } from "./factory-abi"

export interface ExpectedBindings {
	factory: Address
	implementation: Address
	/** The L2 hub's Aztec address, as the 32-byte word the contracts store. */
	hub: Hex
	/** The factory's owner, the only key that can open or close entries. */
	guardian: Address
	pool: Address
	lifetimeCap: bigint
	/** Portals that must already exist, each holding its token. Empty before the first `createPortal`. */
	portals: readonly { token: Address; portal: Address }[]
}

/** The first binding that disagreed. `binding` names the read, e.g. `implementation.POOL`. */
export class BindingMismatchError extends Error {
	constructor(
		readonly binding: string,
		readonly actual: string,
		readonly expected: string,
		label: string,
	) {
		super(`${label}: ${binding} is ${actual}, expected ${expected}`)
		this.name = "BindingMismatchError"
	}
}

export type BindingsClient = Pick<PublicClient, "readContract">

/**
 * Reads the factory's `IMPLEMENTATION`, `L2_HUB` and `owner`; the implementation's `FACTORY`,
 * `L2_HUB`, `POOL` and `LIFETIME_CAP`; and for each expected portal, `portalOf(token)` and the
 * clone's `underlying()`. The implementation is read only after the factory is shown to point at it.
 * Says nothing about the entry pause: opening it is the caller's next step.
 *
 * @param label prefixes the error message, naming which deploy path or caller ran the check.
 * @throws BindingMismatchError at the first disagreement; a failed read rejects with viem's error.
 */
export async function assertGenerationBindings(client: BindingsClient, expected: ExpectedBindings, label = "generation"): Promise<void> {
	const check = (binding: string, actual: string | bigint, want: string | bigint) => {
		if (String(actual).toLowerCase() !== String(want).toLowerCase())
			throw new BindingMismatchError(binding, String(actual), String(want), label)
	}
	const factory = { address: expected.factory, abi: PORTAL_FACTORY_ABI } as const
	const implementation = { address: expected.implementation, abi: PROCESSOR_PORTAL_ABI } as const

	check("factory.IMPLEMENTATION", await client.readContract({ ...factory, functionName: "IMPLEMENTATION" }), expected.implementation)
	check("factory.L2_HUB", await client.readContract({ ...factory, functionName: "L2_HUB" }), expected.hub)
	check("factory.owner", await client.readContract({ ...factory, functionName: "owner" }), expected.guardian)
	check("implementation.FACTORY", await client.readContract({ ...implementation, functionName: "FACTORY" }), expected.factory)
	check("implementation.L2_HUB", await client.readContract({ ...implementation, functionName: "L2_HUB" }), expected.hub)
	check("implementation.POOL", await client.readContract({ ...implementation, functionName: "POOL" }), expected.pool)
	check(
		"implementation.LIFETIME_CAP",
		await client.readContract({ ...implementation, functionName: "LIFETIME_CAP" }),
		expected.lifetimeCap,
	)
	for (const { token, portal } of expected.portals) {
		check(`factory.portalOf(${token})`, await client.readContract({ ...factory, functionName: "portalOf", args: [token] }), portal)
		check(
			`${portal}.underlying`,
			await client.readContract({ address: portal, abi: PROCESSOR_PORTAL_ABI, functionName: "underlying" }),
			token,
		)
	}
}
