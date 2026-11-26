/**
 * Recipient-committed private-claim secret derivation — the TS mirror of the Noir
 * `claim_secret_lib::derive_claim_secret` (contracts/bridge/aztec/claim_secret/src/lib.nr).
 *
 * The Inbox message of a bridge commits `secretHash = computeSecretHash(deriveTokenClaimSecret(salt,
 * recipient))`; the hub's claim re-derives the secret from its own caller and consumes the message, so a
 * claim from any other account derives a different secret whose hash can't match. Security comes from
 * there being no raw-secret consumption path anywhere (sole-consumer invariant), not from the secret
 * staying private.
 *
 * The derivation MUST byte-match the Noir side; the keystone (claim-secret.test.ts here + keystone/src/main.nr)
 * pins both toolchains against fixed vectors so an `@aztec` crypto change can never silently strand a deposit.
 */
import { poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/sync"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { computeSecretHash } from "@aztec-labs/stdlib/hash"

/**
 * Domain separator: `poseidon2_hash_bytes("unleashed_dom_sep__token_bridge_private_claim_secret") as u32`.
 * Mirrors the Noir `DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET`. PINNED as a literal (NOT computed at
 * load): a poseidon call at module-load time crashes non-node consumers (the tools app's jsdom test env
 * throws before Barretenberg is initialized). The keystone test
 * re-derives this in node and asserts equality; that is the drift tripwire. Distinct from the FPC fuel
 * separator (3952304070) and the protocol secret-hash separator (4199652938) — cross-protocol reuse hygiene.
 */
export const DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET = 2317478496

/**
 * The claim secret a private token-bridge deposit binds to: `poseidon2([salt, recipient], DOM_SEP)`.
 * The claim reconstructs it from its caller, so a RANDOM secret would strand the bridge.
 *
 * PRIVACY INVARIANT — `salt` MUST be unpredictable to observers: a full-entropy random field, or a PRF
 * output under a secret key (`deriveClaimSalt`). The `secret_hash` is written to L1 IN THE CLEAR and the
 * amount is public, so a guessable `salt` lets an observer brute-force `(salt, recipient)` and
 * DE-ANONYMIZE the recipient BEFORE the claim — no salt leak required. Pinned by `claim-secret.test.ts`.
 */
export const deriveTokenClaimSecret = (salt: Fr, recipient: AztecAddress): Fr =>
	poseidon2HashWithSeparator([salt, recipient], DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET)

/** The Inbox message's `secretHash` — `computeSecretHash` of the derived secret. */
export const tokenClaimSecretHash = (salt: Fr, recipient: AztecAddress): Promise<Fr> =>
	computeSecretHash(deriveTokenClaimSecret(salt, recipient))
