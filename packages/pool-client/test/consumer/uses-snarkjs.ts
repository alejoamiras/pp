import { openPoolClient } from "@pp/pool-client"
import { groth16 } from "snarkjs"

// Compiling this package's sources must leave a consumer's own snarkjs types intact.
export const consumer = { groth16, openPoolClient }
