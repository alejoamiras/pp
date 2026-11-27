// pause <deployment file> --factory <address> [--nonce <n> [--replace]]
// Pauses the factory's entries and exits 0 only once the pause is final. Its guards are the chain id, the
// pinned L1 URL, the factory and the guardian's address alone: no build, node or endpoint check can block it.
import { type GuardianL1, type GuardianWallet, PauseError, pauseEntries } from "@pp/bridge-core/deploy"
import { PUBLIC_CHAIN_TIMING } from "@pp/bridge-core"
import { type Address, isAddress, isAddressEqual } from "viem"
import { assertL1Chain, assertTransport, GuardError, readKeys } from "../guards"
import { RUN_KEYS } from "../keys"
import { requireSections } from "../schema"
import { cliArgs, clientsOf, loadDeployment, main, report } from "./common"
import { l1AddressOf } from "../accounts"
import { l1Wallet } from "./wallet"

await main(async () => {
	const { file, mode, values } = cliArgs(process.argv.slice(2), {
		factory: { type: "string" },
		nonce: { type: "string" },
		replace: { type: "boolean" },
	})
	const d = requireSections(loadDeployment(file), ["bridge", "expected"])
	assertTransport(d, mode, false)
	const { l1 } = clientsOf(d)
	await assertL1Chain(l1, mode)
	const factory = values.factory as string | undefined
	if (!factory || !isAddress(factory) || !isAddressEqual(factory, d.bridge.factory))
		throw new GuardError("factory", `--factory must be the file's factory ${d.bridge.factory}`)
	const nonce = values.nonce === undefined ? undefined : Number(values.nonce)
	if (nonce !== undefined && !(Number.isSafeInteger(nonce) && nonce >= 0))
		throw new GuardError("argv", "--nonce takes a non-negative integer")
	if (values.replace && nonce === undefined) throw new GuardError("argv", "--replace needs --nonce")
	const { GUARDIAN_KEY } = readKeys(RUN_KEYS.pause, mode, process.env, l1AddressOf)
	const guardian = l1Wallet(d, GUARDIAN_KEY as `0x${string}`, "guardian", d.expected.guardian)
	try {
		const r = await pauseEntries(
			{ chainId: d.network.l1ChainId, l1: l1 as unknown as GuardianL1, factory: factory as Address },
			guardian as unknown as GuardianWallet,
			{
				...(nonce === undefined ? {} : { nonce }),
				...(values.replace ? { replace: true } : {}),
				timing: PUBLIC_CHAIN_TIMING,
				onSigned: (s) => report("pause-signed", { factory, nonce: s.nonce, hash: s.hash }),
			},
		)
		report("paused", { factory, nonce: r.nonce, hash: r.hash, wasPaused: r.wasPaused })
		return 0
	} catch (e) {
		if (!(e instanceof PauseError)) throw e
		report("pause-failed", { factory, code: e.code, nonce: e.nonce })
		return 1
	}
})
