/**
 * What a run's network gives the fixtures, whichever booted it: fresh Aztec actors, the injected
 * Ethereum wallet's chain and key by index, and on the sandbox a block nudge (the local stack runs
 * its own heartbeat).
 */
import { readFileSync } from "node:fs"
import { parseStackManifest } from "@pp/bridge-core"
import { anvilKey, connectL2, createActor, freshActorSecret, l2CtxFor } from "@pp/bridge-core/sandbox"
import type { Hex } from "viem"
import { type RunEnv, stackRun } from "../env"
import { type ActorHandle, sandboxAccess } from "./sandbox"

export interface L1Account {
	rpcUrl: string
	chainId: number
	privateKey: Hex
}

export interface Network {
	newActor(): Promise<ActorHandle>
	/** On the sandbox, its actor keys; on the stack, its seeded accounts: 0 the pool user, 1 its separate bridge sender. */
	l1(index: number): L1Account
	/** Builds a block now; `null` where the network builds them by itself. */
	forceBlock: (() => Promise<unknown>) | null
}

async function sandboxNetwork(): Promise<Network> {
	const sandbox = await sandboxAccess()
	const { handle, l2 } = sandbox.clients
	const relayer = l2CtxFor(l2, l2.relayer)
	return {
		newActor: () => sandbox.newActor(),
		l1(index) {
			const key = handle.l1.actorKeys[index]
			if (!key) throw new Error(`no anvil actor key at index ${index}`)
			return { rpcUrl: handle.anvilUrl, chainId: handle.l1ChainId, privateKey: key as Hex }
		},
		forceBlock: relayer.forceBlock ? async () => relayer.forceBlock?.() : null,
	}
}

async function stackNetwork(run: RunEnv): Promise<Network> {
	const stack = stackRun(run)
	const manifest = parseStackManifest(JSON.parse(readFileSync(stack.manifestPath, "utf8")))
	// Opened on the first actor: a file that needs no Aztec account never starts the scripting wallet.
	let l2: ReturnType<typeof connectL2> | undefined
	const seeded = [stack.accounts.user, stack.accounts.sender]
	return {
		async newActor() {
			l2 ??= connectL2(manifest.aztecNode)
			const { wallet, node, fee } = await l2
			const secret = freshActorSecret()
			const actor = await createActor(wallet, node, fee, secret, 1n, () => {})
			return { actor, seed: { secret, salt: actor.salt.toString() }, address: actor.address.toString() }
		},
		l1(index) {
			const account = seeded[index]
			if (!account) throw new Error(`the stack seeds ${seeded.length} Ethereum accounts; there is no index ${index}`)
			return { rpcUrl: manifest.l1Rpc, chainId: manifest.chainId, privateKey: anvilKey(account.index) }
		},
		forceBlock: null,
	}
}

let cached: Promise<Network> | undefined

/** Connected once per worker process; the embedded scripting wallet inside is expensive to open. */
export function openNetwork(run: RunEnv): Promise<Network> {
	cached ??= run.mode === "stack" ? stackNetwork(run) : sandboxNetwork()
	return cached
}
