import { createHash } from "node:crypto"
import { getSchnorrAccountContractAddress } from "@aztec-labs/accounts/schnorr"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { SANDBOX_ACTOR_SALT } from "@pp/bridge-core/sandbox"
import type { Hex } from "@pp/label-paths"
import { deriveNuloAccountKeys } from "@nulo-sh/wallet-crypto"

export type BotRole = "poster" | "intake"

/**
 * A public, deterministic secret per role and stack: these accounts sign only on a local network, and
 * binding them to the stack's run id gives every stack its own poster.
 */
export function botSecret(role: BotRole, stackRunId: string): Hex {
	const digest = createHash("sha256").update(`pp.local.asp-bot.${role}:${stackRunId}`).digest("hex")
	return new Fr(BigInt(`0x${digest}`) % Fr.MODULUS).toString() as Hex
}

/** The address `createActor` deploys for `secret`: the same Nulo key derivation and Schnorr account. */
async function addressOf(secret: Hex): Promise<Hex> {
	const { signingKey, secretKey } = await deriveNuloAccountKeys(Fr.fromHexString(secret))
	return (await getSchnorrAccountContractAddress(signingKey, new Fr(SANDBOX_ACTOR_SALT), secretKey)).toString() as Hex
}

/** The bot's poster and birth-intake addresses for a stack, derived without a wallet or a network. */
export async function localBotAccounts(stackRunId: string): Promise<{ poster: Hex; birthIntake: Hex }> {
	const [poster, birthIntake] = await Promise.all([
		addressOf(botSecret("poster", stackRunId)),
		addressOf(botSecret("intake", stackRunId)),
	])
	return { poster, birthIntake }
}
