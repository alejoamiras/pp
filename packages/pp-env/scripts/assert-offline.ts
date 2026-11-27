#!/usr/bin/env bun
// Fails if an `strace -f -e trace=%network` log shows traffic to anything but loopback, or any DNS.
// Diagnostic evidence only: CI enforces offline runs with an isolated network namespace.
import { readFileSync } from "node:fs"

export type Destination = { line: number; family: "inet" | "inet6"; address: string; port: number }
export type Finding = { line: number; reason: string; text: string }

// Only calls that name a destination; bind() to a wildcard address is not traffic.
const SENDING_CALL = /^(?:\[pid\s+\d+\]\s+|\d+\s+)?(?:connect|sendto|sendmsg|sendmmsg)\(/
const INET = /sa_family=AF_INET,\s*sin_port=htons\((\d+)\),\s*sin_addr=inet_addr\("([^"]*)"\)/g
const INET6 = /sa_family=AF_INET6,\s*sin6_port=htons\((\d+)\)[^}]*?inet_pton\(AF_INET6,\s*"([^"]*)"/g

const isLoopback4 = (a: string) => /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)
const isLoopback6 = (a: string) => a === "::1" || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)

function destinationsIn(text: string, line: number): Destination[] {
	return [
		...[...text.matchAll(INET)].map((m) => ({ line, family: "inet" as const, port: Number(m[1]), address: m[2] ?? "" })),
		...[...text.matchAll(INET6)].map((m) => ({ line, family: "inet6" as const, port: Number(m[1]), address: m[2] ?? "" })),
	]
}

function verdict(d: Destination): string | undefined {
	if (d.port === 53) return `DNS to ${d.address}`
	const loopback = d.family === "inet" ? isLoopback4(d.address) : isLoopback6(d.address)
	return loopback ? undefined : `non-loopback ${d.address}:${d.port}`
}

export function scanTrace(trace: string): { destinations: Destination[]; findings: Finding[] } {
	const destinations: Destination[] = []
	const findings: Finding[] = []
	trace.split("\n").forEach((text, i) => {
		const line = i + 1
		if (!SENDING_CALL.test(text)) return
		const found = destinationsIn(text, line)
		const families = (text.match(/sa_family=AF_INET6?\b/g) ?? []).length
		if (found.length !== families) findings.push({ line, reason: "inet address in a form this checker does not parse", text })
		destinations.push(...found)
		for (const reason of found.map(verdict)) if (reason) findings.push({ line, reason, text })
	})
	return { destinations, findings }
}

if (import.meta.main) {
	const path = process.argv[2]
	if (!path) {
		console.error("usage: assert-offline.ts <strace log>")
		process.exit(2)
	}
	const { destinations, findings } = scanTrace(readFileSync(path, "utf8"))
	for (const f of findings) console.error(`${path}:${f.line}: ${f.reason}\n  ${f.text.trim()}`)
	// A trace with no inet destinations means strace saw nothing, not that the run was offline.
	if (destinations.length === 0) {
		console.error(`${path}: no inet destinations at all; was the run traced?`)
		process.exit(1)
	}
	const ports = [...new Set(destinations.map((d) => d.port))].sort((a, b) => a - b)
	console.log(`${destinations.length} destinations, loopback only: ${findings.length === 0}; ports ${ports.join(" ")}`)
	process.exit(findings.length === 0 ? 0 : 1)
}
