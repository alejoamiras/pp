/** An Inbox message's gas depends on the bucket state it lands in (the first message of an L1 block
 *  opens a new bucket), which an earlier estimate cannot see; bare estimates have run out of gas. */
const L1_GAS_HEADROOM_PERCENT = 125n

/** An L1 gas limit for a transaction that sends an Inbox message, rounded up. */
export function sendGasLimit(estimate: bigint): bigint {
	return (estimate * L1_GAS_HEADROOM_PERCENT + 99n) / 100n
}
