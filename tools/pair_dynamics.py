"""Pair run for the dynamics cartridge.

  electron  semi-implicit Euler over a batch of vehicles on the chosen engine
  positron  RK4 over the same batch, same inputs, same ground
  photons   invariant checks on both: finite state, friction circle per wheel, electron-positron gap
  witness   a NumPy re-run of a sample of rows (the CPU witness), and the NumPy mirror against the JS golden file

Writes an LF text receipt whose last line is the sha256 of every line above it.
Usage:  BUGGY_ENGINE=cupy python tools/pair_dynamics.py [--rows 4096] [--seconds 6] [--out receipts/x.txt]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from cartridges.dynamics.engine import (DT, METHODS, PRESET_NAMES, Geometry, derivative,  # noqa: E402
                                        select_engine, spawn)
from cartridges.dynamics.scripted import scripted  # noqa: E402


def bumpy(xp, x, y):
    """Tilted plane with gentle bumps: about 5 cm, wavelengths 7 to 9 m."""
    return 0.02 * x - 0.015 * y + 0.05 * xp.sin(0.7 * x) * xp.cos(0.9 * y)


def schedule(t, gain_t, gain_s):
    """Scripted inputs scaled per row, so every row drives a different manoeuvre."""
    if t < 1:
        return dict(throttle=0.0, brake=0.0, steer=0.0)
    if t < 3:
        return dict(throttle=0.9 * gain_t, brake=0.0, steer=0.1 * gain_s)
    if t < 4:
        return dict(throttle=0.4 * gain_t, brake=0.0, steer=0.7 * gain_s)
    if t < 5:
        return dict(throttle=0.0, brake=0.8, steer=0.2 * gain_s)
    return dict(throttle=0.6 * gain_t, brake=0.0, steer=-0.9 * gain_s)


def host(a):
    return a.get() if hasattr(a, "get") else np.asarray(a)


def drive(xp, names, xs, ys, yaws, gt, gs, seconds, method, sync=lambda: None):
    geo = Geometry(xp, names)
    y = spawn(geo, bumpy, xp.asarray(xs), xp.asarray(ys), xp.asarray(yaws))
    gt, gs = xp.asarray(gt), xp.asarray(gs)
    worst_ratio, finite = 0.0, True
    n = round(seconds / DT)
    t0 = time.perf_counter()
    for i in range(n):
        inp = schedule(i * DT, gt, gs)
        METHODS[method](y, inp, geo, bumpy)
        if (i + 1) % 250 == 0:  # photons: friction circle and finiteness, sampled
            _, (N, fl, fs, lim) = derivative(y, inp, geo, bumpy, diag=True)
            over = xp.hypot(fl, fs) - lim * (1 + 1e-12)
            worst_ratio = max(worst_ratio, float(host(over.max())))
            finite = finite and bool(host(xp.isfinite(y).all()))
    sync()
    return host(y), time.perf_counter() - t0, worst_ratio, finite


def golden_witness():
    """NumPy mirror against the JS golden file: worst relative difference over every sample."""
    g = json.loads((ROOT / "tests" / "data" / "dynamics-golden.json").read_text(encoding="utf-8"))
    P, sp = g["plane"], g["spawn"]
    plane = lambda xp_, x, y: P["g0"] + P["gx"] * x + P["gy"] * y  # noqa: E731
    worst = 0.0
    for method in ("euler", "rk4"):
        runs = [r for r in g["runs"] if r["method"] == method]
        geo = Geometry(np, [r["preset"] for r in runs])
        y = spawn(geo, plane, sp["x"], sp["y"], sp["yaw"])
        k = 0
        for i in range(round(g["seconds"] / DT)):
            METHODS[method](y, scripted(i * DT), geo, plane)
            if (i + 1) % g["sampleEvery"] == 0:
                k += 1
                want = np.array([r["samples"][k] for r in runs])
                worst = max(worst, float((np.abs(y - want) / np.maximum(1, np.abs(want))).max()))
    return worst


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int, default=4096)
    ap.add_argument("--seconds", type=float, default=6.0)
    ap.add_argument("--witness-rows", type=int, default=64)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    xp, engine = select_engine()
    sync = (lambda: xp.cuda.Stream.null.synchronize()) if engine == "cupy" else (lambda: None)
    rng = np.random.default_rng(20260927)
    names = [PRESET_NAMES[i % len(PRESET_NAMES)] for i in range(a.rows)]
    xs, ys = rng.uniform(-200, 200, a.rows), rng.uniform(-200, 200, a.rows)
    yaws = rng.uniform(0, 2 * np.pi, a.rows)
    gt, gs = rng.uniform(0.3, 1.0, a.rows), rng.uniform(-1.0, 1.0, a.rows)

    e, te, fe, ok_e = drive(xp, names, xs, ys, yaws, gt, gs, a.seconds, "euler", sync)
    p, tp, fp, ok_p = drive(xp, names, xs, ys, yaws, gt, gs, a.seconds, "rk4", sync)
    gap_pos = np.hypot(e[:, 0] - p[:, 0], e[:, 1] - p[:, 1])
    gap_yaw = np.abs(e[:, 5] - p[:, 5])
    per_preset = {n: float(gap_pos[[i for i, m in enumerate(names) if m == n]].max()) for n in PRESET_NAMES}

    w = min(a.witness_rows, a.rows)
    idx = np.linspace(0, a.rows - 1, w).astype(int)
    wit = []
    for method, ref in (("euler", e), ("rk4", p)):
        c, _, _, _ = drive(np, [names[i] for i in idx], xs[idx], ys[idx], yaws[idx], gt[idx], gs[idx], a.seconds, method)
        wit.append(float((np.abs(c - ref[idx]) / np.maximum(1, np.abs(ref[idx]))).max()))
    gold = golden_witness()

    verdict = (ok_e and ok_p and fe <= 1e-9 and fp <= 1e-9 and gap_pos.max() < 0.25 and max(wit) < 1e-6
               and gold < 1e-9)
    lines = [
        "receipt: buggy dynamics pair run",
        f"utc: {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}",
        f"engine: {engine}",
        f"python: {platform.python_version()}  numpy: {np.__version__}"
        + (f"  cupy: {xp.__version__}" if engine == "cupy" else ""),
        f"rows: {a.rows}  presets: {','.join(PRESET_NAMES)}  seconds: {a.seconds}  dt: {DT}  steps: {round(a.seconds / DT)}",
        "ground: tilted plane 2 % / -1.5 % with 5 cm bumps",
        f"electron (semi-implicit Euler): {te:.2f} s wall, finite {ok_e}, worst friction-circle excess {fe:.3e} N",
        f"positron (RK4): {tp:.2f} s wall, finite {ok_p}, worst friction-circle excess {fp:.3e} N",
        f"pair gap position: max {gap_pos.max():.4f} m, mean {gap_pos.mean():.5f} m; yaw max {np.degrees(gap_yaw.max()):.4f} deg",
        "pair gap by preset (max m): " + ", ".join(f"{k} {v:.4f}" for k, v in per_preset.items()),
        f"cpu witness ({w} rows on numpy): euler {wit[0]:.3e}, rk4 {wit[1]:.3e} (max relative difference)",
        f"js golden witness (numpy mirror vs JS module, 8 runs): {gold:.3e} (max relative difference)",
        f"sha256 electron final state: {hashlib.sha256(np.ascontiguousarray(e).tobytes()).hexdigest()}",
        f"sha256 positron final state: {hashlib.sha256(np.ascontiguousarray(p).tobytes()).hexdigest()}",
        "thresholds: finite; friction excess <= 1e-9 N; pair gap < 0.25 m; witness < 1e-6; golden < 1e-9",
        f"verdict: {'PASS' if verdict else 'FAIL'}",
    ]
    body = "\n".join(lines) + "\n"
    text = body + f"sha256: {hashlib.sha256(body.encode('utf-8')).hexdigest()}\n"
    out = Path(a.out) if a.out else ROOT / "receipts" / f"pair-dynamics-{engine}.txt"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(text.encode("utf-8"))
    sys.stdout.write(text)
    return 0 if verdict else 1


if __name__ == "__main__":
    sys.exit(main())
