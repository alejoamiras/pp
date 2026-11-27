// pause <deployment file> --factory <address> [--nonce <n> [--replace --pending <hash>]]
// Pauses the factory's entries and exits 0 only once the pause is final. Its guards are the chain id of both
// pinned L1 URLs, the factory and the guardian's address alone: no build, node or other endpoint check can block it.
import { type GuardianL1, type GuardianWallet, PauseError, pauseEntries } from "@pp/bridge-core/deploy"
import { PUBLIC_CHAIN_TIMING } from "@pp/bridge-core"
import { type Address, createPublicClient, http, isAddress, isAddressEqual } from "viem"
import { l1AddressOf } from "../accounts"
import { assertForkNode, assertL1Chain, assertTransport, GuardError, readKeys } from "../guards"
import { RUN_KEYS } from "../keys"
import { PINNED_URLS } from "../network"
import { pendingToReplace, replaceArgs, type TxReader } from "../pending"
import { requireSections, type TestnetDeployment } from "../schema"
import { journalTo } from "@pp/pp-env/send-log"
import { assertSendChain, cliArgs, clientsOf, loadDeployment, main, report, sendLogPath } from "./common"
import { l1Wallet } from "./wallet"

/** The file's endpoint, then, live, every other pinned L1 URL: a backend may not have seen the pending transaction. */
function readersOf(d: TestnetDeployment, l1: TxReader, live: boolean): TxReader[] {
	const others = live ? PINNED_URLS.l1Rpc.filter((u) => u !== d.network.l1Rpc) : []
	return [l1, ...others.map((url) => createPublicClient({ transport: http(url) }) as TxReader)]
}

await main(async () => {
	const { file, mode, values } = cliArgs(process.argv.slice(2), {
		factory: { type: "string" },
		nonce: { type: "string" },
		replace: { type: "boolean" },
		pending: { type: "string" },
	})
	const d = requireSections(loadDeployment(file), ["bridge", "expected"])
	assertTransport(d, mode, false)
	const { l1 } = clientsOf(d)
	await assertL1Chain(l1, mode)
	await assertForkNode(l1, mode)
	await assertSendChain(d, mode)
	const factory = values.factory as string | undefined
	if (!factory || !isAddress(factory) || !isAddressEqual(factory, d.bridge.factory))
		throw new GuardError("factory", `--factory must be the file's factory ${d.bridge.factory}`)
	const { nonce, pending } = replaceArgs(values as { nonce?: string; replace?: boolean; pending?: string })
	const replace =
		pending === undefined || nonce === undefined
			? undefined
			: await pendingToReplace({
					readers: readersOf(d, l1, mode.kind === "live"),
					hash: pending,
					guardian: d.expected.guardian,
					nonce,
					chainId: d.network.l1ChainId,
				})
	const { GUARDIAN_KEY } = readKeys(RUN_KEYS.pause, mode, { env: process.env }, l1AddressOf)
	const guardian = l1Wallet(d, GUARDIAN_KEY as `0x${string}`, "guardian", d.expected.guardian, journalTo(sendLogPath(d, "pause", mode)))
	try {
		const r = await pauseEntries(
			{ chainId: d.network.l1ChainId, l1: l1 as unknown as GuardianL1, factory: factory as Address },
			guardian as unknown as GuardianWallet,
			{
				...(nonce === undefined ? {} : { nonce }),
				...(replace ? { replace } : {}),
				timing: PUBLIC_CHAIN_TIMING,
				onSigned: (s) => report("pause-signed", { factory, nonce: s.nonce, hash: s.hash }),
			},
		)
		report("paused", { factory, nonce: r.nonce, hash: r.hash, wasPaused: r.wasPaused })
		return 0
	} catch (e) {
		if (!(e instanceof PauseError)) throw e
		report("pause-failed", { factory, code: e.code, nonce: e.nonce, ...(e.hash ? { hash: e.hash } : {}) })
		return 1
	}
})
