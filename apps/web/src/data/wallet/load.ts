import { target } from "../../target"
import type { Manifest } from "../capabilities"
import { importChunk } from "../lazy"
import type { RealConnector } from "./connector"

/** The SDK-backed connector, in its own chunk: a fixture-connector build never loads the wallet SDK. */
export function loadRealConnector(manifest: Manifest): Promise<RealConnector> {
	return importChunk(import("./connector")).then((m) => m.createRealConnector(target, manifest))
}
