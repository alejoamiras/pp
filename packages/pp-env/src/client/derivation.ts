import * as poolClient from "@pp/pool-client"
import type { Address } from "viem"
import type { SecretDerivationTypedData } from "./types.ts"

// Annotated, not re-exported bare: test/types/conformance.ts needs exactly types/client.d.ts's types.

/** Part of the signed hash, and so of every derived key: it must never change by a byte. */
export const SECRET_DERIVATION_PURPOSE: string = poolClient.SECRET_DERIVATION_PURPOSE

/** The EIP-712 "Standardized Secret Derivation" payload whose signature roots a user's protocol keys. */
export const secretDerivationTypedData: (signer: Address) => SecretDerivationTypedData = poolClient.secretDerivationTypedData
