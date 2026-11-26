import { expect, test } from "bun:test"
import { scanTrace } from "./assert-offline.ts"

const reasons = (trace: string) => scanTrace(trace).findings.map((f) => f.reason)

test("loopback traffic over both families passes, and bind is ignored", () => {
	const trace = [
		'4711  connect(21, {sa_family=AF_INET, sin_port=htons(15562), sin_addr=inet_addr("127.0.0.1")}, 16) = -1 EINPROGRESS',
		'[pid  4712] connect(5, {sa_family=AF_INET6, sin6_port=htons(8545), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "::1", &sin6_addr), sin6_scope_id=0}, 28) = 0',
		'4711  connect(6, {sa_family=AF_INET6, sin6_port=htons(80), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "::ffff:127.0.0.1", &sin6_addr), sin6_scope_id=0}, 28) = 0',
		'4711  bind(7, {sa_family=AF_INET, sin_port=htons(0), sin_addr=inet_addr("0.0.0.0")}, 16) = 0',
	].join("\n")
	expect(scanTrace(trace).destinations).toHaveLength(3)
	expect(reasons(trace)).toEqual([])
})

test("DNS, a public IPv6 address and an unconnected UDP sendto all fail", () => {
	expect(reasons('4711  connect(3, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("127.0.0.53")}, 16) = 0')).toEqual([
		"DNS to 127.0.0.53",
	])
	expect(
		reasons(
			'4711  connect(9, {sa_family=AF_INET6, sin6_port=htons(443), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "2001:db8::1", &sin6_addr), sin6_scope_id=0}, 28) = -1 ENETUNREACH',
		),
	).toEqual(["non-loopback 2001:db8::1:443"])
	expect(
		reasons(
			'4711  sendto(4, "\\x12\\x34", 2, MSG_NOSIGNAL, {sa_family=AF_INET, sin_port=htons(123), sin_addr=inet_addr("10.1.2.3")}, 16) = 2',
		),
	).toEqual(["non-loopback 10.1.2.3:123"])
})

test("an inet address in an unrecognised form fails closed", () => {
	expect(reasons("4711  connect(3, {sa_family=AF_INET, sin_port=htons(80), sin_addr=0x0a000001}, 16) = 0")).toEqual([
		"inet address in a form this checker does not parse",
	])
})
