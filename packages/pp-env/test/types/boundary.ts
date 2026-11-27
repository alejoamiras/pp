// Compile-time only: pp-env's viem and @pp/pool-client's are different copies, so only plain data
// crosses between them (src/client/spend.ts). A client, account or transport in any of these fails.
import type { PreparedSpend as ClientSpend, openPoolClient } from "@pp/pool-client"
import type { poolClientOptions } from "../../src/client/spend.ts"

type PlainData = string | number | bigint | boolean | null | undefined | readonly PlainData[] | { readonly [k: string]: PlainData }
type Assert<T extends true> = T
type IsPlain<T> = [T] extends [PlainData] ? true : false

export type Boundary = [
	// What pool-client accepts, bar the prover: pool.ts passes it pool-client's own createProver().
	Assert<IsPlain<Omit<Parameters<typeof openPoolClient>[0], "prover">>>,
	Assert<IsPlain<ReturnType<typeof poolClientOptions>>>,
	Assert<IsPlain<ClientSpend>>,
	// @ts-expect-error a field holding a function, as every viem client does, is not plain data
	Assert<IsPlain<{ client: { request: () => Promise<unknown> } }>>,
]
