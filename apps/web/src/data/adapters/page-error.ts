import { isBridgeClientError } from "@pp/bridge-core"
import { ProviderError } from "../errors"

/** bridge-core reports the wallet's no before broadcast as `RPC_FAILED`; the page reads it as the wallet's refusal. */
export function asPageError(err: unknown): unknown {
	if (isBridgeClientError(err) && err.code === "RPC_FAILED" && err.source === "UserRejectedRequestError")
		return new ProviderError(4001, "The wallet declined the request.")
	return err
}
