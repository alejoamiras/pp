/** The labelled token as one account reads and calls it through its own wallet. */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract } from "@aztec-labs/aztec.js/contracts"
import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { ExecutionPayload } from "@aztec-labs/stdlib/tx"
import { sponsoredFpcAddress } from "@pp/bridge-core"
import { labelledTokenArtifact } from "@pp/bridge-core/artifacts"
import type { LabelPath } from "@pp/label-paths"

/** `private_balances_by_label` and `private_notes_by_label` page sizes (`LABELS_PER_PAGE`, `VALUES_PER_PAGE`). */
const LABELS_PER_PAGE = 16
const VALUES_PER_PAGE = 10

export type LabelRow = { label: bigint; origin: number; balance: bigint }

export type TokenView = {
	/** Every `(label, origin)` pair the account holds, with its balance. */
	labels(): Promise<LabelRow[]>
	/** The values of the account's `label` notes, largest first. */
	values(label: bigint): Promise<bigint[]>
	transfer(to: AztecAddress, amount: bigint, label: bigint, path: LabelPath): Promise<ExecutionPayload>
	unshield(amount: bigint, label: bigint, path: LabelPath): Promise<ExecutionPayload>
	shield(amount: bigint): Promise<ExecutionPayload>
}

/** A simulation's `BoundedVec` value as its rows, whether or not the wallet wraps it in `{ result }`. */
function rowsOf(r: unknown): unknown[] {
	const v = (r && typeof r === "object" && "result" in r ? (r as { result: unknown }).result : r) as
		| { storage?: unknown[]; len?: bigint | number }
		| unknown[]
	return Array.isArray(v) ? v : (v.storage ?? []).slice(0, Number(v.len ?? 0))
}

async function allPages<T>(page: (start: number) => Promise<T[]>, size: number): Promise<T[]> {
	const out: T[] = []
	for (let start = 0; ; start += size) {
		const rows = await page(start)
		out.push(...rows)
		if (rows.length < size) return out
	}
}

const pathArg = (p: LabelPath) => ({ index: p.index, depth: p.depth, siblings: [...p.siblings] })

type Methods = Record<
	string,
	(...args: unknown[]) => { simulate(o: unknown): Promise<unknown>; request(o: unknown): Promise<ExecutionPayload> }
>

/** `owner`'s view of `token` through `wallet`, which must hold `owner` and the token's instance. Every call it builds pays through the SponsoredFPC. */
export function tokenView(wallet: unknown, token: AztecAddress, owner: AztecAddress): TokenView {
	const methods = Contract.at(token, labelledTokenArtifact, wallet as never).methods as unknown as Methods
	const view = async (name: string, ...args: unknown[]) =>
		rowsOf(await (methods[name] as Methods[string])(...args).simulate({ from: owner }))
	const call = async (name: string, ...args: unknown[]) =>
		(methods[name] as Methods[string])(...args).request({
			fee: { paymentMethod: new SponsoredFeePaymentMethod(await sponsoredFpcAddress()) },
		})
	return {
		labels: () =>
			allPages(async (start) => {
				const rows = await view("private_balances_by_label", owner, start)
				return rows.map((e) => {
					const [label, origin, balance] = Object.values(e as object) as [bigint, bigint | number, bigint]
					return { label: BigInt(label), origin: Number(origin), balance: BigInt(balance) }
				})
			}, LABELS_PER_PAGE),
		values: (label) =>
			allPages(
				async (start) => (await view("private_notes_by_label", owner, new Fr(label), start)).map((v) => BigInt(v as bigint)),
				VALUES_PER_PAGE,
			),
		transfer: (to, amount, label, path) => call("transfer_private", to, amount, new Fr(label), pathArg(path)),
		unshield: (amount, label, path) => call("unshield", amount, new Fr(label), pathArg(path)),
		shield: (amount) => call("shield", amount),
	}
}
