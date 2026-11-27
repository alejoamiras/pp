import { resolveSameOrigin } from "./build/same-origin"
import type { PublicTarget } from "./build/target"

export const target: PublicTarget = resolveSameOrigin(__PP_TARGET__, globalThis.location?.origin)
