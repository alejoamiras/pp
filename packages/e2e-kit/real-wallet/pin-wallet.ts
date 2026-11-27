/**
 * Bump-time only: pins a wallet release in `wallet-pin.json` after checking that it is a release
 * (not a prerelease), at least seven days old (the dependency gate), that its tag resolves to the
 * commit its build-provenance attestation names, and that the attestation verifies. Needs `gh`
 * logged in; the nightly reads the committed pin and needs no token.
 *
 *   bun real-wallet/pin-wallet.ts <tag>      (from packages/e2e-kit)
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { downloadPinned, type WalletPin } from "./fetch-wallet"

const REPO = "nulo-sh/nulo"
const MIN_AGE_MS = 7 * 86_400_000

const gh = (...args: string[]) => execFileSync("gh", args, { encoding: "utf8" })

interface Asset {
	name: string
	size: number
	digest: string
	url: string
}

async function main(tag: string): Promise<void> {
	const release = JSON.parse(gh("release", "view", tag, "--repo", REPO, "--json", "tagName,publishedAt,isPrerelease,assets")) as {
		publishedAt: string
		isPrerelease: boolean
		assets: Asset[]
	}
	if (release.isPrerelease) throw new Error(`${tag} is a prerelease`)
	const age = Date.now() - Date.parse(release.publishedAt)
	if (age < MIN_AGE_MS) throw new Error(`${tag} was published ${release.publishedAt}, under seven days ago`)
	const version = tag.replace(/^v/, "")
	const asset = release.assets.find((a) => a.name === `nulo-chrome-${version}.zip`)
	if (!asset?.digest.startsWith("sha256:")) throw new Error(`${tag} has no Chrome zip with a sha256 digest`)
	const sha256 = asset.digest.slice("sha256:".length)
	const commit = gh("api", `repos/${REPO}/commits/${tag}`, "--jq", ".sha").trim()

	const dir = mkdtempSync(join(homedir(), ".cache/pp/pin-wallet-"))
	try {
		const zip = join(dir, asset.name)
		writeFileSync(zip, await downloadPinned(asset.url, asset.size, sha256))
		const [att] = JSON.parse(gh("attestation", "verify", zip, "--repo", REPO, "--format", "json")) as {
			verificationResult: { signature: { certificate: Record<string, string> } }
		}[]
		const cert = att?.verificationResult.signature.certificate
		if (!cert || cert.sourceRepositoryDigest !== commit)
			throw new Error(`the attestation names commit ${cert?.sourceRepositoryDigest}, the tag resolves to ${commit}`)
		const pin: WalletPin = {
			version,
			tag,
			commit,
			url: asset.url,
			sha256,
			size: asset.size,
			publishedAt: release.publishedAt,
			attestation: { signer: cert.buildSignerURI ?? "", run: cert.runInvocationURI ?? "" },
		}
		writeFileSync(new URL("./wallet-pin.json", import.meta.url), `${JSON.stringify(pin, null, "\t")}\n`)
		console.log(`pinned ${asset.name} sha256:${sha256} (${asset.size} B) from ${commit}`)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

const tag = process.argv[2]
if (!tag) throw new Error("usage: bun real-wallet/pin-wallet.ts <tag>")
await main(tag)
