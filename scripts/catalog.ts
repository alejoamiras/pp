/** The catalogs a root manifest or `bun.lock` carries at its top level. */
export type Catalogs = { catalog?: Record<string, string>; catalogs?: Record<string, Record<string, string>> }

/**
 * The range a dependency spec stands for: `catalog:` resolves through the default catalog and
 * `catalog:<name>` through that named catalog; any other spec is itself.
 *
 * @throws when the catalog the spec names has no entry for `name`.
 */
export function resolveSpec(name: string, spec: string, root: Catalogs): string {
	if (!spec.startsWith("catalog:")) return spec
	const which = spec.slice("catalog:".length)
	const range = which === "" ? root.catalog?.[name] : root.catalogs?.[which]?.[name]
	if (range === undefined) throw new Error(`${name}: ${spec} names no catalog entry`)
	return range
}
