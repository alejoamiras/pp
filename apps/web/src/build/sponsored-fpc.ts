/**
 * The canonical SponsoredFPC's address, derived from its artifact and `SPONSORED_FPC_SALT` the way
 * every wallet and harness here derives it. Build time only: the artifact and the hashing behind
 * the derivation stay in Node, and only the address reaches the target. Loaded on demand, so a
 * fixture build never pays for the Aztec imports.
 */
export async function sponsoredFpcAddress(): Promise<string> {
	const [{ getContractInstanceFromInstantiationParams }, { Fr }, { SPONSORED_FPC_SALT }, { SponsoredFPCContract }] = await Promise.all([
		import("@aztec-labs/aztec.js/contracts"),
		import("@aztec-labs/aztec.js/fields"),
		import("@aztec-labs/constants"),
		import("@aztec-labs/noir-contracts.js/SponsoredFPC"),
	])
	const instance = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(SPONSORED_FPC_SALT) })
	return instance.address.toString()
}
