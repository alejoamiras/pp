export const ATTACH_VARS = ["SANDBOX_L1_RPC", "SANDBOX_NODE_URL"] as const

/**
 * The attach variables make scaffold's harness reuse whatever chain they name, and the pool would
 * then be deployed onto it. A kept stack prints them for scaffold-harness suites, so a shell that
 * ran those still has them set.
 */
export class AttachRefused extends Error {
	constructor(names: readonly string[]) {
		super(
			`${names.join(" and ")} ${names.length > 1 ? "are" : "is"} set, as a kept stack prints them for scaffold-harness suites. ` +
				"The stack always boots its own network: run `unset SANDBOX_L1_RPC SANDBOX_NODE_URL` first.",
		)
		this.name = "AttachRefused"
	}
}

export function refuseAttach(env: Record<string, string | undefined> = process.env): void {
	const set = ATTACH_VARS.filter((k) => env[k])
	if (set.length) throw new AttachRefused(set)
}
