// The SDK's bundle reaches for a global `Buffer`, which browsers lack; Node and Bun keep their own. The file
// path picks the npm package over Node's builtin, and Node's ESM refuses a bare directory import.
import { Buffer } from "buffer/index.js"

globalThis.Buffer ??= Buffer as unknown as typeof globalThis.Buffer
