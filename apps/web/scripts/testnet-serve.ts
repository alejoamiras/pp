/**
 * What `serve --deployment` needs from a testnet deployment file: the proxy's fixed upstreams, once
 * the build in `outDir` is shown to be the one for that file. The build's receipt (`target.json`) and
 * its header set must both equal what the file yields now, so a stale or foreign build never starts.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { HEADER_FILE, type SecurityHeaders, securityHeaders } from "../src/build/headers.ts"
import { TARGET_FILE } from "../src/build/plugins.ts"
import { sponsoredFpcAddress } from "../src/build/sponsored-fpc.ts"
import { readTestnetDeployment, testnetTargetOf } from "../src/build/testnet.ts"
import type { ProxyConfig } from "./proxy"

function readBuilt(outDir: string, file: string): unknown {
	try {
		return JSON.parse(readFileSync(join(outDir, file), "utf8"))
	} catch {
		throw new Error(`serve: ${join(outDir, file)} is missing or not JSON; build with --mode testnet first`)
	}
}

/** The origin of a loopback http URL with nothing after it, or a refusal naming `field`. */
function loopbackOrigin(url: string, field: string): string {
	const u = URL.canParse(url) ? new URL(url) : null
	if (u?.protocol !== "http:" || u.hostname !== "127.0.0.1" || u.origin !== url.replace(/\/$/, ""))
		throw new Error(`serve: ${field} ${url} is not a loopback http origin`)
	return u.origin
}

/**
 * Each input is read once, so the proxy and the headers come from the same reads as the checks.
 *
 * @throws when the build in `outDir` is not the one `file` yields, or an upstream is not on loopback.
 */
export async function loadTestnetServing(file: string, outDir: string): Promise<{ proxy: ProxyConfig; headers: SecurityHeaders }> {
	const d = readTestnetDeployment(file)
	const target = testnetTargetOf(file, d, await sponsoredFpcAddress())
	if (!isDeepStrictEqual(readBuilt(outDir, TARGET_FILE), JSON.parse(JSON.stringify(target))))
		throw new Error(`serve: ${outDir} is not the testnet build for ${file}; rebuild it`)
	const headers = securityHeaders(target)
	if (!isDeepStrictEqual(readBuilt(outDir, HEADER_FILE), headers))
		throw new Error(`serve: ${join(outDir, HEADER_FILE)} is not the header set for ${file}; rebuild it`)
	return {
		headers,
		proxy: {
			chainId: d.network.l1ChainId,
			entrypoint: d.pool.entrypoint,
			asp: loopbackOrigin(d.pool.aspApiUrl, "pool.aspApiUrl"),
			bot: `http://127.0.0.1:${d.network.botPort}`,
		},
	}
}
