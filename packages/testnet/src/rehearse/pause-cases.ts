/**
 * The guardian's failure and recovery cases, each on its own anvil through the real `pause` CLI with
 * real sends. Every wait is the CLI's own (`PAUSE_WAITS`, `PUBLIC_CHAIN_TIMING`), so a case that ends in
 * PAUSE_BLOCKED, PAUSE_STALLED or PAUSE_UNFINALIZED takes that budget in wall time.
 */
import { PAUSE_WAITS } from "@pp/bridge-core/deploy"
import {
	type CaseCtx,
	check,
	expectFailed,
	expectPaused,
	finished,
	knows,
	nonceOf,
	pause,
	pausedNow,
	receiptOf,
	sendOpen,
	signedEvent,
	stage,
	startPause,
	until,
} from "./pause-stage"

/** Room past a budget for the CLI's 4 s polls, its exit and the log read. */
const SLACK_MS = 180_000
const secs = (ms: number) => `${Math.round(ms / 1000)} s`

/**
 * An open left pending, and a pause sent through a backend that does not see it: the pause signs at the
 * open's nonce, the backend acknowledges and loses it, the open mines, and the pause re-reads and sends
 * again at the next nonce.
 */
export async function pendingOpenResend(c: CaseCtx): Promise<string[]> {
	const s = await stage(c, { proxy: true })
	const proxy = s.proxy as NonNullable<typeof s.proxy>
	await s.miner.pause()
	const open = await sendOpen(s)
	proxy.rules.pendingAsLatest = true
	proxy.rules.dropNonce = open.nonce
	const run = startPause(s, [])
	check((await signedEvent(run)).nonce === open.nonce, "the first send was not at the pending open's nonce")
	await until(() => proxy.dropped.length === 1, "the backend took the first send")
	s.miner.resume()
	const r = await finished(run, 300_000)
	expectPaused(r, open.nonce + 1, "pause after its nonce was taken")
	check((await receiptOf(s, open.hash))?.status === "0x1", "the open did not land first")
	check(await pausedNow(s), "entries open after the pause")
	const sends = r.events.filter((e) => e.event === "pause-signed").map((e) => e.nonce)
	return [
		`open pending at nonce ${open.nonce}; pause through a backend without the pool signed at ${sends.join(", then ")}`,
		`the first send was lost and the open mined; pause re-read, resent and exited 0 at nonce ${open.nonce + 1} in ${secs(r.ms)}; entries paused`,
	]
}

/**
 * An open left pending in a backend's pool that never reaches a block: that backend counts it, so the
 * pause queues behind a gap at the open's nonce, stops with PAUSE_BLOCKED naming it, and `pause --nonce`
 * fills it while blocks keep coming.
 */
export async function nonceGap(c: CaseCtx): Promise<string[]> {
	const s = await stage(c, { proxy: true })
	const proxy = s.proxy as NonNullable<typeof s.proxy>
	proxy.rules.dropNonce = await nonceOf(s)
	const open = await sendOpen(s, { via: proxy.url })
	const run = startPause(s, [])
	const queued = await signedEvent(run)
	check(queued.nonce === open.nonce + 1, "the pause did not queue behind the pending open")
	await until(() => knows(s, queued.hash as `0x${string}`), "the anvil took the queued pause")
	c.log(`pause queued behind the gap; waiting out its ${secs(PAUSE_WAITS.stallMs)} stall budget`)
	const blocked = await finished(run, PAUSE_WAITS.stallMs + SLACK_MS)
	expectFailed(blocked, "PAUSE_BLOCKED", open.nonce, "pause behind a gap")
	check(blocked.ms >= PAUSE_WAITS.stallMs, `PAUSE_BLOCKED came after ${secs(blocked.ms)}, inside its budget`)
	// The backend relays a send at the gap's nonce from here on, as it would a fee bump of the open it holds.
	proxy.rules.dropNonce = undefined
	const filled = await pause(s, ["--nonce", String(open.nonce)])
	expectPaused(filled, open.nonce, "pause --nonce at the gap")
	check((await receiptOf(s, open.hash)) === null, "the lost open landed")
	check((await receiptOf(s, queued.hash as `0x${string}`))?.status === "0x1", "the queued pause did not mine behind the gap")
	check(await pausedNow(s), "entries open after pause --nonce")
	return [
		`open pending at nonce ${open.nonce} in a backend's pool that never reaches a block; pause queued at ${open.nonce + 1}`,
		`pause: PAUSE_BLOCKED at nonce ${open.nonce}, exit 1, after ${secs(blocked.ms)}`,
		`pause --nonce ${open.nonce}: exit 0 in ${secs(filled.ms)}; the queued pause mined behind it; entries paused`,
	]
}

/**
 * A pause whose send the node rejects as replacement-underpriced, behind an open signed at five times
 * today's fee estimate, past what four times the estimate outbids: PAUSE_NONCE_OCCUPIED, then each
 * manual branch from a fresh occupied nonce, the replacement priced from the open itself.
 */
export async function occupiedNonce(c: CaseCtx): Promise<string[]> {
	const s = await stage(c, { proxy: true })
	const proxy = s.proxy as NonNullable<typeof s.proxy>
	proxy.rules.pendingAsLatest = true
	const occupy = async () => {
		await s.miner.pause()
		const open = await sendOpen(s, { feeFactor: 5n })
		const r = await pause(s, [])
		expectFailed(r, "PAUSE_NONCE_OCCUPIED", open.nonce, "pause behind a higher-fee open")
		check((await nonceOf(s)) === open.nonce && (await knows(s, open.hash)), "the open left the pool")
		return open
	}
	const first = await occupy()
	s.miner.resume()
	await until(async () => (await receiptOf(s, first.hash)) !== null, "the open landed")
	const after = await pause(s, [])
	expectPaused(after, first.nonce + 1, "pause once the open landed")

	const second = await occupy()
	const run = startPause(s, ["--nonce", String(second.nonce), "--replace", "--pending", second.hash])
	const replacement = await signedEvent(run)
	await until(() => knows(s, replacement.hash as `0x${string}`), "the anvil took the replacement")
	s.miner.resume()
	const replaced = await finished(run, 300_000)
	expectPaused(replaced, second.nonce, "pause --nonce --replace")
	check((await receiptOf(s, second.hash)) === null, "the replaced open landed")
	check(await pausedNow(s), "entries open after the replacement")
	return [
		`open pending at nonce ${first.nonce} at 5x the fee estimate; pause: PAUSE_NONCE_OCCUPIED at ${first.nonce}, exit 1`,
		`branch 1: the open landed; pause exited 0 at nonce ${first.nonce + 1} in ${secs(after.ms)}`,
		`branch 2: open pending at ${second.nonce}; PAUSE_NONCE_OCCUPIED; pause --nonce ${second.nonce} --replace --pending <the open> exited 0 in ${secs(replaced.ms)}, the open never landed`,
	]
}

/**
 * A pause that mines while finality stalls below it: PAUSE_UNFINALIZED once the finality budget runs
 * out, then a second `pause`, run as every unreported outcome is, once finality moves again.
 */
export async function finalityTimeout(c: CaseCtx): Promise<string[]> {
	const s = await stage(c, { proxy: true })
	const proxy = s.proxy as NonNullable<typeof s.proxy>
	const open = await sendOpen(s)
	await until(async () => (await receiptOf(s, open.hash)) !== null, "the open landed")
	const finalized = await s.chain.rpc<{ number: `0x${string}` }>("eth_getBlockByNumber", ["finalized", false])
	proxy.rules.finalizedAt = BigInt(finalized.number)
	c.log(`finality held; waiting out the pause's ${secs(PAUSE_WAITS.finalityMs)} finality budget`)
	const stuck = await pause(s, [], PAUSE_WAITS.finalityMs + SLACK_MS)
	expectFailed(stuck, "PAUSE_UNFINALIZED", open.nonce + 1, "pause under stalled finality")
	check(stuck.ms >= PAUSE_WAITS.finalityMs, `PAUSE_UNFINALIZED came after ${secs(stuck.ms)}, inside its budget`)
	check(await pausedNow(s), "entries open at the head after the unfinalized pause")
	proxy.rules.finalizedAt = undefined
	const again = await pause(s, [])
	const p = expectPaused(again, open.nonce + 2, "pause once finality moved")
	check(p.wasPaused === true, "the second pause did not see entries paused")
	return [
		`entries open; finalized held at block ${BigInt(finalized.number)} while blocks kept coming`,
		`pause: mined, then PAUSE_UNFINALIZED at nonce ${open.nonce + 1}, exit 1, after ${secs(stuck.ms)}`,
		`finality moved; pause again: exit 0 at nonce ${open.nonce + 2} in ${secs(again.ms)}, wasPaused true`,
	]
}

/**
 * A pause at the next nonce that cannot mine because the base fee rose past its fee cap and stays
 * there: PAUSE_STALLED once the stall budget runs out, then `pause --nonce --replace --pending`.
 */
export async function stalledPause(c: CaseCtx): Promise<string[]> {
	const s = await stage(c)
	await s.miner.pause()
	const nonce = await nonceOf(s)
	const run = startPause(s, [])
	const sent = await signedEvent(run)
	check(sent.nonce === nonce, "the pause was not at the next nonce")
	await until(() => knows(s, sent.hash as `0x${string}`), "the anvil took the pause")
	const tx = await s.chain.rpc<{ maxFeePerGas: `0x${string}` }>("eth_getTransactionByHash", [sent.hash])
	const spike = BigInt(tx.maxFeePerGas) * 10n
	s.miner.holdBaseFee(spike)
	s.miner.resume()
	c.log(`base fee held above the pause's cap; waiting out its ${secs(PAUSE_WAITS.stallMs)} stall budget`)
	const stalled = await finished(run, PAUSE_WAITS.stallMs + SLACK_MS)
	expectFailed(stalled, "PAUSE_STALLED", nonce, "pause under a fee spike")
	check(stalled.ms >= PAUSE_WAITS.stallMs, `PAUSE_STALLED came after ${secs(stalled.ms)}, inside its budget`)
	check((await nonceOf(s)) === nonce, "the stalled nonce moved")
	const replaced = await pause(s, ["--nonce", String(nonce), "--replace", "--pending", sent.hash as string])
	expectPaused(replaced, nonce, "pause --nonce --replace over the stalled pause")
	check((await receiptOf(s, sent.hash as `0x${string}`)) === null, "the stalled pause mined")
	check(await pausedNow(s), "entries open after the replacement")
	return [
		`pause at nonce ${nonce} capped at ${BigInt(tx.maxFeePerGas)} wei; the base fee then held at ${spike} wei`,
		`pause: PAUSE_STALLED at nonce ${nonce}, exit 1, after ${secs(stalled.ms)}`,
		`pause --nonce ${nonce} --replace --pending <the stalled pause>: exit 0 in ${secs(replaced.ms)}; the stalled send never mined`,
	]
}
