/** The catalogs a root manifest or `bun.lock` carries at its top level. */
export type Catalogs = { catalog?: Record<string, unknown>; catalogs?: Record<string, unknown> }

const own = (o: unknown, key: string): unknown =>
	typeof o === "object" && o !== null && Object.hasOwn(o, key) ? (o as Record<string, unknown>)[key] : undefined

/**
 * The range a dependency spec stands for, as Bun 1.4.2 reads it: `catalog:` and `catalog:default`
 * resolve through the default catalog (top-level `catalog`, or `catalogs.default`), `catalog:<name>`
 * through that named catalog; any other spec is itself.
 *
 * @throws when the named catalog has no own, non-empty string entry for `name`, or when both default
 * catalogs define it.
 */
export function resolveSpec(name: string, spec: string, root: Catalogs): string {
	if (!spec.startsWith("catalog:")) return spec
	const which = spec.slice("catalog:".length).trim()
	const sources = which === "" || which === "default" ? [root.catalog, own(root.catalogs, "default")] : [own(root.catalogs, which)]
	const found = sources.filter((s) => own(s, name) !== undefined).map((s) => own(s, name))
	if (found.length > 1) throw new Error(`${name}: ${spec} is defined in both catalog and catalogs.default`)
	const [range] = found
	if (typeof range !== "string" || range.trim() === "") throw new Error(`${name}: ${spec} names no catalog entry`)
	return range
}
