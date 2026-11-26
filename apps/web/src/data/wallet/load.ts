import { target } from "../../target"
import type { WalletConnector } from "./types"

/** The SDK-backed connector, in its own chunk: a fixture-connector build never loads the wallet SDK. */
export function loadRealConnector(): Promise<WalletConnector> {
	return import("./connector").then((m) => m.createRealConnector(target))
}
