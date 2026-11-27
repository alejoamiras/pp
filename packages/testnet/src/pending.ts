/** The pending transaction `pause --replace` outbids, read by its hash before any key is loaded. */
import type { PendingTx } from "@pp/bridge-core/deploy"
import {
	type Address,
	type Hash,
	isAddressEqual,
	isHash,
	keccak256,
	type PublicClient,
	recoverTransactionAddress,
	serializeTransaction,
	TransactionNotFoundError,
} from "viem"
import { GuardError } from "./errors"

export type TxReader = Pick<PublicClient, "getTransaction" | "getTransactionCount">

export type PendingQuery = {
	/** The file's endpoint first: it alone answers the nonce counts behind a refusal. */
	readers: readonly TxReader[]
	hash: Hash
	guardian: Address
	nonce: number
	chainId: number
}

/**
 * The guardian's transaction pending at `nonce`, from the first endpoint that knows `hash`: a backend
 * that never saw a transaction answers as if it did not exist, so every pinned endpoint is asked. The
 * answer counts only once its fields hash to `hash` and recover the guardian, so no endpoint can name
 * fees the guardian never signed.
 * @throws GuardError `pending` for another account's, another nonce's or a mined transaction, a record
 * that is not the signed transaction, or one no endpoint knows, naming the command to run instead;
 * Error when no endpoint could be read
 */
export async function pendingToReplace(q: PendingQuery): Promise<PendingTx> {
	let failure: unknown
	for (const reader of q.readers) {
		try {
			return await checked(await reader.getTransaction({ hash: q.hash }), q)
		} catch (e) {
			if (e instanceof GuardError) throw e
			if (!(e instanceof TransactionNotFoundError)) failure ??= e
		}
	}
	if (failure !== undefined)
		throw new Error(
			`no endpoint knew ${q.hash}, and reading one failed: ${failure instanceof Error ? failure.message : String(failure)}`,
		)
	throw await unknown(q)
}

type Tx = Awaited<ReturnType<TxReader["getTransaction"]>>

/** The signed transaction the endpoint's fields describe, for an EIP-1559 or EIP-155 legacy one; else undefined. */
function signedOf(tx: Tx): `0x${string}` | undefined {
	if (tx.chainId === undefined) return undefined
	const base = { chainId: tx.chainId, nonce: tx.nonce, to: tx.to, value: tx.value, data: tx.input, gas: tx.gas }
	if (tx.type === "eip1559")
		return serializeTransaction(
			{
				...base,
				type: "eip1559",
				maxFeePerGas: tx.maxFeePerGas,
				maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
				accessList: tx.accessList,
			},
			{ r: tx.r, s: tx.s, yParity: tx.yParity },
		)
	if (tx.type === "legacy") return serializeTransaction({ ...base, type: "legacy", gasPrice: tx.gasPrice }, { r: tx.r, s: tx.s, v: tx.v })
	return undefined
}

async function checked(tx: Tx, q: PendingQuery): Promise<PendingTx> {
	const refuse = (why: string) => new GuardError("pending", `${q.hash} ${why}`)
	const notIt = refuse("came back as fields that do not hash to it: the endpoint's answer is not that transaction")
	let signed: `0x${string}` | undefined
	try {
		signed = signedOf(tx)
	} catch {
		// viem refuses fields no signer could have produced, such as a tip above the fee cap.
		throw notIt
	}
	if (!signed) throw refuse(`is a ${tx.type} transaction${tx.chainId === undefined ? " with no chain id" : ""}: replace it by hand`)
	if (keccak256(signed).toLowerCase() !== q.hash.toLowerCase()) throw notIt
	if (tx.chainId !== q.chainId) throw refuse(`is a chain ${tx.chainId} transaction`)
	const signer = await recoverTransactionAddress({ serializedTransaction: signed as never }).catch(() => {
		throw notIt
	})
	if (!isAddressEqual(signer, q.guardian)) throw refuse(`is signed by ${signer}, not the guardian ${q.guardian}`)
	if (tx.nonce !== q.nonce) throw refuse(`is at nonce ${tx.nonce}, not ${q.nonce}`)
	if (tx.blockNumber !== null)
		throw refuse(`mined in block ${tx.blockNumber}, so nothing is pending at nonce ${q.nonce}: run \`pause\` without --nonce`)
	const maxFeePerGas = tx.maxFeePerGas ?? tx.gasPrice
	const maxPriorityFeePerGas = tx.maxPriorityFeePerGas ?? tx.gasPrice
	if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined) throw refuse("carries no fee fields")
	return { hash: q.hash, from: signer, nonce: tx.nonce, maxFeePerGas, maxPriorityFeePerGas }
}

async function unknown(q: PendingQuery): Promise<GuardError> {
	const [reader] = q.readers
	const count = (blockTag: "latest" | "pending") => (reader as TxReader).getTransactionCount({ address: q.guardian, blockTag })
	const lead = `no pinned endpoint knows ${q.hash}`
	if ((await count("latest")) > q.nonce)
		return new GuardError("pending", `${lead}, and nonce ${q.nonce} has mined: run \`pause\` without --nonce`)
	const pending = await count("pending")
	if (pending < q.nonce)
		return new GuardError(
			"pending",
			`${lead}, and nonce ${q.nonce} is past the guardian's next nonce ${pending}: run \`pause\` without --nonce`,
		)
	if (pending === q.nonce)
		return new GuardError(
			"pending",
			`${lead}, and nothing is pending at nonce ${q.nonce}: run \`pause --nonce ${q.nonce}\` without --replace`,
		)
	return new GuardError(
		"pending",
		`${lead}, yet a transaction is pending at nonce ${q.nonce}: pass its hash (a pause's \`pause-signed\` or \`pause-failed\` line, or open's log)`,
	)
}

/** `--nonce`'s value: digits only, so an empty `--nonce=` never reads as nonce 0. */
export function nonceOf(value: string | undefined): number | undefined {
	if (value === undefined) return undefined
	const nonce = Number(value)
	if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(nonce))
		throw new GuardError("argv", "--nonce takes a non-negative integer")
	return nonce
}

/** `--replace` needs `--nonce` and `--pending <hash>`, and `--pending` means nothing without `--replace`. */
export function replaceArgs(values: { nonce?: string; replace?: boolean; pending?: string }): { nonce?: number; pending?: Hash } {
	const nonce = nonceOf(values.nonce)
	if (!values.replace) {
		if (values.pending !== undefined) throw new GuardError("argv", "--pending goes with --replace")
		return nonce === undefined ? {} : { nonce }
	}
	if (nonce === undefined) throw new GuardError("argv", "--replace needs --nonce")
	if (values.pending === undefined || !isHash(values.pending))
		throw new GuardError("argv", "--replace needs --pending <hash>: the transaction it replaces at that nonce")
	return { nonce, pending: values.pending }
}
