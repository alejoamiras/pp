/** What every build whose target is not the local stack bundles in place of the demo sender. */
import type { DemoSender } from "./l1"

export function demoSender(_options: unknown): DemoSender {
	throw new Error("this build has no demo sender")
}
