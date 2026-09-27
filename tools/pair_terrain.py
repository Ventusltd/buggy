"""Pair check for the terrain cartridge.

Electron: the engine chosen by BUGGY_ENGINE (weights-form bilinear, closed-form sinkage, vectorised solids).
Positron: NumPy on the CPU with the other method (lerp-of-lerps bilinear, numeric force-balance sinkage).
Photons: seeded query points over a 2 x 2 tile block with no-data holes, including exact tile edges and corners.
CPU witness: the web module itself (src/web/terrain/terrain.mjs) under Node, the code the world imports.

Writes an LF-only JSON receipt with SHA-256 of the fixture and of each side's answers, and the engine record.
Agreement between these sides shows the implementations are consistent with one another; it does not show the
illustrative friction or soil values are true of any ground.

Usage (from the repo root): python tools/pair_terrain.py [--photons 20000] [--seed 20260927] [--out receipts]
"""
import argparse
import datetime
import hashlib
import json
import math
import os
import subprocess
import sys
import tempfile

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))
from cartridges.terrain import engine, terrain as T  # noqa: E402

TOL = {"height_m": 1e-9, "normal": 1e-9, "sinkage_rel": 1e-5, "sphere_depth_m": 1e-9}


def sha(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def fixture(n_photons, seed):
    rng = np.random.default_rng(seed)
    samples, spacing = 65, 0.5
    size = (samples - 1) * spacing
    f = lambda e, n: 50 + 2.5 * np.sin(e / 7.0) * np.cos(n / 5.0) + 0.03 * e
    tiles = []
    for e0 in (0, size):
        for n0 in (0, size):
            j, i = np.mgrid[0:samples, 0:samples]
            z = f(e0 + i * spacing, n0 + j * spacing)
            q = np.round(z * 100 - 4000).astype(np.int64)
            holes = rng.random(q.shape) < 0.002
            q[holes] = T.NODATA
            tiles.append({"samples": samples, "spacing": spacing, "e0": e0, "n0": n0, "baseCm": 4000,
                          "q": q.ravel().astype(int).tolist()})
    span = 2 * size
    pts = rng.uniform(-1, span + 1, size=(n_photons, 2))
    k = n_photons // 10                                        # a tenth on tile edges, corners and node lines
    pts[:k, 0] = size
    pts[k:2 * k, 1] = size
    pts[2 * k:2 * k + 8] = [[0, 0], [size, size], [span, span], [0, span], [span, 0], [size, 0], [0, size], [span, size]]
    pts[2 * k + 8:3 * k, 0] = np.round(pts[2 * k + 8:3 * k, 0] / spacing) * spacing
    layers = {
        "ways": [{"class": "minor", "pts": [[2, 3], [60, 40]]}, {"class": "track", "pts": [[5, 55], [58, 50], [60, 10]]}],
        "water": [{"pts": [[30, -2], [33, 30], [28, 66]]}, {"rings": [[[45, 45], [55, 45], [55, 52], [45, 52]]]}],
        "areas": [{"surface": "soft", "rings": [[[5, 20], [20, 20], [20, 35], [5, 35]], [[9, 24], [14, 24], [14, 29], [9, 29]]]}],
        "grids": [{"surface": "wet", "x0": 36, "y0": 0, "spacing": 2, "cols": 12, "rows": 12,
                   "values": rng.integers(0, 12, 144).tolist(), "min": 8}],
    }
    solids = [{"min": [float(x), float(y), 49.0], "max": [float(x + w), float(y + d), 52.0]}
              for x, y, w, d in rng.uniform([0, 0, 0.2, 0.2], [60, 60, 6, 3], size=(40, 4))]
    spheres = [{"c": c.tolist(), "r": float(r)} for c, r in zip(rng.uniform([0, 0, 48], [64, 64, 53], size=(n_photons // 10, 3)),
                                                                  rng.uniform(0.2, 1.2, n_photons // 10))]
    return {"tiles": tiles, "layers": layers, "solids": solids, "photons": pts.tolist(), "spheres": spheres,
            "soils": ["grass", "wet", "soft", "water"], "loads": np.linspace(0, 6000, 61).tolist(),
            "wheel": {"width": 0.22, "diameter": 0.58}, "seed": seed}


def side(xp, fx, method, sink):
    tiles = [{**t, "q": np.asarray(t["q"], dtype=np.uint16)} for t in fx["tiles"]]
    pts = np.asarray(fx["photons"])
    x, y = xp.asarray(pts[:, 0]), xp.asarray(pts[:, 1])
    hf = T.height_field(xp, tiles, method=method)
    h = engine.to_numpy(hf(x, y))
    nrm, _, known = T.normals(xp, hf, x, y, 1.0)
    rank = engine.to_numpy(T.surfaces(xp, fx["layers"], x, y))
    sinks = {s: engine.to_numpy(sink(xp, np.asarray(fx["loads"]), fx["wheel"]["width"], fx["wheel"]["diameter"],
                                     T.SURFACES[s]["soil"])).tolist() for s in fx["soils"]}
    c = np.asarray([s["c"] for s in fx["spheres"]]); r = np.asarray([s["r"] for s in fx["spheres"]])
    d, n, sid = (engine.to_numpy(a) for a in T.sphere_boxes(xp, c, r, [s["min"] for s in fx["solids"]], [s["max"] for s in fx["solids"]]))
    return {"heights": [None if math.isnan(v) else float(v) for v in h], "normals": engine.to_numpy(nrm).tolist(),
            "known": engine.to_numpy(known).tolist(), "surfaces": [T.PRIORITY[i] for i in rank], "sinkage": sinks,
            "spheres": [{"depth": float(a), "normal": b.tolist(), "solid": int(s)} for a, b, s in zip(d, n, sid)]}


def compare(a, b):
    ha, hb = np.array(a["heights"], dtype=float), np.array(b["heights"], dtype=float)
    nan_same = bool((np.isnan(ha) == np.isnan(hb)).all())
    ok = ~np.isnan(ha) & ~np.isnan(hb)
    dh = float(np.abs(ha[ok] - hb[ok]).max()) if ok.any() else 0.0
    dn = float(np.abs(np.array(a["normals"]) - np.array(b["normals"])).max())
    known_same = a["known"] == b["known"]
    surf_diff = sum(p != q for p, q in zip(a["surfaces"], b["surfaces"]))
    ds = max(float(np.max(np.abs(np.array(a["sinkage"][k]) - np.array(b["sinkage"][k])) /
                       np.maximum(np.abs(np.array(b["sinkage"][k])), 1e-12))) for k in a["sinkage"])
    dd = max(abs(p["depth"] - q["depth"]) for p, q in zip(a["spheres"], b["spheres"]))
    solid_diff = sum(p["solid"] != q["solid"] for p, q in zip(a["spheres"], b["spheres"]))
    snorm = max(max(abs(u - v) for u, v in zip(p["normal"], q["normal"])) for p, q in zip(a["spheres"], b["spheres"]))
    res = {"height_max_abs_m": dh, "nodata_pattern_same": nan_same, "normal_max_abs": dn, "known_same": known_same,
           "surface_mismatches": surf_diff, "sinkage_max_rel": ds, "sphere_depth_max_abs_m": dd,
           "sphere_normal_max_abs": snorm, "sphere_solid_mismatches": solid_diff}
    res["pass"] = bool(nan_same and known_same and surf_diff == 0 and solid_diff == 0 and dh <= TOL["height_m"] and
                       dn <= TOL["normal"] and ds <= TOL["sinkage_rel"] and dd <= TOL["sphere_depth_m"] and snorm <= TOL["normal"])
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--photons", type=int, default=20000)
    ap.add_argument("--seed", type=int, default=20260927)
    ap.add_argument("--out", default=os.path.join(ROOT, "receipts"))
    args = ap.parse_args()
    xp, info = engine.select()
    fx = fixture(args.photons, args.seed)
    electron = side(xp, fx, "weights", T.sinkage_closed)
    positron = side(np, fx, "lerp", T.sinkage_numeric)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fh:
        json.dump(fx, fh)
        path = fh.name
    try:
        run = subprocess.run(["node", os.path.join(ROOT, "tools", "js_witness.mjs"), path], capture_output=True, text=True, check=True)
    finally:
        os.unlink(path)
    witness = json.loads(run.stdout)
    constants_same = json.loads(json.dumps(witness.pop("constants"))) == {"SURFACES": T.SURFACES, "PRIORITY": T.PRIORITY}
    receipt = {
        "cartridge": "buggy-terrain", "check": "pair", "engine": info, "seed": args.seed,
        "photons": len(fx["photons"]), "spheres": len(fx["spheres"]), "loads": len(fx["loads"]), "tolerances": TOL,
        "sha256": {"fixture": sha(fx), "electron": sha(electron), "positron": sha(positron), "witness": sha(witness)},
        "electron_vs_positron": compare(electron, positron),
        "electron_vs_witness": compare(electron, witness),
        "constants_same_as_web": constants_same,
        "coverage": {"no_ground": sum(h is None for h in electron["heights"]),
                     "surfaces": {k: electron["surfaces"].count(k) for k in T.PRIORITY},
                     "sphere_hits": sum(s["solid"] >= 0 for s in electron["spheres"])},
        "note": "consistency between implementations, not a measurement of any ground; surface and soil values are illustrative",
        "run_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    receipt["pass"] = bool(receipt["electron_vs_positron"]["pass"] and receipt["electron_vs_witness"]["pass"] and constants_same)
    os.makedirs(args.out, exist_ok=True)
    out = os.path.join(args.out, f"terrain-pair-{info['engine']}.json")
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"pass": receipt["pass"], "engine": info["engine"], "receipt": os.path.relpath(out, ROOT)}))
    return 0 if receipt["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
