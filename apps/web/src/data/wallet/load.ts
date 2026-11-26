import { target } from "../../target"
import type { Manifest } from "../capabilities"
import type { WalletPort } from "../ports"

/** The SDK-backed connector, in its own chunk: a fixture-connector build never loads the wallet SDK. */
export function loadRealConnector(manifest: Manifest): Promise<WalletPort> {
	return import("./connector").then((m) => m.createRealConnector(target, manifest))
}
