// The SDK's bundle reaches for a global `Buffer`, which browsers lack; Node and Bun keep their own.
import { Buffer } from "buffer/"

globalThis.Buffer ??= Buffer as unknown as typeof globalThis.Buffer
