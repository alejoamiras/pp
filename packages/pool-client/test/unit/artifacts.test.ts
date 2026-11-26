import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_CIRCUIT_MANIFEST } from "@0xbow/privacy-pools-v2-sdk"
import { afterAll, describe, expect, it } from "vitest"
import type { ArtifactFile } from "../../src/errors.ts"
import { type ArtifactSource, createArtifacts, type PinnedCircuit } from "../../src/runtime/artifacts.ts"
import { scratchDir } from "../support/paths.ts"

const FILES = ["wasm", "provingKey", "verificationKey"] as const
const ON_DISK = {
	wasm: (c: string) => `${c}_js/${c}.wasm`,
	provingKey: () => "groth16_pkey.zkey",
	verificationKey: () => "groth16_vkey.json",
} as const
type Files = Record<ArtifactFile, Uint8Array>

const scratch = scratchDir("artifacts")
afterAll(() => scratch.remove())
const GATEWAY = "http://gateway.invalid/ipfs"

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")
const sixteen = (seed: number): Files => ({
	wasm: Uint8Array.from({ length: 16 }, (_, i) => seed + i),
	provingKey: Uint8Array.from({ length: 16 }, (_, i) => seed + 32 + i),
	verificationKey: Uint8Array.from({ length: 16 }, (_, i) => seed + 64 + i),
})

/** Two 16-byte circuits under real CIDs (dag-pb, so only the manifest digest checks content). */
function fixture() {
	const good = { fake_a: sixteen(1), fake_b: sixteen(101) }
	const pinOf = (cidsFrom: "deposit" | "ragequit", f: Files): PinnedCircuit => {
		const m = DEFAULT_CIRCUIT_MANIFEST[cidsFrom]!
		return {
			wasm: m.wasm,
			provingKey: m.provingKey,
			verificationKey: m.verificationKey,
			wasmSha256: sha(f.wasm),
			provingKeySha256: sha(f.provingKey),
			verificationKeySha256: sha(f.verificationKey),
			sizes: { wasm: 16, provingKey: 16, verificationKey: 16 },
		}
	}
	const circuits = { fake_a: pinOf("deposit", good.fake_a), fake_b: pinOf("ragequit", good.fake_b) }
	const served: Record<string, Files> = {
		fake_a: { ...good.fake_a, provingKey: good.fake_a.provingKey.slice() },
		fake_b: { ...good.fake_b },
	}
	const byCid = new Map<string, [string, ArtifactFile]>()
	for (const [name, pin] of Object.entries(circuits)) for (const f of FILES) byCid.set(pin[f], [name, f])
	return { circuits, served, byCid }
}

type Fixture = ReturnType<typeof fixture>

const fetchFrom = (fx: Fixture): typeof fetch =>
	(async (input: string | URL | Request) => {
		const cid = String(input).split("/").pop()!
		const [name, file] = fx.byCid.get(cid)!
		return new Response(fx.served[name]![file].slice())
	}) as typeof fetch

function materialise(dir: string, fx: Fixture): void {
	for (const [name, files] of Object.entries(fx.served))
		for (const f of FILES) {
			const path = join(dir, name, ON_DISK[f](name))
			mkdirSync(join(path, ".."), { recursive: true })
			writeFileSync(path, files[f])
		}
}

let dirs = 0
const LOADERS: [string, (fx: Fixture) => { src: ArtifactSource; sync(): void }][] = [
	[
		"dir",
		(fx) => {
			const path = join(scratch.path, String(dirs++))
			return { src: { kind: "dir", path }, sync: () => materialise(path, fx) }
		},
	],
	["gateway", () => ({ src: { kind: "gateway", urls: [GATEWAY] }, sync: () => {} })],
]

describe.each(LOADERS)("the %s loader", (_, make) => {
	it("passes the pinned bytes, and a corrupted file fails naming its circuit and file until it is fixed", async () => {
		const fx = fixture()
		const loader = make(fx)
		loader.sync()
		const artifacts = createArtifacts(loader.src, { circuits: fx.circuits, fetch: fetchFrom(fx) })
		await artifacts.ensure("fake_b")
		expect(await artifacts.getWasm("fake_b")).toEqual(fx.served.fake_b!.wasm)

		fx.served.fake_a!.provingKey[3]! ^= 1
		loader.sync()
		await expect(artifacts.ensure("fake_a")).rejects.toMatchObject({ code: "ARTIFACT_MISMATCH", circuit: "fake_a", file: "provingKey" })
		fx.served.fake_a!.provingKey[3]! ^= 1
		loader.sync()
		await artifacts.ensure("fake_a")
	})

	it("names each circuit's own file when two corrupted loads overlap", async () => {
		const fx = fixture()
		fx.served.fake_a = { ...fx.served.fake_a!, wasm: fx.served.fake_a!.wasm.map((b, i) => (i === 0 ? b ^ 1 : b)) }
		fx.served.fake_b = { ...fx.served.fake_b!, verificationKey: fx.served.fake_b!.verificationKey.map((b, i) => (i === 0 ? b ^ 1 : b)) }
		const loader = make(fx)
		loader.sync()
		const artifacts = createArtifacts(loader.src, { circuits: fx.circuits, fetch: fetchFrom(fx) })
		const [a, b] = await Promise.allSettled([artifacts.ensure("fake_a"), artifacts.ensure("fake_b")])
		expect(a).toMatchObject({ status: "rejected", reason: { code: "ARTIFACT_MISMATCH", circuit: "fake_a", file: "wasm" } })
		expect(b).toMatchObject({ status: "rejected", reason: { code: "ARTIFACT_MISMATCH", circuit: "fake_b", file: "verificationKey" } })
	})
})

describe("the gateway reader", () => {
	const streamingFetch = (
		fx: Fixture,
		body: (signal: AbortSignal, onCancel: () => void) => ReadableStream<Uint8Array>,
		onCancel: () => void,
	): typeof fetch =>
		(async (input: string | URL | Request, init?: RequestInit) => {
			if (!String(input).endsWith(fx.circuits.fake_a.provingKey)) return fetchFrom(fx)(input)
			return new Response(body(init!.signal!, onCancel))
		}) as typeof fetch

	it("cuts off a body with no Content-Length once it passes the pinned size", async () => {
		const fx = fixture()
		let cancelled = false
		const endless = (_: AbortSignal, onCancel: () => void) =>
			new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(new Uint8Array(8)), cancel: onCancel })
		const artifacts = createArtifacts(
			{ kind: "gateway", urls: [GATEWAY] },
			{ circuits: fx.circuits, fetch: streamingFetch(fx, endless, () => (cancelled = true)) },
		)
		await expect(artifacts.ensure("fake_a")).rejects.toMatchObject({ code: "ARTIFACT_MISMATCH", file: "provingKey" })
		await expect(artifacts.ensure("fake_a")).rejects.toThrow(/exceeds the pinned 16 bytes/)
		expect(cancelled).toBe(true)
	})

	it("aborts a body that stalls below the cap at the deadline", async () => {
		const fx = fixture()
		const stalls = (signal: AbortSignal) =>
			new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(new Uint8Array(8))
					signal.addEventListener("abort", () => c.error(signal.reason))
				},
			})
		const artifacts = createArtifacts(
			{ kind: "gateway", urls: [GATEWAY] },
			{ circuits: fx.circuits, deadlineMs: 100, fetch: streamingFetch(fx, stalls, () => {}) },
		)
		const t0 = performance.now()
		await expect(artifacts.ensure("fake_a")).rejects.toThrow(/provingKey.*no complete body within 100 ms/)
		expect(performance.now() - t0).toBeLessThan(2_000)
	})
})
