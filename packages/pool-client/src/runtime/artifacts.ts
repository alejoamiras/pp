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

export type ArtifactSource = { kind: "gateway"; urls: readonly string[] } | { kind: "dir"; path: string }

/** A manifest entry plus each file's byte size: the gateway reader needs a cap before it buffers. */
export type PinnedCircuit = CircuitArtifactCIDs & { sizes: Readonly<Record<ArtifactFile, number>> }

export const PINNED_CIRCUITS: Readonly<Record<string, PinnedCircuit>> = {
	transact_1x1: {
		...DEFAULT_CIRCUIT_MANIFEST.transact_1x1!,
		sizes: { wasm: 3_239_462, provingKey: 18_144_961, verificationKey: 4_528 },
	},
}

export type ArtifactOptions = {
	circuits?: Readonly<Record<string, PinnedCircuit>>
	/** Per gateway file, covering the whole body. */
	deadlineMs?: number
	fetch?: typeof fetch
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
 * Circuit files checked against the pinned manifest in every runtime. The gateway loader verifies
 * digests itself and, in a browser, keeps files across page loads; files from a directory are hashed here.
 */
export function createArtifacts(src: ArtifactSource, opts: ArtifactOptions = {}): VerifiedArtifacts {
	const circuits = opts.circuits ?? PINNED_CIRCUITS
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
