/** Per-file access to the booted sandbox: connected clients once per file. */
import { inject } from "vitest"
import type { ManifestToken, ManifestV2 } from "../../src/manifest-v2"
import { openSandbox, readManifest, type SandboxClients } from "../../scripts/sandbox/handle"

export const INTEGRATION = Boolean(process.env.BRIDGE_INTEGRATION)

export interface Sandbox {
	clients: SandboxClients
	manifest: ManifestV2
	usdc: ManifestToken
	usdt: ManifestToken
	pxo: ManifestToken
}

let cached: Promise<Sandbox> | undefined

export function sandbox(): Promise<Sandbox> {
	cached ??= (async () => {
		const handle = inject("handle")
		const clients = await openSandbox(handle)
		const manifest = readManifest(handle.artifactsDir)
		const [usdc, usdt, pxo] = manifest.bridge?.tokens ?? []
		if (!usdc || !usdt || !pxo) throw new Error("the sandbox manifest lists fewer than three tokens")
		return { clients, manifest, usdc, usdt, pxo }
	})()
	return cached
}
