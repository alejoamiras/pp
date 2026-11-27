/**
 * `deploy` against a stale `contracts/bridge/evm/out`: the rehearsal swaps the factory's build file for
 * one whose code differs by a byte, runs the real `deploy`, and puts the file back byte for byte, so no
 * other deploy may run from this checkout for those few seconds. The CLI must refuse at its build check,
 * with no transaction sent and no run directory written. Its node guard runs against a stub that answers
 * `getNodeInfo` only, since the case needs no L2.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { claimPort } from "@pp/run-isolation/ports"
import { killGroup } from "@pp/run-isolation/process"
import { type Hex, size, slice } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { buildMismatch, forgeArtifact } from "../creation"
import { generateKey } from "../keyfile"
import { serializeDeployment } from "../schema"
import { startLocalAnvil } from "./local-chain"
import { NODE_INFO, startNodeStub } from "./node-stub"
import { type CaseCtx, check, DEPLOYER_KEY, fixtureFile } from "./pause-stage"
import { ended, startCli } from "./runner"

/** The build file with the last byte before its CBOR metadata changed: the same layout, other code. */
function staleCopy(original: string): string {
	const artifact = JSON.parse(original) as { bytecode: { object: Hex } }
	const code = artifact.bytecode.object
	const meta = Number.parseInt(code.slice(-4), 16)
	const at = size(code) - meta - 3
	const flipped = (Number.parseInt(slice(code, at, at + 1).slice(2), 16) ^ 0xff).toString(16).padStart(2, "0")
	artifact.bytecode.object = `${code.slice(0, 2 + at * 2)}${flipped}${code.slice(4 + at * 2)}` as Hex
	return JSON.stringify(artifact)
}

/**
 * Swaps the build file for {@link staleCopy} until the returned restore runs; the original also stays in
 * `dir` so a killed run can be undone by hand.
 */
function swapInStale(dir: string): () => void {
	const path = forgeArtifact("PortalFactory")
	const original = readFileSync(path)
	copyFileSync(path, join(dir, "PortalFactory.json.orig"))
	let restored = false
	writeFileSync(path, staleCopy(original.toString("utf8")))
	return () => {
		if (restored) return
		writeFileSync(path, original)
		restored = true
	}
}

export async function staleBuild(c: CaseCtx): Promise<string[]> {
	const chain = await startLocalAnvil({ runId: c.runId, service: `${c.name}-anvil`, dir: c.dir, cleanup: c.cleanup })
	const network = fixtureFile({ l1Rpc: chain.url, aztecNode: chain.url }).network
	const node = await startNodeStub(await claimPort(c.runId, `${c.name}-node`), network)
	c.cleanup.push(() => node.close())
	const file = join(c.dir, `${c.name}.json`)
	writeFileSync(file, serializeDeployment(fixtureFile({ l1Rpc: chain.url, aztecNode: node.url, pool: true })))
	const deployer = privateKeyToAccount(DEPLOYER_KEY).address
	const runRoot = join(c.dir, "runs")
	const env = {
		PATH: process.env.PATH ?? "",
		HOME: homedir(),
		PP_TESTNET_RUN_ROOT: runRoot,
		PP_REHEARSE_L1_DEPLOYER_KEY: DEPLOYER_KEY,
		PP_REHEARSE_L2_DEPLOYER_SECRET: generateKey("l2"),
	}
	const before = {
		block: await chain.rpc<Hex>("eth_blockNumber"),
		nonce: await chain.rpc<Hex>("eth_getTransactionCount", [deployer, "latest"]),
	}
	const restore = swapInStale(c.dir)
	c.cleanup.push(async () => restore())
	const logFile = join(c.dir, "deploy.log")
	const t0 = performance.now()
	let r: Awaited<ReturnType<typeof ended>>
	try {
		const child = startCli("deploy", [file, "--rehearse", file], env, logFile)
		c.cleanup.push(async () => void (await killGroup(child)))
		r = await ended(child, logFile, 120_000)
	} finally {
		restore()
	}
	const ms = Math.round(performance.now() - t0)
	const refusal = /refused: build: the forge build is not the committed one: PortalFactory: /.test(r.out)
	check(r.code === 2 && refusal, `deploy over a stale build: expected exit 2 at the build check, got exit ${r.code}\n${r.out.trim()}`)
	check((await chain.rpc<Hex>("eth_blockNumber")) === before.block, "a block was mined while deploy ran")
	check((await chain.rpc<Hex>("eth_getTransactionCount", [deployer, "pending"])) === before.nonce, "the deployer signed")
	check(!existsSync(runRoot), "deploy wrote a run directory")
	check(node.calls.join() === NODE_INFO, `deploy asked the node ${node.calls.join(", ")}`)
	check(buildMismatch() === undefined, "the build file was not restored")
	return [
		"PortalFactory's build file swapped for one with a byte of other code",
		`deploy: exit 2 at its build check in ${ms} ms, after the chain and node guards; no block, no deployer nonce, no run directory`,
		"build file restored; it hashes to the committed creation code again",
	]
}
