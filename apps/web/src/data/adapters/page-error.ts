import { isBridgeClientError } from "@pp/bridge-core"
import { BridgeFailure, ProviderError } from "../errors"

/**
 * bridge-core's errors where the page reads them its own way. It reports the wallet's no before
 * broadcast as `RPC_FAILED`: the page reads the wallet's refusal. It reports a proving file that failed
 * to load or to match as `SPEND_MISMATCH` (`ARTIFACT_MISMATCH`): the page reads `PROVING_FILES_FAILED`,
 * since nothing is wrong with the spend.
 */
export function asPageError(err: unknown): unknown {
	if (!isBridgeClientError(err)) return err
	if (err.code === "RPC_FAILED" && err.source === "UserRejectedRequestError")
		return new ProviderError(4001, "The wallet declined the request.")
	if (err.code === "SPEND_MISMATCH" && err.source === "ARTIFACT_MISMATCH") return new BridgeFailure("PROVING_FILES_FAILED")
	return err
}
