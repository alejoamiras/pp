/** The catalogs a root manifest or `bun.lock` carries at its top level. */
export type Catalogs = { catalog?: Record<string, unknown>; catalogs?: Record<string, unknown> }

const own = (o: unknown, key: string): unknown =>
	typeof o === "object" && o !== null && Object.hasOwn(o, key) ? (o as Record<string, unknown>)[key] : undefined

/**
 * The catalog a dependency spec names, as Bun 1.4.2 reads it (the spec trimmed): `catalog:` and
 * `catalog:default` are `"default"`, `catalog:<name>` is `<name>`; undefined for any other spec.
 */
export function catalogName(spec: string): string | undefined {
	const trimmed = spec.trim()
	if (!trimmed.startsWith("catalog:")) return undefined
	return trimmed.slice("catalog:".length).trim() || "default"
}

/**
 * The range a dependency spec stands for: a catalog reference resolves through the catalog it names
 * (the default one lives in top-level `catalog` or in `catalogs.default`); any other spec is itself.
 *
 * @throws when the named catalog has no own, non-empty string entry for `name`, or when both default
 * catalogs define it.
 */
export function resolveSpec(name: string, spec: string, root: Catalogs): string {
	const which = catalogName(spec)
	if (which === undefined) return spec
	const sources = which === "default" ? [root.catalog, own(root.catalogs, "default")] : [own(root.catalogs, which)]
	const found = sources.filter((s) => own(s, name) !== undefined).map((s) => own(s, name))
	if (found.length > 1) throw new Error(`${name}: ${spec} is defined in both catalog and catalogs.default`)
	const [range] = found
	if (typeof range !== "string" || range.trim() === "") throw new Error(`${name}: ${spec} names no catalog entry`)
	return range
}
