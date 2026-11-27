// Module worker entry for `workerProver`. Import it from the app's own worker file, then
// `workerProver(new Worker(new URL("./that-file.ts", import.meta.url), { type: "module" }))`.
import "./shim.ts"
import { createProver } from "./runtime/prover.ts"
import { type ProverPort, serveProver } from "./runtime/worker-prover.ts"

serveProver(globalThis as unknown as ProverPort, createProver())
