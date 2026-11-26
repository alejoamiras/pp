#!/usr/bin/env python3
"""The symbolic proofs drive ProcessorPortalHarness, so it may differ from ProcessorPortalImpl only in
`_contentHash`. Compares the two contracts' selectors and storage (as slot, offset, type: the raw
layout names its contract and always differs), then reads the harness's AST: it must inherit the
portal directly and declare only a constructor that passes its parameters on unchanged and the
`_contentHash` override. Reads build artifacts only, so run it after
`forge build --ast --extra-output storageLayout` in contracts/bridge/evm.
"""

import json
import sys

PORTAL, HARNESS = "ProcessorPortalImpl", "ProcessorPortalHarness"
ARTIFACTS = {
    PORTAL: "out/ProcessorPortalImpl.sol/ProcessorPortalImpl.json",
    HARNESS: "out/ProcessorPortalHarness.sol/ProcessorPortalHarness.json",
}


def artifact(name):
    with open(ARTIFACTS[name]) as f:
        return json.load(f)


def layout(a):
    return [(s["slot"], s["offset"], s["type"]) for s in a["storageLayout"]["storage"]]


def describe(node):
    return f"{node['nodeType']} {node.get('kind') or ''} {node.get('name') or ''}".strip()


def harness_shape_errors(ast):
    [contract] = [n for n in ast["nodes"] if n.get("nodeType") == "ContractDefinition" and n["name"] == HARNESS]
    errors = []
    bases = [b["baseName"]["name"] for b in contract["baseContracts"]]
    if bases != [PORTAL]:
        errors.append(f"the harness inherits {bases}, not exactly [{PORTAL}]")
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
