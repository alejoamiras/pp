import { z } from "zod"

// zod probes `new Function` on first schema use to pick its JIT path, and `script-src` without
// 'unsafe-eval' reports that probe as a violation. Must run before any module builds a schema.
z.config({ jitless: true })
