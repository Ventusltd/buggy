"""Validate catalogue.json against the cartridge-and-plug schema, and federation.json against the federation
manifest v1 required fields. Standard library only, so it runs on any CI runner.

Usage: python tools/validate_catalogue.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

CATALOGUE_KEYS = {"app", "type", "area", "version", "purpose", "execution"}
EXECUTION_KEYS = {"gpu_engine", "cpu_engine", "ci_cd_compatible"}
TYPES = {"cartridge", "plug", "engine"}
AREAS = {"visualisation", "reconciliation", "computational"}
GPU = {"cupy", "none"}
CPU = {"numpy", "javascript"}
ROLES = {"homepage", "data", "ui", "app", "source_archive", "docs", "research", "unknown"}
STATUS = {"active", "staging", "retiring", "archived", "frozen", "unknown"}


def check_catalogue(entries: object) -> list[str]:
    errs: list[str] = []
    if not isinstance(entries, list) or not entries:
        return ["catalogue.json must be a non-empty array"]
    seen = set()
    for i, e in enumerate(entries):
        where = f"catalogue[{i}]"
        if not isinstance(e, dict):
            errs.append(f"{where}: not an object")
            continue
        if set(e) != CATALOGUE_KEYS:
            errs.append(f"{where}: keys {sorted(e)} are not exactly {sorted(CATALOGUE_KEYS)}")
            continue
        where = f"catalogue[{e['app']}]"
        if not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", str(e["app"])):
            errs.append(f"{where}: app must be kebab-case")
        if e["app"] in seen:
            errs.append(f"{where}: duplicate app")
        seen.add(e["app"])
        if e["type"] not in TYPES:
            errs.append(f"{where}: type {e['type']!r} not in {sorted(TYPES)}")
        if e["area"] not in AREAS:
            errs.append(f"{where}: area {e['area']!r} not in {sorted(AREAS)}")
        if not re.fullmatch(r"\d{8}\.\d{2}", str(e["version"])):
            errs.append(f"{where}: version must be YYYYMMDD.VV")
        if not isinstance(e["purpose"], str) or len(e["purpose"]) < 20:
            errs.append(f"{where}: purpose must be a sentence")
        x = e["execution"]
        if not isinstance(x, dict) or set(x) != EXECUTION_KEYS:
            errs.append(f"{where}: execution keys must be exactly {sorted(EXECUTION_KEYS)}")
            continue
        if x["gpu_engine"] not in GPU or x["cpu_engine"] not in CPU or x["ci_cd_compatible"] is not True:
            errs.append(f"{where}: execution values {x} not allowed")
        if x["gpu_engine"] == "cupy" and x["cpu_engine"] != "numpy":
            errs.append(f"{where}: a cupy engine needs its numpy fallback")
    return errs


def check_federation(m: object) -> list[str]:
    if not isinstance(m, dict):
        return ["federation.json must be an object"]
    errs = [f"federation.json: missing {k}" for k in ("schemaVersion", "repo", "role", "owner", "purpose", "status") if k not in m]
    if m.get("schemaVersion") != "globalgrid2050.federation_manifest.v1":
        errs.append("federation.json: schemaVersion must be globalgrid2050.federation_manifest.v1")
    if not re.fullmatch(r"Ventusltd/[A-Za-z0-9_.-]+", str(m.get("repo", ""))):
        errs.append("federation.json: repo must be Ventusltd/<name>")
    if m.get("role") not in ROLES:
        errs.append("federation.json: role not allowed")
    if m.get("status") not in STATUS:
        errs.append("federation.json: status not allowed")
    for d in m.get("dependencies", []):
        if not {"repo", "type", "purpose"} <= set(d):
            errs.append(f"federation.json: dependency {d} lacks repo, type or purpose")
    for w in m.get("workflows", []):
        if not {"file", "purpose"} <= set(w):
            errs.append(f"federation.json: workflow {w} lacks file or purpose")
        elif not (ROOT / w["file"]).is_file():
            errs.append(f"federation.json: workflow file {w['file']} does not exist")
    return errs


def main() -> int:
    errs = check_catalogue(json.loads((ROOT / "catalogue.json").read_text(encoding="utf-8")))
    errs += check_federation(json.loads((ROOT / "federation.json").read_text(encoding="utf-8")))
    for e in errs:
        print("FAIL", e)
    if not errs:
        print("catalogue.json and federation.json: valid")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
