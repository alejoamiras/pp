// fund <deployment file> [--quote] [--rehearse-fork <url>]
// Tops each address in `expected` up to the summed gas budgets of its roles at twice today's fee, once,
// from the L1 deployer, the one address the owner funds. `--quote` loads no key and sends nothing: it
// prints what the deployer must hold, the top-ups' own gas included.
import { formatEther } from "viem"
import { l1AddressOf } from "../accounts"
import { assertTopUp, fundingPlan, recipientsOf } from "../funding"
import { GuardError, readKeys } from "../guards"
import { RUN_KEYS } from "../keys"
import { cliArgs, guarded, main, report } from "./common"
import { l1Wallet } from "./wallet"

await main(async () => {
	const { file, mode, values } = cliArgs(process.argv.slice(2), { quote: { type: "boolean" } })
	if (mode.kind === "rehearse")
		throw new GuardError("argv", "the local stack's anvil accounts are funded; fund runs live or on a Sepolia fork")
	const { d, l1 } = await guarded(file, mode, ["expected"], false)
	const deployer = d.expected.l1Deployer
	const recipients = recipientsOf(d.expected)
	const [fees, deployerBalance, ...balances] = await Promise.all([
		l1.estimateFeesPerGas(),
		l1.getBalance({ address: deployer }),
		...recipients.map((r) => l1.getBalance({ address: r.address })),
	])
	const plan = fundingPlan(
		deployer,
		recipients.map((r, i) => ({ ...r, balance: balances[i] as bigint })),
		fees.maxFeePerGas,
	)
	const short = plan.total > deployerBalance ? plan.total - deployerBalance : 0n
	for (const s of plan.sends)
		report("funding-need", { roles: s.roles.join(","), address: s.address, balance: s.balance, need: s.need, topUp: s.amount })
	report("funding-quote", {
		deployer,
		deployerBalance,
		deployerNeed: plan.deployerNeed,
		total: plan.total,
		transferGas: plan.transferGas,
		short,
		shortEth: formatEther(short),
	})
	if (values.quote) return 0
	if (short > 0n) throw new GuardError("funds", `the deployer ${deployer} needs ${formatEther(short)} ETH more before funding`)
	const { L1_DEPLOYER_KEY } = readKeys(RUN_KEYS.fund, mode, { env: process.env }, l1AddressOf)
	const wallet = l1Wallet(d, L1_DEPLOYER_KEY as `0x${string}`, "L1 deployer", deployer)
	for (const s of plan.sends) {
		const roles = s.roles.join(" ")
		if (s.amount === 0n) {
			report("funded", { roles, address: s.address, balanceBefore: s.balance, sent: 0n })
			continue
		}
		const hash = await wallet.sendTransaction({ to: s.address, value: s.amount, chain: wallet.chain })
		assertTopUp(await l1.waitForTransactionReceipt({ hash, timeout: 600_000 }), hash, deployer)
		report("funded", { roles, address: s.address, balanceBefore: s.balance, sent: s.amount, txHash: hash })
	}
	return 0
})
