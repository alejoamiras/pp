import {
	type Account,
	type Address,
	type Chain,
	type Hex,
	isAddressEqual,
	type PublicClient,
	parseAbi,
	parseAbiItem,
	parseEventLogs,
	toHex,
	type Transport,
	type WalletClient,
} from "viem"
import type { Labels } from "./labels.ts"

const ENTRYPOINT_DEPOSITED = parseAbiItem(
	"event Deposited(address indexed _asset, address indexed _depositor, uint256 _value, uint256 _fee)",
)
const VAULT_DEPOSITED = parseAbiItem(
	"event Deposited(uint256 outputCommitment, address indexed asset, uint256 depositedValue, address indexed caller)",
)
const LABEL_REGISTERED = parseAbiItem("event LabelRegistered(bytes _ciphertext)")
const REGISTRY_ABI = parseAbi([
	"function updateASPRoot(uint256 _aspRoot, bytes _ipfsCID)",
	"function latestASPRoot() view returns (uint256)",
])
/** The registry requires a non-empty content id and never reads it. */
const CID = toHex("pp-env/sepolia mock ASP")
/** Blocks per log query: inside what public Sepolia endpoints serve in one call. */
const CHUNK = 5_000n
/** A root post can wait out a congested Sepolia; viem's 3-minute default cannot. */
const RECEIPT_TIMEOUT_MS = 10 * 60_000

export type ApproverOptions = {
	client: PublicClient
	wallet: WalletClient<Transport, Chain, Account>
	labels: Labels
	/** The depositors whose deposits are approved; never empty, since an empty topic filter matches every depositor. */
	owners: readonly [Address, ...Address[]]
	deployment: { aspRegistry: Address; pool: Address; entrypoint: Address; deployBlock: bigint }
	log: (line: string) => void
}

/**
 * The association set, a pure function of the chain: the labels of the owners' deposits, in deposit
 * order. Each tick reads the deposits since the last one and, if any are new, posts the root over the
 * whole set; the set and root served change only once that post has a successful receipt, so the
 * leaves served always rebuild the registry's latest root.
 * @throws Error when `owners` is empty
 */
export function createApprover(o: ApproverOptions) {
	const { client, wallet, labels, log } = o
	if (o.owners.length === 0) throw new Error("the mock ASP needs at least one owner")
	const owners = [...o.owners]
	const { aspRegistry, pool, entrypoint, deployBlock } = o.deployment
	let next = deployBlock
	let settled = deployBlock - 1n
	let approved: readonly bigint[] = []
	let leaves: readonly bigint[] = []
	let root = 0n
	const queued: bigint[] = []

	async function labelIn(hash: Hex): Promise<bigint | undefined> {
		const receipt = await client.getTransactionReceipt({ hash })
		const ours = parseEventLogs({ abi: [ENTRYPOINT_DEPOSITED], logs: receipt.logs }).filter((l) =>
			isAddressEqual(l.address, entrypoint),
		)
		const vault = parseEventLogs({ abi: [VAULT_DEPOSITED], logs: receipt.logs }).filter((l) => isAddressEqual(l.address, pool))
		const regs = parseEventLogs({ abi: [LABEL_REGISTERED], logs: receipt.logs }).filter((l) => isAddressEqual(l.address, aspRegistry))
		// One deposit per transaction pairs its ciphertext with its commitment unambiguously; seed sends one.
		const [reg] = regs
		const [deposit] = vault
		if (receipt.status !== "success" || ours.length !== 1 || vault.length !== 1 || regs.length !== 1 || !reg || !deposit) {
			log(`deposit ${hash} not approved: not one deposit with one label registration`)
			return undefined
		}
		try {
			return labels.labelOf(reg.args._ciphertext, deposit.args.outputCommitment)
		} catch (err) {
			log(`deposit ${hash} not approved: ${err instanceof Error ? err.message : String(err)}`)
			return undefined
		}
	}

	async function scan(head: bigint): Promise<void> {
		while (next <= head) {
			const toBlock = next + CHUNK - 1n < head ? next + CHUNK - 1n : head
			const logs = await client.getLogs({
				address: entrypoint,
				event: ENTRYPOINT_DEPOSITED,
				args: { _depositor: owners },
				fromBlock: next,
				toBlock,
			})
			for (const l of logs) {
				const label = await labelIn(l.transactionHash)
				if (label !== undefined && !approved.includes(label) && !queued.includes(label)) queued.push(label)
			}
			next = toBlock + 1n
		}
	}

	async function post(): Promise<void> {
		const set = [...approved, ...queued]
		const setLeaves = set.map(labels.leafOf)
		const want = await labels.rootOf(setLeaves)
		// An earlier post whose receipt wait timed out may have landed since: the registry takes duplicates, so re-read first.
		const latest = await client.readContract({ address: aspRegistry, abi: REGISTRY_ABI, functionName: "latestASPRoot" }).catch(() => 0n)
		if (latest !== want) {
			const hash = await wallet.writeContract({
				address: aspRegistry,
				abi: REGISTRY_ABI,
				functionName: "updateASPRoot",
				args: [want, CID],
			})
			const receipt = await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })
			if (receipt.status !== "success") throw new Error(`updateASPRoot ${hash} reverted`)
			log(`root ${want} posted in ${hash} over ${set.length} labels`)
		}
		approved = set
		leaves = setLeaves
		root = want
		queued.length = 0
	}

	return {
		/** Reads deposits up to the current head, then posts the root if the set grew. A failed tick is retried whole by the next. */
		async tick(): Promise<void> {
			const head = await client.getBlockNumber()
			await scan(head)
			if (queued.length > 0) await post()
			settled = head
		},
		approved: () => approved,
		/** The served leaves: Poseidon of each approved label, in the same order. */
		leaves: () => leaves,
		root: () => root,
		/** Through this block every owner's deposit is in the posted set, not merely read. */
		scanned: () => settled,
	}
}

export type Approver = ReturnType<typeof createApprover>
