"""Vehicle dynamics cartridge, Python mirror of src/web/engine/vehicle-dynamics.mjs.

Vectorised over a batch: the state is an (n, 16) array, one row per vehicle, and every row may carry its
own preset. The array engine is chosen explicitly:

    BUGGY_ENGINE=numpy   (default; what CI runs)
    BUGGY_ENGINE=cupy    (GPU; fails loudly if CuPy or a device is missing)
    BUGGY_ENGINE=auto    (CuPy if it works, else NumPy; the choice is reported)

The model, the constants and the order of operations follow the JS module; tests/data/dynamics-golden.json
(written by the JS module) is the reference both must reproduce. See docs/dynamics.md for the assumptions.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np

DT = 0.001
G = 9.81
RHO_AIR = 1.225
SPIN_REF = 0.5
GRAD_H = 0.05
N_STATE = 16
PRESETS = json.loads((Path(__file__).with_name("presets.json")).read_text(encoding="utf-8"))
PRESET_NAMES = list(PRESETS)
NUMERIC = [k for k, v in PRESETS["site-buggy"].items() if isinstance(v, (int, float))]


def select_engine(name: str | None = None):
    """Return (xp, label). label is 'numpy' or 'cupy'; it goes into every receipt."""
    want = (name or os.environ.get("BUGGY_ENGINE") or "numpy").strip().lower()
    if want not in ("numpy", "cupy", "auto"):
        raise ValueError(f"BUGGY_ENGINE must be numpy, cupy or auto, not {want!r}")
    if want == "numpy":
        return np, "numpy"
    try:
        import cupy as cp  # noqa: PLC0415

        cp.zeros(1).sum().item()  # touches the device
        return cp, "cupy"
    except Exception:
        if want == "cupy":
            raise
        return np, "numpy"


class Geometry:
    """Per-row parameters and derived geometry, as arrays on the chosen engine."""

    def __init__(self, xp, presets):
        names = [presets] if isinstance(presets, str) else list(presets)
        rows = [PRESETS[n] for n in names]
        self.xp, self.names, self.n = xp, names, len(names)
        col = lambda k: xp.asarray(np.array([float(r[k]) for r in rows]))  # noqa: E731
        self.p = {k: col(k) for k in NUMERIC}
        L, f, t = (np.array([r[k] for r in rows], float) for k in ("wheelbase", "frontLoadFraction", "track"))
        b = L * f
        a = L - b
        ht = t / 2
        s = np.stack([a, a, -b, -b], 1)
        l = np.stack([-ht, ht, -ht, ht], 1)
        driven = np.array([[1, 1, 1, 1] if r["drive"] == "all" else [1, 1, 0, 0] if r["drive"] == "front"
                           else [0, 0, 1, 1] for r in rows], float)
        m = np.array([r["mass"] for r in rows], float)
        wF = m * G * f / 2
        wR = m * G * (1 - f) / 2
        load = np.stack([wF, wF, wR, wR], 1)
        k = np.array([r["springRate"] for r in rows], float)
        cg = np.array([r["cgHeight"] for r in rows], float)
        free = cg[:, None] + load / k[:, None]
        xc = np.where(np.array([r["steerCentre"] == "mid" for r in rows]), (a - b) / 2, -b)
        ro = np.array([r["turningCircle"] for r in rows], float) / 2
        reach = a - xc
        if np.any(ro <= reach + ht):
            raise ValueError("turning circle smaller than the chassis allows")
        rc = np.sqrt(ro * ro - reach * reach) - ht
        self.s, self.l, self.driven = xp.asarray(s), xp.asarray(l), xp.asarray(driven)
        self.n_driven = xp.asarray(driven.sum(1))
        self.static_load, self.free = xp.asarray(load), xp.asarray(free)
        self.steer_centre, self.max_curvature = xp.asarray(xc), xp.asarray(1 / rc)


def _col(xp, v, n):
    return xp.broadcast_to(xp.asarray(v, dtype=float), (n,))


def steer_angles(geo, steer):
    xp = geo.xp
    k = xp.clip(_col(xp, steer, geo.n), -1, 1) * geo.max_curvature
    return xp.arctan((geo.s - geo.steer_centre[:, None]) * k[:, None] / (1 - geo.l * k[:, None]))


def derivative(y, inp, geo, ground, diag=False):
    """dy/dt for every row. inp: dict of scalars or (n,) arrays: throttle, brake, steer, gear.
    ground(xp, x, y) -> height, vectorised. With diag=True also returns per-wheel (N, Fx, Fy, limit)."""
    xp, p, n = geo.xp, geo.p, geo.n
    m, R = p["mass"], p["wheelRadius"]
    x, yy, z, roll, pitch, yaw = (y[:, j] for j in range(6))
    vx, vy, vz, roll_rate, pitch_rate, yaw_rate = (y[:, j] for j in range(6, 12))
    w = y[:, 12:16]
    throttle = xp.clip(_col(xp, inp.get("throttle", 0), n), 0, 1)
    brake = xp.clip(_col(xp, inp.get("brake", 0), n), 0, 1)
    gear = xp.where(_col(xp, inp.get("gear", 1), n) == -1, -1.0, 1.0)
    delta = steer_angles(geo, inp.get("steer", 0))

    sy, cy = xp.sin(yaw), xp.cos(yaw)
    ux, uy, rx, ry = sy, cy, cy, -sy
    sp, cp, sr, cr = xp.sin(pitch), xp.cos(pitch), xp.sin(roll), xp.cos(roll)

    w_mean = (w * geo.driven).sum(1) / geo.n_driven
    v_top = xp.where(gear > 0, p["topSpeed"], p["reverseTopSpeed"])
    fall = xp.maximum(0, 1 - xp.maximum(0, gear * w_mean * R) / v_top)
    t_wheel = gear * throttle * p["driveTorque"] * fall / geo.n_driven

    c = lambda v: v[:, None]  # noqa: E731  (n,) -> (n, 1) against the four wheels
    s, l = geo.s, geo.l
    dx = s * c(ux) + l * c(rx)
    dyo = s * c(uy) + l * c(ry)
    px, py = c(x) + dx, c(yy) + dyo
    g = ground(xp, px, py)
    gx = (ground(xp, px + GRAD_H, py) - ground(xp, px - GRAD_H, py)) / (2 * GRAD_H)
    gy = (ground(xp, px, py + GRAD_H) - ground(xp, px, py - GRAD_H)) / (2 * GRAD_H)

    attach_z = c(z) + s * c(sp) - l * c(sr)
    comp = geo.free - (attach_z - g)
    vcx = c(vx) + c(yaw_rate) * dyo
    vcy = c(vy) - c(yaw_rate) * dx
    gdot = gx * vcx + gy * vcy
    comp_rate = -((c(vz) + s * c(cp) * c(pitch_rate) - l * c(cr) * c(roll_rate)) - gdot)
    k, travel = c(p["springRate"]), c(p["travel"])
    N = k * comp + c(p["damperRate"]) * comp_rate
    N = N + xp.where(comp > travel, 10 * k * (comp - travel), 0.0)
    N = xp.where(comp > 0, xp.maximum(N, 0.0), 0.0)

    nn = 1 / xp.sqrt(1 + gx * gx + gy * gy)
    nX, nY, nZ = -gx * nn, -gy * nn, nn
    h = c(yaw) + delta
    sh, ch = xp.sin(h), xp.cos(h)
    t1x, t1y, t1z = sh, ch, gx * sh + gy * ch
    n1 = 1 / xp.sqrt(t1x * t1x + t1y * t1y + t1z * t1z)
    t1x, t1y, t1z = t1x * n1, t1y * n1, t1z * n1
    t2x, t2y, t2z = ch, -sh, gx * ch - gy * sh
    n2 = 1 / xp.sqrt(t2x * t2x + t2y * t2y + t2z * t2z)
    t2x, t2y, t2z = t2x * n2, t2y * n2, t2z * n2

    v_long = vcx * t1x + vcy * t1y + gdot * t1z
    v_lat = vcx * t2x + vcy * t2y + gdot * t2z
    v_ref = xp.maximum(xp.abs(v_long), c(p["slipRefSpeed"]))
    kappa = (w * c(R) - v_long) / v_ref
    alpha = xp.arctan(v_lat / v_ref)
    lim = c(p["mu"]) * N
    fl = lim * xp.sin(c(p["tyreC"]) * xp.arctan(c(p["tyreB"]) * kappa))
    fs = -lim * xp.sin(c(p["tyreC"]) * xp.arctan(c(p["tyreB"]) * alpha))
    fm = xp.hypot(fl, fs)
    over = (fm > lim) & (fm > 0)
    scale = xp.where(over, lim / xp.where(over, fm, 1.0), 1.0)
    fl, fs = fl * scale, fs * scale

    tw = xp.tanh(w / SPIN_REF)
    torque = geo.driven * c(t_wheel) - c(brake * p["brakeTorque"]) * tw - c(p["rollingResistance"]) * N * c(R) * tw
    dw = (torque - fl * c(R)) / c(p["wheelInertia"])

    cx = N * nX + fl * t1x + fs * t2x
    cyF = N * nY + fl * t1y + fs * t2y
    cz = N * nZ + fl * t1z + fs * t2z
    f_fwd = cx * c(ux) + cyF * c(uy)
    f_right = cx * c(rx) + cyF * c(ry)
    hc = c(p["cgHeight"])
    Fx, Fy, Fz = _sum4(cx), _sum4(cyF), _sum4(cz)
    Mpitch = _sum4(cz * s + hc * f_fwd)
    Mroll = _sum4(-cz * l - hc * f_right)
    Myaw = _sum4(dyo * cx - dx * cyF)

    vh = xp.hypot(vx, vy)
    drag = 0.5 * RHO_AIR * p["dragArea"] * vh
    dy = xp.empty_like(y)
    dy[:, 0:6] = y[:, 6:12]
    dy[:, 6] = (Fx - drag * vx) / m
    dy[:, 7] = (Fy - drag * vy) / m
    dy[:, 8] = Fz / m - G
    dy[:, 9] = Mroll / p["Ixx"]
    dy[:, 10] = Mpitch / p["Iyy"]
    dy[:, 11] = Myaw / p["Izz"]
    dy[:, 12:16] = dw
    if diag:
        return dy, (N, fl, fs, lim)
    return dy


def _sum4(a):
    # left to right, as the JS loop accumulates
    return ((a[:, 0] + a[:, 1]) + a[:, 2]) + a[:, 3]


def step_euler(y, inp, geo, ground, dt=DT):
    """Semi-implicit Euler: velocities from the forces now, then positions with the new velocities."""
    k1 = derivative(y, inp, geo, ground)
    y[:, 6:] += k1[:, 6:] * dt
    y[:, :6] += y[:, 6:12] * dt
    return y


def step_rk4(y, inp, geo, ground, dt=DT):
    k1 = derivative(y, inp, geo, ground)
    k2 = derivative(y + 0.5 * dt * k1, inp, geo, ground)
    k3 = derivative(y + 0.5 * dt * k2, inp, geo, ground)
    k4 = derivative(y + dt * k3, inp, geo, ground)
    y += dt / 6 * (k1 + 2 * k2 + 2 * k3 + k4)
    return y


METHODS = {"euler": step_euler, "rk4": step_rk4}


def spawn(geo, ground, x=0.0, y=0.0, yaw=0.0):
    xp = geo.xp
    st = xp.zeros((geo.n, N_STATE))
    xs, ys = _col(xp, x, geo.n), _col(xp, y, geo.n)
    st[:, 0], st[:, 1], st[:, 5] = xs, ys, _col(xp, yaw, geo.n)
    st[:, 2] = ground(xp, xs, ys) + geo.p["cgHeight"]
    return st
