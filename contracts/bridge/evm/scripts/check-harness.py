#!/usr/bin/env python3
"""The symbolic proofs drive ProcessorPortalHarness, so it may differ from ProcessorPortalImpl only in
`_contentHash`. Compares the two contracts' selectors and storage (as slot, offset, type: the raw
layout names its contract and always differs), then reads the harness's AST: it must inherit the
portal directly and declare only a constructor that passes its parameters on unchanged and the
`_contentHash` override, whose body is exactly HASH_BODY and names nothing but its parameter and
builtins. Reads build artifacts only, so run it after
`forge build --ast --extra-output storageLayout` in contracts/bridge/evm.
"""

import json
import re
import sys

PORTAL, HARNESS = "ProcessorPortalImpl", "ProcessorPortalHarness"
PORTAL_SOURCE = "src/ProcessorPortalImpl.sol"
ARTIFACTS = {
    PORTAL: "out/ProcessorPortalImpl.sol/ProcessorPortalImpl.json",
    HARNESS: "out/ProcessorPortalHarness.sol/ProcessorPortalHarness.json",
}
# Whitespace-free: any other body could make the harness revert or diverge where no proof looks.
HASH_BODY = "{returnbytes32(uint256(keccak256(preimage))&type(uint248).max);}"


def artifact(name):
    with open(ARTIFACTS[name]) as f:
        return json.load(f)


def layout(a):
    return [(s["slot"], s["offset"], s["type"]) for s in a["storageLayout"]["storage"]]


def describe(node):
    return f"{node['nodeType']} {node.get('kind') or ''} {node.get('name') or ''}".strip()


def identifiers(node):
    if isinstance(node, dict):
        if node.get("nodeType") == "Identifier":
            yield node
        for v in node.values():
            yield from identifiers(v)
    elif isinstance(node, list):
        for v in node:
            yield from identifiers(v)


def hash_body_errors(ast, fn):
    start, length, _ = (int(x) for x in fn["body"]["src"].split(":"))
    with open(ast["absolutePath"], "rb") as f:
        body = f.read()[start : start + length].decode()
    errors = []
    if re.sub(r"\s+", "", body) != HASH_BODY:
        errors.append(f"the harness _contentHash body is not exactly {HASH_BODY}")
    params = [p["id"] for p in fn["parameters"]["parameters"]]
    # Builtins have negative declaration ids, so a shadowing import or free function shows up here.
    foreign = [i["name"] for i in identifiers(fn["body"]) if i["referencedDeclaration"] not in params and i["referencedDeclaration"] >= 0]
    if foreign or fn["modifiers"] or fn["stateMutability"] != "pure":
        errors.append(f"the harness _contentHash must be pure, unmodified and name only its parameter and builtins: {foreign}")
    return errors


def harness_shape_errors(ast):
    [contract] = [n for n in ast["nodes"] if n.get("nodeType") == "ContractDefinition" and n["name"] == HARNESS]
    errors = []
    bases = [b["baseName"] for b in contract["baseContracts"]]
    # A name can be rebound by a different import, so the base must resolve to the portal's own file.
    portal_ids = {
        alias["foreign"]["referencedDeclaration"]
        for n in ast["nodes"]
        if n["nodeType"] == "ImportDirective" and n["absolutePath"] == PORTAL_SOURCE
        for alias in n["symbolAliases"]
        if alias["foreign"]["name"] == PORTAL
    }
    if [b["name"] for b in bases] != [PORTAL] or bases[0]["referencedDeclaration"] not in portal_ids:
        errors.append(f"the harness must inherit exactly {PORTAL}, imported from {PORTAL_SOURCE}")
    members = contract["nodes"]
    ctors = [m for m in members if m["nodeType"] == "FunctionDefinition" and m["kind"] == "constructor"]
    hashes = [
        m
        for m in members
        if m["nodeType"] == "FunctionDefinition" and m["kind"] == "function" and m["name"] == "_contentHash"
    ]
    others = [describe(m) for m in members if m not in ctors and m not in hashes]
    if others:
        errors.append("the harness declares more than a constructor and _contentHash: " + ", ".join(others))
    if len(ctors) != 1 or len(hashes) != 1:
        errors.append("the harness must declare exactly one constructor and one _contentHash")
        return errors
    errors += hash_body_errors(ast, hashes[0])
    ctor = ctors[0]
    params = [p["name"] for p in ctor["parameters"]["parameters"]]
    mods = ctor["modifiers"]
    forwarded = (
        len(mods) == 1
        and mods[0]["modifierName"]["name"] == PORTAL
        and [(a["nodeType"], a.get("name")) for a in mods[0].get("arguments") or []]
        == [("Identifier", p) for p in params]
    )
    if not forwarded or ctor["body"]["statements"]:
        errors.append(f"the harness constructor must pass ({', '.join(params)}) to {PORTAL} unchanged and do nothing else")
    return errors


def main():
    portal, harness = artifact(PORTAL), artifact(HARNESS)
    errors = []
    if portal["methodIdentifiers"] != harness["methodIdentifiers"]:
        errors.append("the harness's external selectors differ from the portal's")
    if layout(portal) != layout(harness):
        errors.append("the harness's storage layout differs from the portal's")
    errors += harness_shape_errors(harness["ast"])
    for e in errors:
        print(f"::error::{e}")
    if not errors:
        print(f"{HARNESS} matches {PORTAL} but for _contentHash")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
