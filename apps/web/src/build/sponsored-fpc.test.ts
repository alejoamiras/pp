import { sponsoredFpcAddress as signInAddress } from "@pp/bridge-core"
import { expect, test } from "vitest"
import { sponsoredFpcAddress } from "./sponsored-fpc"

// The grant needs the fee payer before sign-in, so the target carries it; the session derives it again
// from the artifact, and a page whose two copies differ would grant one FPC and pay with another.
test("the build's SponsoredFPC address is the one bridge-core derives when a session opens", async () => {
	expect(await sponsoredFpcAddress()).toBe((await signInAddress()).toString())
}, 60_000)
