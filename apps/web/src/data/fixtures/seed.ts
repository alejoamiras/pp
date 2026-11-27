/**
 * The fixture world's first state: the look board's example data (two pool notes, three Aztec labels,
 * a public balance, an allow list posted four minutes ago). Amounts are in base units of a 6-decimal
 * token. Labels and Aztec addresses are field elements, so each is below the BN254 modulus.
 */
import { type Address, checksumAddress } from "viem"
import type { AztecAddress, Origin, PoolNoteStatus } from "../stack-types"
import type { Deployment } from "../ports"
import type { FixtureOp } from "./faults"

export const GENESIS = 1_767_225_600n
export const L1_BLOCK_SECONDS = 12n
/** An Aztec slot is 72 s, six Ethereum blocks; an Aztec block lands at each slot. */
export const L1_BLOCKS_PER_AZTEC_BLOCK = 6
export const DECIMALS = 6
const unit = (whole: number, cents = 0) => BigInt(whole) * 1_000_000n + BigInt(cents) * 10_000n

const field = (head: string, tail: string, fill: string) => `0x${head}${fill.repeat(64 - head.length - tail.length)}${tail}`
const az = (head: string, tail: string) => field(head, tail, "0") as AztecAddress
const eth = (lower: string) => checksumAddress(lower as Address)

export const ACCOUNTS = {
	owner: eth("0x7a3e5c0de1b2a3c4d5e6f708192a3b4c5d6e91cd"),
	sender: eth("0x51c0ffee00a1b2c3d4e5f60718293a4b5c6de2a4"),
	aztec: az("1c4f", "e9b4"),
}

export function fixtureDeployment(chainId: number): Deployment {
	const portal = eth("0x9047a1000000000000000000000000000000b1d9")
	const hub = az("0a1b", "4b1d")
	return {
		id: `${chainId}:${portal}:${hub}`.toLowerCase(),
		chainId,
		stage: "2d",
		portal,
		hub,
		token: az("0b2c", "70c3"),
		sponsoredFpc: az("0c3d", "f9c0"),
		decimals: DECIMALS,
		symbol: "USDC",
	}
}

export const LABELS = {
	bridgeable: BigInt(field("2f9c", "a41e", "5")),
	pending: BigInt(field("08b1d", "07f3", "6")),
	active: BigInt(field("05e07", "c3d8", "7")),
	shielded: BigInt(field("091aa", "2b6f", "8")),
	revoked: BigInt(field("03d42", "f810", "9")),
}

export interface FixtureNote {
	commitment: bigint
	label: bigint
	value: bigint
	status: PoolNoteStatus
}
export interface AztecNote {
	owner: AztecAddress
	label: bigint
	origin: Origin
	value: bigint
}
export interface FixtureBridge {
	id: string
	owner: Address
	note: bigint
	nullifier: bigint
	recipient: AztecAddress
	label: bigint
	amount: bigint
	l1TxHash?: `0x${string}`
	/**
	 * `pending`: journalled before the Ethereum send, with no hash yet; `sent`: the wallet returned a hash
	 * that is not mined. Both live in this device's journal only.
	 */
	state: "pending" | "sent" | "mined" | "reverted" | "claimed"
	minedAtAztecBlock: number
	/** Dropped from this device's journal; still on chain for `recover` once mined. */
	forgotten?: true
}
export interface FixtureExit {
	deployment: string
	l2TxHash: `0x${string}`
	messageIndexInTx: number
	kind: "ragequit" | "public"
	payee: Address
	amount: bigint
	label: bigint
	readyAtAztecBlock: number
	settledTx?: `0x${string}`
}

export interface WorldState {
	v: 1
	l1Block: number
	/** The deployment's chain; a stored world for another chain is discarded. */
	chainId: number
	/** The chain the fixture Ethereum wallet is on. */
	walletChain: number
	selected: "owner" | "sender"
	notes: FixtureNote[]
	aztecNotes: AztecNote[]
	publicBalances: { owner: AztecAddress; amount: bigint }[]
	bridges: FixtureBridge[]
	exits: FixtureExit[]
	allowList: { sequence: bigint; rootTime: bigint; l1Block: bigint; pool: bigint[]; birth: bigint[]; pendingBirths: bigint[] }
	faults: { fail: { op: FixtureOp; code: string }[]; reprove: string[]; hang: FixtureOp[] }
	counter: number
	sent: { l1: number; aztec: number }
	declineNextGrant: boolean
	/** Which of the owner's two keys the keystore holds; a world without it is registered. */
	keystore?: { authPolicy: boolean; viewingKey: boolean }
}

export function seedWorld(chainId: number): WorldState {
	const a = ACCOUNTS.aztec
	return {
		v: 1,
		l1Block: 0,
		chainId,
		walletChain: chainId,
		selected: "owner",
		notes: [
			{ commitment: 0x1001n, label: LABELS.bridgeable, value: unit(100), status: "approved" },
			{ commitment: 0x1002n, label: LABELS.pending, value: unit(25), status: "pending" },
		],
		aztecNotes: [
			{ owner: a, label: LABELS.active, origin: 0, value: unit(25) },
			{ owner: a, label: LABELS.active, origin: 0, value: unit(15) },
			{ owner: a, label: LABELS.shielded, origin: 1, value: unit(12, 50) },
			{ owner: a, label: LABELS.revoked, origin: 0, value: unit(6) },
		],
		publicBalances: [{ owner: a, amount: unit(15) }],
		bridges: [],
		exits: [],
		allowList: {
			sequence: 128n,
			rootTime: GENESIS - 240n,
			l1Block: 0n,
			pool: [LABELS.bridgeable, LABELS.active],
			birth: [],
			pendingBirths: [LABELS.shielded],
		},
		faults: { fail: [], reprove: [], hang: [] },
		counter: 0,
		sent: { l1: 0, aztec: 0 },
		declineNextGrant: false,
	}
}
