import { EvmDeploymentSnapshotSource } from "#ppv2/mock-asp/evm"
import { createPublicClient, createWalletClient, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { createApprover } from "./approver.ts"
import { assertSepolia, hasPostman, SEPOLIA, sepolia } from "./chain.ts"
import { startFront } from "./front.ts"
import { createLabels } from "./labels.ts"
import type { MockAsp, StartMockAspOptions } from "./types.ts"

const SLOT_MS = 12_000

/**
 * Starts a mock ASP for a pool this run deployed on Sepolia: it approves the deposits of `owners` alone,
 * posts each grown set's root with `postmanKey`, and serves the set on `port` through read routes only.
 * It binds the port only after its first full scan and root post, so its first answer already matches
 * the registry.
 * @throws Error when either chain id is not 11155111, `owners` is empty, the postman key lacks the
 * postman role, or the first scan or post fails; nothing is left running
 */
export async function startMockAsp(o: StartMockAspOptions): Promise<MockAsp> {
	const log = o.log ?? (() => {})
	const client = createPublicClient({ transport: http(o.rpcUrl) })
	await assertSepolia(client, o.chainId)
	const account = privateKeyToAccount(o.postmanKey)
	if (!(await hasPostman(client, o.deployment.accessRouter, account.address)))
		throw new Error(`${account.address} does not hold the postman role on ${o.deployment.accessRouter}`)
	const wallet = createWalletClient({ account, chain: sepolia, transport: http(o.rpcUrl) })
	const labels = await createLabels(o.postmanKey)
	const approver = createApprover({ client, wallet, labels, owners: o.owners, deployment: o.deployment, log })
	await approver.tick()
	const snapshots = new EvmDeploymentSnapshotSource({ chainId: SEPOLIA, deploymentBlock: o.deployment.deployBlock })
	const front = startFront({
		port: o.port,
		chainId: SEPOLIA,
		entrypoint: o.deployment.entrypoint,
		state: {
			root: approver.root,
			leaves: approver.leaves,
			publicKey: labels.publicKey,
			snapshot: () => snapshots.getEventSnapshot(),
		},
	})
	log(`mock ASP on ${front.url}, approving deposits from ${o.owners.join(", ")}`)

	let stopping = false
	let timer: ReturnType<typeof setTimeout> | undefined
	let inflight: Promise<void> = Promise.resolve()
	const poll = () => {
		inflight = approver
			.tick()
			.catch((err: unknown) => log(`scan failed, retried next poll: ${err instanceof Error ? err.message : String(err)}`))
			.finally(() => {
				if (!stopping) timer = setTimeout(poll, o.pollMs ?? SLOT_MS)
			})
	}
	timer = setTimeout(poll, o.pollMs ?? SLOT_MS)
	let stopped: Promise<void> | undefined
	return {
		url: front.url,
		publicKey: labels.publicKey,
		approved: approver.approved,
		scanned: approver.scanned,
		stop: () => {
			stopping = true
			clearTimeout(timer)
			stopped ??= inflight.then(() => front.stop())
			return stopped
		},
	}
}
