/**
 * The proving points the wallet would fetch from the CDN on its first proof, prepared in Node so the
 * browser never leaves loopback. The compressed inputs are downloaded as exact ranges and checked
 * against their pins before bb.js parses a byte; bb.js's WASM backend then decompresses G1 from
 * those files (the native backend would skip that step), and the result is checked against its
 * own pin. The three arrays are what bb.js keeps in the browser's IndexedDB `keyval-store`.
 *
 *   bun real-wallet/crs.ts --pin      (bump-time: measures and prints crs-pin.json from a cold download)
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { downloadPinned, SHA256_HEX, sha256 } from "./download"

const G1_POINTS = 2 ** 19
const GRUMPKIN_POINTS = 2 ** 16

export interface Pinned {
	bytes: number
	sha256: string
}

export interface CrsInput extends Pinned {
	urls: [primary: string, fallback: string]
	ranged: boolean
}

/** File names are bb.js's own in `crsPath`, so it uses them instead of downloading. */
export interface CrsPin {
	bb: string
	inputs: { "bn254_g1_compressed.dat": CrsInput; "bn254_g2.dat": CrsInput; "grumpkin_g1_v2.flat.dat": CrsInput }
	g1Uncompressed: Pinned
}

export interface SeedArrays {
	g1Data: Buffer
	g2Data: Buffer
	grumpkinG1DataV2: Buffer
}

type Decompress = (crsDir: string) => Promise<void>

/** What bb.js finds in `crsPath` and uses; a file missing or shorter it downloads itself, unchecked. */
const BB_INPUTS = { "bn254_g1_compressed.dat": G1_POINTS * 32, "bn254_g2.dat": 128, "grumpkin_g1_v2.flat.dat": GRUMPKIN_POINTS * 64 }

const bbDecompress: Decompress = async (crsDir) => {
	for (const [name, bytes] of Object.entries(BB_INPUTS)) {
		const path = join(crsDir, name)
		if (!existsSync(path) || statSync(path).size !== bytes)
			throw new Error(`crs: ${name} is not the ${bytes} bytes bb.js would otherwise fetch`)
	}
	const { Barretenberg, BackendType } = await import("@aztec-foundation/bb.js")
	const bb = await Barretenberg.new({ backend: BackendType.Wasm, crsPath: crsDir, srsSize: G1_POINTS })
	await bb.destroy()
}

export function readCrsPin(): CrsPin {
	return JSON.parse(readFileSync(new URL("./crs-pin.json", import.meta.url), "utf8")) as CrsPin
}

async function fetchInput(input: CrsInput, fetchImpl?: typeof fetch): Promise<Buffer> {
	const e = {
		size: input.bytes,
		sha256: input.sha256 || undefined,
		headers: input.ranged ? { Range: `bytes=0-${input.bytes - 1}` } : undefined,
		fetchImpl,
	}
	try {
		return await downloadPinned(input.urls[0], e)
	} catch (first) {
		return await downloadPinned(input.urls[1], e).catch((second: Error) => {
			throw new Error(`crs: both hosts failed: ${(first as Error).message}; ${second.message}`)
		})
	}
}

type PrepareOptions = { fetchImpl?: typeof fetch; decompress?: Decompress }

/**
 * Downloads and checks the inputs into `crsDir` (created, must not exist), decompresses G1, checks it.
 * @throws Error when a pin hash is not a sha256 (before any download), or when an input or the
 *   decompressed G1 does not match its pin; bb.js never sees an unchecked input
 */
export async function prepareCrs(pin: CrsPin, crsDir: string, o: PrepareOptions = {}): Promise<SeedArrays> {
	const pinned = [...Object.entries(pin.inputs), ["decompressed G1", pin.g1Uncompressed] as const]
	for (const [name, p] of pinned) if (!SHA256_HEX.test(p.sha256)) throw new Error(`crs: the pin's hash for ${name} is not a sha256`)
	return prepare(pin, crsDir, o)
}

/** An empty hash is skipped only here, for `measurePin`'s cold measurement; `prepareCrs` refuses one. */
async function prepare(pin: CrsPin, crsDir: string, o: PrepareOptions): Promise<SeedArrays> {
	mkdirSync(crsDir)
	const got: Record<string, Buffer> = {}
	for (const [name, input] of Object.entries(pin.inputs)) {
		got[name] = await fetchInput(input, o.fetchImpl)
		writeFileSync(join(crsDir, name), got[name] as Buffer, { flag: "wx" })
	}
	await (o.decompress ?? bbDecompress)(crsDir)
	const g1Data = readFileSync(join(crsDir, "bn254_g1.dat"))
	const want = pin.g1Uncompressed
	if (g1Data.length !== want.bytes || (want.sha256 && sha256(g1Data) !== want.sha256))
		throw new Error(`crs: decompressed G1 does not match its pin (${g1Data.length} bytes, sha256 ${sha256(g1Data)})`)
	return { g1Data, g2Data: got["bn254_g2.dat"] as Buffer, grumpkinG1DataV2: got["grumpkin_g1_v2.flat.dat"] as Buffer }
}

const HOSTS = ["https://crs.aztec-cdn.foundation", "https://crs.aztec-labs.com"] as const
const input = (file: string, bytes: number, ranged: boolean): CrsInput => ({
	urls: [`${HOSTS[0]}/${file}`, `${HOSTS[1]}/${file}`],
	ranged,
	bytes,
	sha256: "",
})

async function measurePin(): Promise<void> {
	const unpinned: CrsPin = {
		bb: "6.0.0",
		inputs: {
			"bn254_g1_compressed.dat": input("g1_compressed.dat", BB_INPUTS["bn254_g1_compressed.dat"], true),
			"bn254_g2.dat": input("g2.dat", BB_INPUTS["bn254_g2.dat"], false),
			"grumpkin_g1_v2.flat.dat": input("grumpkin_g1_v2.dat", BB_INPUTS["grumpkin_g1_v2.flat.dat"], true),
		},
		g1Uncompressed: { bytes: G1_POINTS * 64, sha256: "" },
	}
	mkdirSync(join(homedir(), ".cache/pp"), { recursive: true })
	const base = mkdtempSync(join(homedir(), ".cache/pp/crs-pin-"))
	try {
		const seed = await prepare(unpinned, join(base, "crs"), {})
		for (const [name, i] of Object.entries(unpinned.inputs)) i.sha256 = sha256(readFileSync(join(base, "crs", name)))
		unpinned.g1Uncompressed.sha256 = sha256(seed.g1Data)
		console.log(JSON.stringify(unpinned, null, "\t"))
	} finally {
		rmSync(base, { recursive: true, force: true })
	}
}

if (import.meta.main && process.argv.includes("--pin")) await measurePin()
