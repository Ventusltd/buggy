"""Python mirror of the dynamics cartridge: agrees with the JS reference and keeps the same physics checks.
Runs on BUGGY_ENGINE (numpy by default, as in CI)."""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))
from cartridges.dynamics.engine import (DT, G, METHODS, PRESET_NAMES, Geometry, derivative,  # noqa: E402
                                        select_engine, spawn, steer_angles)
from cartridges.dynamics.scripted import scripted  # noqa: E402

xp, ENGINE = select_engine()
GOLDEN = json.loads((ROOT / "tests" / "data" / "dynamics-golden.json").read_text(encoding="utf-8"))
flat = lambda xp_, x, y: 0 * x  # noqa: E731


def host(a):
    return a.get() if hasattr(a, "get") else np.asarray(a)


def plane(xp_, x, y):
    P = GOLDEN["plane"]
    return P["g0"] + P["gx"] * x + P["gy"] * y


def test_matches_js_golden_every_preset_both_integrators():
    """All eight golden runs in one batch per integrator: rows are independent vehicles."""
    sp = GOLDEN["spawn"]
    for method in ("euler", "rk4"):
        runs = [r for r in GOLDEN["runs"] if r["method"] == method]
        geo = Geometry(xp, [r["preset"] for r in runs])
        y = spawn(geo, plane, sp["x"], sp["y"], sp["yaw"])
        got = [host(y).copy()]
        n = round(GOLDEN["seconds"] / DT)
        for i in range(n):
            METHODS[method](y, scripted(i * DT), geo, plane)
            if (i + 1) % GOLDEN["sampleEvery"] == 0:
                got.append(host(y).copy())
        for row, r in enumerate(runs):
            want = np.array(r["samples"])
            have = np.array([g[row] for g in got])
            err = np.abs(have - want) / np.maximum(1.0, np.abs(want))
            assert err.max() < 1e-9, f"{ENGINE} {r['preset']} {method}: {err.max():.3e}"


def test_rest_loads_and_height():
    geo = Geometry(xp, PRESET_NAMES)
    for method, step in METHODS.items():
        y = spawn(geo, flat)
        for _ in range(3000):
            step(y, {}, geo, flat)
        _, (N, *_rest) = derivative(y, {}, geo, flat, diag=True)
        N, load = host(N), host(geo.static_load)
        m = host(geo.p["mass"])
        assert np.allclose(host(y[:, 2]), host(geo.p["cgHeight"]), atol=1e-3), method
        assert np.allclose(N.sum(1), m * G, rtol=1e-3), method
        assert np.allclose(N, load, rtol=5e-3), method


def test_ackermann_axes_meet_and_friction_circle_holds():
    geo = Geometry(xp, PRESET_NAMES)
    for steer in (1.0, -0.6):
        d = host(steer_angles(geo, steer))
        R = 1 / (steer * host(geo.max_curvature))
        ex = host(geo.steer_centre)[:, None] - host(geo.s)
        ey = R[:, None] - host(geo.l)
        cross = (np.sin(d) * ey + np.cos(d) * ex) / np.hypot(ex, ey)
        assert np.abs(cross).max() < 1e-12
    y = spawn(geo, flat)
    for i in range(4000):
        METHODS["rk4"](y, dict(throttle=1 if i < 3000 else 0, brake=0 if i < 3000 else 1, steer=0.7), geo, flat)
    _, (N, fl, fs, lim) = derivative(y, dict(brake=1, steer=0.7), geo, flat, diag=True)
    assert np.all(host(xp.hypot(fl, fs)) <= host(lim) * (1 + 1e-12) + 1e-9)


def test_engine_choice_is_explicit():
    import pytest

    with pytest.raises(ValueError):
        select_engine("fastest")
    assert select_engine("numpy")[1] == "numpy"
