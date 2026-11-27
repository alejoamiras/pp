import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Contract } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxExecutionResult } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { deriveNuloAccountKeys } from "@nulo-sh/wallet-crypto"
import { actorAccount, connectL2, connectPeer, createActor, freshActorSecret, type L2Base, settled } from "@pp/bridge-core/sandbox"
import { aspLeaf, buildLeanImt, type LabelPath } from "@pp/bridge-spec"
import { labelledTokenArtifact } from "@pp/labelled-token"
import {
	announcements,
	attach,
	balance,
	type Deployed,
	deployStage,
	labels,
	publicBalance,
	sendOpts,
	shield,
	values,
} from "@pp/labelled-token/testing"
import { type AspSnapshot, type Hex, labelState, parseAspSnapshot, pathFor, readRootRecord, type RootRecord } from "@pp/label-paths"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { botSecret } from "../../src/accounts"
import { type BotHandle, type BotManifest, startBot } from "../../src/index"
import { approve, deployRegistry } from "./support"

// Run through `bun run test:integration`, which boots the stack and sets PP_STACK_MANIFEST.
const MANIFEST = process.env.PP_STACK_MANIFEST
const RUN = process.env.PP_BOT_INTEGRATION === "1" && MANIFEST !== undefined
const POOL_LABEL = 0xb1e55n
const ORIGIN_BIRTH = 1

type Holder = { wallet: Wallet; from: AztecAddress; fee: Record<string, unknown>; stub: Contract; token: Contract }

const pathArg = (p: LabelPath) => ({ index: p.index, depth: p.depth, siblings: [...p.siblings] })

describe.skipIf(!RUN)("asp-bot births against the local stack", () => {
	const stackRunId = `it-${process.pid}-${randomBytes(3).toString("hex")}`
	const runId = `${stackRunId}-bot`
	let manifest: BotManifest
	let base: L2Base
	let registry: Hex
	let deployed: Deployed
	let bot: BotHandle | undefined
	let alice: Holder
	let bob: Holder
	let born: bigint

	const snapshot = async (at: "latest" | bigint): Promise<AspSnapshot> =>
		parseAspSnapshot(await (await fetch(`${(bot as BotHandle).url}/v1/snapshots/${at}`)).json())
	const record = (at?: number): Promise<RootRecord> =>
		readRootRecord({ aztecNode: manifest.aztecNode, registry, ...(at === undefined ? {} : { at }) })
	const timeAt = async (n: number) => (await base.node.getBlockData(n as never))?.header.globalVariables.timestamp ?? 0n

	async function holder(peer: { wallet: Wallet; fee: Record<string, unknown> }): Promise<Holder> {
		const actor = await createActor(peer.wallet, base.node, peer.fee, freshActorSecret())
		const d = { wallet: peer.wallet, from: actor.address, fee: peer.fee }
		return { ...d, ...(await attach(d, deployed)) }
	}

	beforeAll(async () => {
		manifest = JSON.parse(readFileSync(MANIFEST as string, "utf8")) as BotManifest
		await approve(manifest.pool.aspApiUrl, POOL_LABEL)
		base = await connectL2(manifest.aztecNode)
		registry = await deployRegistry(base, stackRunId)
		deployed = await deployStage({ wallet: base.wallet, from: base.relayer, fee: base.fee }, AztecAddress.fromStringUnsafe(registry))
		bot = await startBot(
			{
				manifest,
				registry,
				tokens: [deployed.token.address.toString() as Hex],
				tag: "latest",
				stackRunId,
				runId,
				inclusionMarginSec: 60,
			},
			{ removeDataOnStop: true },
		)
		const peer = await connectPeer(manifest.aztecNode)
		alice = await holder(peer)
		bob = await holder(peer)
		// A public balance to shield, unshielded from a note under an approved pool label.
		await alice.stub.methods.mint(deployed.token.address, alice.from, 100n, POOL_LABEL).send(sendOpts(alice) as never)
		await settled(
			() => balance(alice.token, alice.from),
			(v) => v === 100n,
			"alice's minted note",
		)
		const pool = pathFor(await snapshot("latest"), POOL_LABEL, 0)
		if (!pool) throw new Error("the bot's first post does not hold the approved pool label")
		await alice.token.methods.unshield(60n, POOL_LABEL, pathArg(pool)).send(sendOpts(alice) as never)
		await settled(
			() => publicBalance(alice.token, alice.from),
			(v) => v === 60n,
			"alice's public balance",
		)
	})

	afterAll(async () => {
		try {
			await bot?.stop()
		} catch (e) {
			process.exitCode = 1
			throw e
		}
	})

	it("a shield's label is ABSENT until the bot posts its birth, then ACTIVE, and spends on the bot's path", async () => {
		const { receipt } = await shield(alice, base.node, 25n)
		expect(receipt.executionResult).toBe(TxExecutionResult.SUCCESS)
		const notes = await settled(
			() => labels(alice.token, alice.from),
			(v) => v.some(([, origin]) => origin === ORIGIN_BIRTH),
			"alice's birth note",
		)
		born = notes.find(([, origin]) => origin === ORIGIN_BIRTH)?.[0] as bigint

		// The record current at the shield's own block cannot hold a birth that block created.
		const shieldBlock = Number(receipt.blockNumber)
		const before = await record(shieldBlock)
		expect(labelState(before, await snapshot(before.sequence), born, ORIGIN_BIRTH, await timeAt(shieldBlock))).toBe("ABSENT")

		// `/latest` moves once the bot's post is checkpointed, a little after the record shows it.
		const want = buildLeanImt([aspLeaf(born)]).root
		const snap = await settled(
			() => snapshot("latest"),
			(s) => s.birthRoot === want,
			"the bot's snapshot of the birth",
			180_000,
		)
		const after = await record()
		expect([snap.birthLeaves, snap.birthRoot, snap.poolRoot]).toEqual([[aspLeaf(born)], after.birthRoot, after.poolRoot])
		const tip = Number(await base.node.getBlockNumber())
		expect(labelState(after, snap, born, ORIGIN_BIRTH, await timeAt(tip))).toBe("ACTIVE")

		const path = pathFor(snap, born, ORIGIN_BIRTH)
		if (!path) throw new Error("no birth path in the bot's snapshot")
		await alice.token.methods.transfer_private(bob.from, 10n, born, pathArg(path)).send(sendOpts(alice) as never)
		await settled(
			() => values(bob.token, bob.from, born),
			(v) => v.length === 1 && v[0] === 10n,
			"bob's birth note",
		)
	})

	it("the bot's log, snapshots and ready fields carry no birth secret, owner or intake key", async () => {
		// The intake's secret is public by design on a local network; reading with it gives the birth's secret.
		const intakeSecret = botSecret("intake", stackRunId)
		const desk = await connectPeer(manifest.aztecNode)
		const { address: intake } = await actorAccount(desk.wallet, intakeSecret)
		await desk.wallet.registerContract(deployed.token, labelledTokenArtifact)
		const [a] = await settled(
			() => announcements(desk.wallet, deployed.token.address, intake),
			(v) => v.length === 1,
			"the intake's announcement",
		)
		if (!a) throw new Error("no announcement")
		const keys = await deriveNuloAccountKeys(Fr.fromHexString(intakeSecret))
		const live = bot as BotHandle
		const latest = await record()
		const bodies = await Promise.all(
			Array.from({ length: Number(latest.sequence) }, (_, i) => fetch(`${live.url}/v1/snapshots/${i + 1}`).then((r) => r.text())),
		)
		const text = [
			readFileSync(join(homedir(), ".cache", "pp", "asp-bot", "logs", `${runId}.log`), "utf8"),
			...bodies,
			JSON.stringify({ url: live.url, poster: live.poster, birthIntake: live.birthIntake }),
		]
			.join("\n")
			.toLowerCase()
		const secrets = [
			a.secret,
			alice.from.toBigInt(),
			BigInt(intakeSecret),
			BigInt(keys.secretKey.toString()),
			BigInt(keys.signingKey.toString()),
		]
		for (const s of secrets) {
			for (const form of [s.toString(), s.toString(16), s.toString(16).padStart(64, "0")]) expect(text).not.toContain(form)
		}
		expect(text).not.toContain("birth_refused")
	})
})
