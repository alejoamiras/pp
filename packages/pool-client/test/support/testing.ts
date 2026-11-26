/**
 * `@pp/pool-client/testing`: test support, not product surface. It seeds users, notes, labels and stub
 * processors on a running `pp-env up` over viem; the client itself never registers or deposits.
 * Node and Bun only: it reads pp-env's fetched circuits and compiled fixtures from disk.
 */
export { poolConfig, type UpEnv } from "./env.ts"
export { type Seeder, type Simulation, seeder, spendArgs } from "./seed.ts"
export { anvilAccount, derivationSignature } from "./users.ts"
