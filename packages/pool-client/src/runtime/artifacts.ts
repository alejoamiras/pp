import { type ArtifactFile, PoolClientError } from "../errors.ts"
import {
	type CircuitArtifactCIDs,
	DEFAULT_CIRCUIT_MANIFEST,
	type ICircuitArtifacts,
	type IHTTPClient,
	IpfsCircuitArtifacts,
	LocalCircuitArtifacts,
} from "../sdk.ts"
import { cacheStorageStore, sha256Hex } from "./cache-store.ts"

/** A manifest entry plus each file's byte size: the gateway reader needs a cap before it buffers. */
export type PinnedCircuit = CircuitArtifactCIDs & { sizes: Readonly<Record<ArtifactFile, number>> }

/**
 * Pins for every circuit a bundle proves. The witness generator and proving key run over the user's
 * pool keys, which are the same on every chain, so bundles are reviewed code chosen by name, never
 * a manifest a caller builds.
 */
export type CircuitBundle = {
	readonly circuits: Readonly<Record<string, PinnedCircuit>>
	/** The only chains it may prove for; absent means any. */
	readonly chainIds?: readonly number[]
}

export const CIRCUIT_BUNDLES = {
	/** The pool's ceremony keys, as the SDK this package depends on ships them. */
	ceremony: {
		circuits: {
			transact_1x1: {
				...DEFAULT_CIRCUIT_MANIFEST.transact_1x1!,
				sizes: { wasm: 3_239_462, provingKey: 18_144_961, verificationKey: 4_528 },
			},
			deposit: {
				...DEFAULT_CIRCUIT_MANIFEST.deposit!,
				sizes: { wasm: 2_337_270, provingKey: 1_234_244, verificationKey: 3_741 },
			},
		},
	},
	/**
	 * The keys of the pool's Sepolia deployments, from a single-party setup that predates its ceremony:
	 * whoever ran that setup can forge proofs these verifiers accept, so it is refused off Sepolia.
	 * CIDs and digests are `DEFAULT_CIRCUIT_MANIFEST` of npm `@0xbow/privacy-pools-v2-sdk@1.0.0` (tarball
	 * sha256 c20f251e4813b4db354010521f042d1b9de84115ac230cbd63591e106a763a2d); sizes are those files'.
	 * The two wasm files are byte-identical to the ceremony's.
	 */
	"pre-ceremony": {
		chainIds: [11_155_111],
		circuits: {
			deposit: {
				wasm: "QmbFwUiZywpkCd9AYr3xiVJN2K99ma7raz5FvAS8A8j8DD",
				wasmSha256: "833e7b3c44a900a95496009a36284e11f57ba0385fab6b63f92075750817550a",
				provingKey: "QmapgvDJc2ZSA3FLi9YwA7vd7QNThD2LKa17Zyn4pnDQ6S",
				provingKeySha256: "0e64b6d15ea540b3ab04d5596ab45d1ed6df0872e0261a850039372104837b30",
				verificationKey: "QmPiRu7icgKrxer7DRHwiWHwpyT2UxCfm475FSA5z8APuM",
				verificationKeySha256: "cc0c1647983f2ca75b192e5c671b9b2932fd690709922bf32443a4053cd0912a",
				sizes: { wasm: 2_337_270, provingKey: 1_031_707, verificationKey: 3_744 },
			},
			transact_1x1: {
				wasm: "QmYLFBpsJzeKXDfxcKdwz4rrhZTDoWiYyHNkDyreFrFrau",
				wasmSha256: "bd13ab4130320f095cdee83b42e27877fc6c17f18be3fbdfc55436d33689d262",
				provingKey: "QmTwJqccgYF7bVvVDVHFGnB96tXQLyhRLohaFm3drKs1hr",
				provingKeySha256: "ba00dc63d1ef0b09a49dbf9348430362ef18dca5309ad5b6f06a896349c4c80a",
				verificationKey: "QmfN4QBhkz5NAoo9yd4L8gKjNkap2R4LSKE6yVNS26m4Rh",
				verificationKeySha256: "e429d3e895de5cc9d2839a3fd8303fadd30be3759bac06ce7fb063ceda198308",
				sizes: { wasm: 3_239_462, provingKey: 17_942_432, verificationKey: 4_531 },
			},
		},
	},
} as const satisfies Readonly<Record<string, CircuitBundle>>

export type CircuitBundleName = keyof typeof CIRCUIT_BUNDLES

export const PINNED_CIRCUITS: Readonly<Record<string, PinnedCircuit>> = CIRCUIT_BUNDLES.ceremony.circuits

/** Where circuit files come from, and which bundle pins them (default `ceremony`). */
export type ArtifactSource =
	| { kind: "gateway"; urls: readonly string[]; bundle?: CircuitBundleName }
	| { kind: "dir"; path: string; bundle?: CircuitBundleName }

export type ArtifactOptions = {
	/** The chain the proofs are for; a bundle limited to other chains, or to any chain when this is absent, is refused. */
	chainId?: number
	/** Per gateway file, covering the whole body. */
	deadlineMs?: number
	fetch?: typeof fetch
}

/**
 * The named bundle, if it may prove for `chainId`. A name from untyped data is checked as well.
 * @throws PoolClientError `ARTIFACT_MISMATCH` for an unknown name, `CHAIN_MISMATCH` for a chain the bundle excludes
 */
export function circuitBundle(name: CircuitBundleName = "ceremony", chainId?: number): CircuitBundle {
	if (!Object.hasOwn(CIRCUIT_BUNDLES, name))
		throw new PoolClientError("ARTIFACT_MISMATCH", `unknown circuit bundle ${JSON.stringify(name)}`)
	const bundle: CircuitBundle = CIRCUIT_BUNDLES[name]
	if (bundle.chainIds !== undefined && (chainId === undefined || !bundle.chainIds.includes(chainId)))
		throw new PoolClientError("CHAIN_MISMATCH", `circuit bundle ${name} may not prove for chain ${chainId ?? "unspecified"}`)
	return bundle
}

export interface VerifiedArtifacts extends ICircuitArtifacts {
	/** Loads and verifies all three files of `circuit` once; throws `ARTIFACT_MISMATCH` naming circuit and file. */
	ensure(circuit: string): Promise<void>
}

const FILES = ["wasm", "provingKey", "verificationKey"] as const
const GETTER = { wasm: "getWasm", provingKey: "getProvingKey", verificationKey: "getVerificationKey" } as const
type Loaded = Record<ArtifactFile, Uint8Array>

const mismatch = (circuit: string, file: ArtifactFile, why: string) =>
	new PoolClientError("ARTIFACT_MISMATCH", `${circuit} ${file}: ${why}`, { circuit, file })

async function readCapped(body: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array> {
	const out = new Uint8Array(cap)
	const reader = body.getReader()
	let total = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) return out.subarray(0, total)
		if (total + value.byteLength > cap) {
			await reader.cancel()
			throw new Error(`body exceeds the pinned ${cap} bytes`)
		}
		out.set(value, total)
		total += value.byteLength
	}
}

/** The SDK loader's only network call, bounded by the pinned size and a whole-body deadline. */
function boundedHttp(capOf: (cid: string) => number | undefined, deadlineMs: number, fetchImpl: typeof fetch): IHTTPClient {
	const unsupported = () => Promise.reject(new Error("only getBinary is supported"))
	return {
		get: unsupported,
		post: unsupported,
		async getBinary(url) {
			const cid = new URL(url).pathname.split("/").pop() ?? ""
			const cap = capOf(cid)
			if (cap === undefined) throw new Error(`no pinned size for ${cid}`)
			const ctl = new AbortController()
			const timer = setTimeout(() => ctl.abort(new Error(`no complete body within ${deadlineMs} ms`)), deadlineMs)
			try {
				const res = await fetchImpl(url, { signal: ctl.signal })
				if (!res.ok || res.body === null) {
					await res.body?.cancel()
					throw new Error(`HTTP ${res.status}`)
				}
				if (Number(res.headers.get("content-length") ?? 0) > cap) {
					await res.body.cancel()
					throw new Error(`declared length exceeds the pinned ${cap} bytes`)
				}
				return await readCapped(res.body, cap)
			} finally {
				clearTimeout(timer)
			}
		},
	}
}

function sourceLoader(src: ArtifactSource, circuits: Readonly<Record<string, PinnedCircuit>>, opts: ArtifactOptions): ICircuitArtifacts {
	if (src.kind === "dir") return new LocalCircuitArtifacts({ baseDir: src.path })
	const caps = new Map<string, number>()
	const digests = new Map<string, string | undefined>()
	for (const pin of Object.values(circuits))
		for (const f of FILES) {
			caps.set(pin[f], pin.sizes[f])
			digests.set(pin[f], pin[`${f}Sha256`]?.toLowerCase().replace(/^0x/, ""))
		}
	const manifest = Object.fromEntries(Object.entries(circuits).map(([name, { sizes: _, ...cids }]) => [name, cids]))
	const cacheStore = cacheStorageStore((cid) => digests.get(cid))
	return new IpfsCircuitArtifacts(
		{
			ipfsGatewayUrls: [...src.urls],
			circuitManifest: manifest,
			httpClient: boundedHttp((cid) => caps.get(cid), opts.deadlineMs ?? 120_000, opts.fetch ?? fetch),
		},
		cacheStore ? { cacheStore } : undefined,
	)
}

/**
 * Circuit files checked against `src.bundle`'s pins in every runtime. The gateway loader verifies
 * digests itself and, in a browser, keeps files across page loads; files from a directory are hashed here.
 * Reads `src` once, before returning.
 * @throws PoolClientError as {@link circuitBundle} does, before any file is read
 */
export function createArtifacts(src: ArtifactSource, opts: ArtifactOptions = {}): VerifiedArtifacts {
	return artifactsFor(src, circuitBundle(src.bundle, opts.chainId).circuits, opts)
}

/** {@link createArtifacts} over arbitrary pins: tests only, so the package exports it nowhere. */
export function artifactsFor(
	src: ArtifactSource,
	circuits: Readonly<Record<string, PinnedCircuit>>,
	opts: Omit<ArtifactOptions, "chainId"> = {},
): VerifiedArtifacts {
	const { kind } = src
	const inner = sourceLoader(src, circuits, opts)
	const loads = new Map<string, Promise<Loaded>>()

	async function readFile(circuit: string, pin: PinnedCircuit, file: ArtifactFile): Promise<Uint8Array> {
		let bytes: Uint8Array
		try {
			bytes = await inner[GETTER[file]](circuit)
		} catch (err) {
			throw mismatch(circuit, file, err instanceof Error ? err.message : String(err))
		}
		if (kind === "gateway") return bytes
		if (bytes.byteLength !== pin.sizes[file]) throw mismatch(circuit, file, `${bytes.byteLength} bytes, pinned ${pin.sizes[file]}`)
		const want = pin[`${file}Sha256`]?.toLowerCase().replace(/^0x/, "")
		if (want === undefined || (await sha256Hex(bytes)) !== want) throw mismatch(circuit, file, "sha256 differs from the manifest")
		return bytes
	}

	async function loadAll(circuit: string): Promise<Loaded> {
		const pin = circuits[circuit]
		if (pin === undefined) throw mismatch(circuit, "wasm", "circuit not pinned")
		const [wasm, provingKey, verificationKey] = await Promise.all(FILES.map((f) => readFile(circuit, pin, f)))
		return { wasm: wasm!, provingKey: provingKey!, verificationKey: verificationKey! }
	}

	function load(circuit: string): Promise<Loaded> {
		let p = loads.get(circuit)
		if (p === undefined) {
			p = loadAll(circuit)
			loads.set(circuit, p)
			p.catch(() => loads.delete(circuit))
		}
		return p
	}

	return {
		ensure: async (circuit) => {
			await load(circuit)
		},
		getWasm: async (circuit) => (await load(circuit)).wasm,
		getProvingKey: async (circuit) => (await load(circuit)).provingKey,
		getVerificationKey: async (circuit) => (await load(circuit)).verificationKey,
	}
}
