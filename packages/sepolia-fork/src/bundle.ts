// The pre-ceremony circuits, pinned only in pool-client's reviewed table. The cache saves a download and is
// never trusted: every file is hashed against the table on every run, before any prover reads it.
import { createHash, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { CIRCUIT_BUNDLES, createArtifacts } from "@pp/pool-client"
import type { CleanupStack } from "@pp/run-isolation/process"
import { SEPOLIA_CHAIN_ID } from "./pins.ts"
import type { BundleVkeys } from "./preflight.ts"

export const BUNDLE = "pre-ceremony" as const
export const CIRCUITS = ["deposit", "transact_1x1"] as const
/** The public gateways that serve these digests; ipfs.io, dweb.link and w3s.link answer with a stub page. */
export const GATEWAYS = ["https://gateway.pinata.cloud/ipfs", "https://ipfs.filebase.io/ipfs"] as const
const ARTIFACTS_DIR = join(homedir(), ".cache/pp/fork/artifacts")
/** Per file: the 18 MB transact key from a slow gateway. */
const DOWNLOAD_DEADLINE_MS = 300_000

/** The SDK's directory layout, which pp-env's prover and pool-client's dir source both read. */
const ON_DISK = {
	getWasm: (c: string) => `${c}/${c}_js/${c}.wasm`,
	getProvingKey: (c: string) => `${c}/groth16_pkey.zkey`,
	getVerificationKey: (c: string) => `${c}/groth16_vkey.json`,
} as const

/** Names the cache after the pins it must hold, so a changed table never reads an older download. */
export function bundleDigest(): string {
	const pins = CIRCUIT_BUNDLES[BUNDLE].circuits
	const subset = Object.fromEntries(CIRCUITS.map((c) => [c, pins[c]]))
	return createHash("sha256").update(JSON.stringify(subset)).digest("hex").slice(0, 16)
}

/** @throws PoolClientError `ARTIFACT_MISMATCH` naming the circuit and file that breaks a pin */
export async function checkBundleDir(dir: string): Promise<void> {
	const artifacts = createArtifacts({ kind: "dir", path: dir, bundle: BUNDLE }, { chainId: SEPOLIA_CHAIN_ID })
	for (const circuit of CIRCUITS) await artifacts.ensure(circuit)
}

/** The bundle's directory: downloaded once, published whole, and hashed again on every call. */
export async function bundleDir(
	o: { root?: string; fetch?: typeof fetch; log?: (line: string) => void; cleanup?: CleanupStack } = {},
): Promise<string> {
	const root = o.root ?? ARTIFACTS_DIR
	const dir = join(root, bundleDigest())
	if (!existsSync(dir)) {
		const t0 = performance.now()
		await download(root, dir, o.fetch, o.cleanup)
		o.log?.(`fetched the ${BUNDLE} circuits in ${Math.round(performance.now() - t0)} ms`)
	}
	await checkBundleDir(dir)
	return dir
}

/** The verification keys of a directory {@link bundleDir} has just hashed. */
export async function readVkeys(dir: string): Promise<BundleVkeys> {
	const read = async (c: string) => JSON.parse(await readFile(join(dir, ON_DISK.getVerificationKey(c)), "utf8"))
	return { deposit: await read("deposit"), transact_1x1: await read("transact_1x1") }
}

async function download(root: string, dir: string, fetchImpl: typeof fetch | undefined, cleanup?: CleanupStack): Promise<void> {
	const tmp = join(root, `.partial-${process.pid}-${randomBytes(4).toString("hex")}`)
	await mkdir(tmp, { recursive: true })
	// A deadline abandons this download mid-fetch, so its `finally` may never run; teardown removes it then.
	cleanup?.push(() => rm(tmp, { recursive: true, force: true }))
	try {
		const remote = createArtifacts(
			{ kind: "gateway", urls: [...GATEWAYS], bundle: BUNDLE },
			{ chainId: SEPOLIA_CHAIN_ID, deadlineMs: DOWNLOAD_DEADLINE_MS, ...(fetchImpl && { fetch: fetchImpl }) },
		)
		for (const circuit of CIRCUITS)
			for (const [getter, path] of Object.entries(ON_DISK) as [keyof typeof ON_DISK, (c: string) => string][]) {
				const file = join(tmp, path(circuit))
				await mkdir(dirname(file), { recursive: true })
				await writeFile(file, await remote[getter](circuit))
			}
		await checkBundleDir(tmp)
		// A concurrent run that published first leaves `dir` in place; its files are hashed like these.
		await rename(tmp, dir).catch((err: unknown) => {
			if (!existsSync(dir)) throw err
		})
	} finally {
		await rm(tmp, { recursive: true, force: true })
	}
}
