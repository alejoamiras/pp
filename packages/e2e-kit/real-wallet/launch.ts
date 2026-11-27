/**
 * One Chromium launch with the unpacked wallet behind the browser-level fence. Every request the
 * browser makes, from any page, worker or offscreen document, goes to the egress recorder unless
 * its `127.0.0.1:<port>` is in `ownedPorts`. The proxy is passed as raw switches rather than
 * Playwright's `proxy` option, so no Playwright default (its forced `<-loopback>`, or the variable
 * that disables it) decides what loopback reaches; `<-loopback>` here removes Chromium's own
 * implicit loopback bypass, and each owned port is added back one by one.
 */
import { readFileSync } from "node:fs"
import { type BrowserContext, chromium, type Worker } from "@playwright/test"

export interface LaunchPlan {
	profileDir: string
	extensionDir: string
	recorderPort: number
	/** Every loopback port the browser may reach directly; anything else on loopback is refused. */
	ownedPorts: number[]
	/** Chromium's own sandbox; off only where it cannot start unmodified. */
	sandbox: boolean
}

export interface WalletLaunch {
	context: BrowserContext
	extensionId: string
	worker: Worker
}

/** The `host:port` targets the fence must keep refusing, each approved in `declared-refusals.json`. */
export function declaredRefusals(): string[] {
	const file = JSON.parse(readFileSync(new URL("./declared-refusals.json", import.meta.url), "utf8")) as { hosts?: { host: string }[] }
	return (file.hosts ?? []).map((h) => h.host)
}

/** @throws Error when an owned port is a declared refusal: a port-0 listener can land on one, and owning it would bypass the recorder. */
export function fenceArgs(p: Pick<LaunchPlan, "recorderPort" | "ownedPorts">, refused: string[] = declaredRefusals()): string[] {
	const clash = p.ownedPorts.filter((port) => refused.includes(`127.0.0.1:${port}`))
	if (clash.length > 0) throw new Error(`fence: owned port ${clash.join(", ")} is one the fence must refuse`)
	const bypass = ["<-loopback>", ...p.ownedPorts.map((port) => `127.0.0.1:${port}`)].join(";")
	return [
		`--proxy-server=http://127.0.0.1:${p.recorderPort}`,
		`--proxy-bypass-list=${bypass}`,
		"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
		"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
		"--disable-quic",
	]
}

export async function launchWallet(p: LaunchPlan): Promise<WalletLaunch> {
	const context = await chromium.launchPersistentContext(p.profileDir, {
		channel: "chromium",
		headless: true,
		chromiumSandbox: p.sandbox,
		ignoreDefaultArgs: ["--disable-extensions"],
		viewport: { width: 1280, height: 900 },
		args: [
			`--disable-extensions-except=${p.extensionDir}`,
			`--load-extension=${p.extensionDir}`,
			...fenceArgs(p),
			"--disable-renderer-backgrounding",
			"--disable-backgrounding-occluded-windows",
			"--disable-features=CalculateNativeWinOcclusion,AutofillServerCommunication",
		],
	})
	try {
		const worker =
			context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://")) ??
			(await context.waitForEvent("serviceworker", { timeout: 60_000 }))
		const extensionId = new URL(worker.url()).host
		return { context, extensionId, worker }
	} catch (err) {
		await context.close().catch(() => {})
		throw err
	}
}
