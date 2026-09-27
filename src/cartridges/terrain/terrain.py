"""Terrain cartridge, array side: the same model as src/web/terrain/terrain.mjs, vectorised over many contacts for batch
studies and for the pair check. Every function takes xp (numpy or cupy, from engine.select) so one code path
runs on either engine.

EVERY FRICTION, ROLLING-RESISTANCE AND SOIL VALUE IS TYPICAL OR ILLUSTRATIVE, NOT MEASURED. Sinkage is a simple
pressure-sinkage (Bekker-style) rigid-wheel model: illustrative, not a site assessment.
"""
import math

NODATA = 0xFFFF
ILLUSTRATIVE = "illustrative values, not measured at this site"
WATER_NOTE = "water crossing: depth not surveyed"

SURFACES = {
    "tarmac": {"mu": 0.85, "crr": 0.015, "soil": None},
    "gravel": {"mu": 0.60, "crr": 0.030, "soil": None},
    "grass": {"mu": 0.50, "crr": 0.050, "soil": {"n": 0.6, "kc": 30e3, "kphi": 2000e3}},
    "wet": {"mu": 0.35, "crr": 0.060, "soil": {"n": 0.5, "kc": 13e3, "kphi": 692e3}},
    "soft": {"mu": 0.25, "crr": 0.080, "soil": {"n": 0.5, "kc": 2e3, "kphi": 200e3}},
    "water": {"mu": 0.20, "crr": 0.150, "soil": {"n": 0.5, "kc": 2e3, "kphi": 200e3}},
}
PRIORITY = ["tarmac", "water", "gravel", "soft", "wet", "grass"]
DEFAULT_SURFACE = "grass"
WAY_SURFACE = {"motorway": "tarmac", "A": "tarmac", "B": "tarmac", "minor": "tarmac", "local": "tarmac", "track": "gravel"}
DEFAULT_WAY_WIDTH = {"motorway": 11, "A": 7.3, "B": 6.5, "minor": 5.5, "local": 4.8, "track": 3}
WATER_LINE_WIDTH_M = 2


# ---------------------------------------------------------------------------------------------- heights
def sample_tile(xp, tile, u, v, method="weights"):
    """Bilinear height at arrays (u, v) metres from the tile's south-west node; NaN outside or on missing data.
    method "weights" (electron) sums four weighted nodes; "lerp" (positron) interpolates along x then y."""
    q = xp.asarray(tile["q"]).reshape(tile["samples"], tile["samples"])
    s = tile["samples"] - 1
    u, v = xp.asarray(u, dtype=xp.float64), xp.asarray(v, dtype=xp.float64)
    gx, gy = u / tile["spacing"], v / tile["spacing"]
    inside = (gx >= 0) & (gy >= 0) & (gx <= s) & (gy <= s)
    i = xp.clip(xp.floor(xp.where(inside, gx, 0)), 0, s - 1).astype(xp.int64)
    j = xp.clip(xp.floor(xp.where(inside, gy, 0)), 0, s - 1).astype(xp.int64)
    fx, fy = xp.where(inside, gx - i, 0), xp.where(inside, gy - j, 0)
    q00, q10, q01, q11 = (q[j, i].astype(xp.float64), q[j, i + 1].astype(xp.float64),
                          q[j + 1, i].astype(xp.float64), q[j + 1, i + 1].astype(xp.float64))
    w00, w10, w01, w11 = (1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy
    bad = ((w00 != 0) & (q00 == NODATA)) | ((w10 != 0) & (q10 == NODATA)) | \
          ((w01 != 0) & (q01 == NODATA)) | ((w11 != 0) & (q11 == NODATA))
    z = lambda w, qq: xp.where(w != 0, w * qq, 0.0)
    if method == "weights":
        acc = z(w00, q00) + z(w10, q10) + z(w01, q01) + z(w11, q11)
    else:
        a = xp.where(fx == 0, q00, xp.where(fx == 1, q10, q00 + fx * (q10 - q00)))
        b = xp.where(fx == 0, q01, xp.where(fx == 1, q11, q01 + fx * (q11 - q01)))
        acc = xp.where(fy == 0, a, xp.where(fy == 1, b, a + fy * (b - a)))
    return xp.where(inside & ~bad, (tile["baseCm"] + acc) / 100.0, xp.nan)


def height_field(xp, tiles, origin=(0.0, 0.0), method="weights"):
    """heights(x, y) over many tiles: finest tile first, ties by e0 then n0; later tiles fill NaNs."""
    order = sorted(tiles, key=lambda t: (t["spacing"], t["e0"], t["n0"]))

    def heights(x, y):
        x, y = xp.asarray(x, dtype=xp.float64), xp.asarray(y, dtype=xp.float64)
        out = xp.full(x.shape, xp.nan)
        for t in order:
            x0, y0 = t["e0"] - origin[0], t["n0"] - origin[1]
            h = sample_tile(xp, t, x - x0, y - y0, method)
            out = xp.where(xp.isnan(out), h, out)
        return out
    return heights


def normals(xp, heights, x, y, h=1.0):
    """Unit normals (N, 3), slope in degrees, and a known flag, with the same one-sided rule as the web module."""
    x, y = xp.asarray(x, dtype=xp.float64), xp.asarray(y, dtype=xp.float64)
    c, e, w = heights(x, y), heights(x + h, y), heights(x - h, y)
    n, s = heights(x, y + h), heights(x, y - h)
    fin = xp.isfinite

    def grad(p, m, c):
        g = xp.where(fin(p) & fin(m), (p - m) / (2 * h), xp.nan)
        g = xp.where(xp.isnan(g) & fin(p) & fin(c), (p - c) / h, g)
        g = xp.where(xp.isnan(g) & ~fin(p) & fin(c) & fin(m), (c - m) / h, g)
        return g
    gx, gy = grad(e, w, c), grad(n, s, c)
    known = fin(c) & fin(gx) & fin(gy)
    gx, gy = xp.nan_to_num(gx, nan=0.0), xp.nan_to_num(gy, nan=0.0)
    L = xp.sqrt(gx * gx + gy * gy + 1)
    nrm = xp.stack([-gx / L, -gy / L, 1 / L], axis=-1)
    slope = xp.degrees(xp.arctan(xp.sqrt(gx * gx + gy * gy)))
    return nrm, slope, known


# ---------------------------------------------------------------------------------------------- surfaces
def _seg_dist(xp, x, y, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    L2 = dx * dx + dy * dy
    t = xp.clip(((x - a[0]) * dx + (y - a[1]) * dy) / L2, 0, 1) if L2 else xp.zeros_like(x)
    return xp.hypot(x - a[0] - t * dx, y - a[1] - t * dy)


def in_rings(xp, rings, x, y):
    inside = xp.zeros(x.shape, dtype=bool)
    for r in rings:
        for k in range(len(r)):
            xi, yi = r[k]
            xj, yj = r[k - 1]
            if yj == yi:
                continue
            cross = ((yi > y) != (yj > y)) & (x < (xj - xi) * (y - yi) / (yj - yi) + xi)
            inside ^= cross
    return inside


def surfaces(xp, layers, x, y):
    """Surface rank per point (index into PRIORITY) from the same layer shapes as the web module."""
    x, y = xp.asarray(x, dtype=xp.float64), xp.asarray(y, dtype=xp.float64)
    rank = xp.full(x.shape, PRIORITY.index(DEFAULT_SURFACE), dtype=xp.int64)

    def take(mask, surface):
        nonlocal rank
        rank = xp.where(mask, xp.minimum(rank, PRIORITY.index(surface)), rank)
    for w in layers.get("ways", []):
        s = WAY_SURFACE.get(w["class"])
        if not s:
            continue
        half = (w.get("width_m") or DEFAULT_WAY_WIDTH[w["class"]]) / 2
        for a, b in zip(w["pts"], w["pts"][1:]):
            take(_seg_dist(xp, x, y, a, b) <= half, s)
    for w in layers.get("water", []):
        if "rings" in w:
            take(in_rings(xp, w["rings"], x, y), "water")
        else:
            half = (w.get("width_m") or WATER_LINE_WIDTH_M) / 2
            for a, b in zip(w["pts"], w["pts"][1:]):
                take(_seg_dist(xp, x, y, a, b) <= half, "water")
    for a in layers.get("areas", []):
        if a["surface"] in SURFACES:
            take(in_rings(xp, a["rings"], x, y), a["surface"])
    for g in layers.get("grids", []):
        i = xp.floor((x - g["x0"]) / g["spacing"]).astype(xp.int64)
        j = xp.floor((y - g["y0"]) / g["spacing"]).astype(xp.int64)
        ok = (i >= 0) & (j >= 0) & (i < g["cols"]) & (j < g["rows"])
        vals = xp.asarray(g["values"])[xp.clip(j, 0, g["rows"] - 1) * g["cols"] + xp.clip(i, 0, g["cols"] - 1)]
        take(ok & (vals >= g["min"]), g["surface"])
    return rank


# ---------------------------------------------------------------------------------------------- sinkage
def beta_half(n):
    return math.exp(math.lgamma(n + 1) + math.lgamma(0.5) - math.lgamma(n + 1.5))


def sinkage_closed(xp, load, width, diameter, soil):
    """Electron: exact closed form z0 = (2W / (b k sqrt(D) B(n+1, 1/2)))^(2/(2n+1))."""
    n, k = soil["n"], soil["kc"] / width + soil["kphi"]
    W = xp.maximum(xp.asarray(load, dtype=xp.float64), 0)
    return (2 * W / (width * k * math.sqrt(diameter) * beta_half(n))) ** (2 / (2 * n + 1))


def sinkage_numeric(xp, load, width, diameter, soil, nodes=4000, iters=80):
    """Positron: bisection on z0 of the force balance W = b k integral over the arc of z^n dx, x^2 = D (z0 - z),
    integrated numerically (substitution z = z0 (1 - s^2) removes the end singularity; midpoint rule)."""
    n, k = soil["n"], soil["kc"] / width + soil["kphi"]
    W = xp.maximum(xp.asarray(load, dtype=xp.float64), 0)
    s = (xp.arange(nodes, dtype=xp.float64) + 0.5) / nodes
    # W(z0) = b k sqrt(D) z0^(n + 1/2) * integral_0^1 (1 - s^2)^n ds
    I = float(xp.sum((1 - s * s) ** n) / nodes)
    lo, hi = xp.zeros_like(W), xp.full(W.shape, 5.0)
    for _ in range(iters):
        mid = (lo + hi) / 2
        f = width * k * math.sqrt(diameter) * mid ** (n + 0.5) * I
        lo, hi = xp.where(f < W, mid, lo), xp.where(f < W, hi, mid)
    return (lo + hi) / 2


def compaction(xp, z0, width, soil):
    n, k = soil["n"], soil["kc"] / width + soil["kphi"]
    return width * k * z0 ** (n + 1) / (n + 1)


# ---------------------------------------------------------------------------------------------- solids
def sphere_boxes(xp, c, r, mins, maxs):
    """Deepest box contact per sphere. c (N, 3), r (N,), mins/maxs (M, 3). Returns depth (N,), normal (N, 3),
    solid index (N,), -1 and depth 0 where there is no hit. Ties go to the lowest box index."""
    c, r = xp.asarray(c, dtype=xp.float64), xp.asarray(r, dtype=xp.float64)
    mins, maxs = xp.asarray(mins, dtype=xp.float64), xp.asarray(maxs, dtype=xp.float64)
    p = xp.clip(c[:, None, :], mins[None], maxs[None])                    # (N, M, 3)
    d = c[:, None, :] - p
    dist = xp.sqrt((d * d).sum(-1))
    lo, hi = c[:, None, :] - mins[None], maxs[None] - c[:, None, :]      # inside: distance to each face
    faces = xp.stack([lo[..., 0], hi[..., 0], lo[..., 1], hi[..., 1], lo[..., 2], hi[..., 2]], axis=-1)  # web order
    fmin = faces.min(-1)
    depth = xp.where(dist > 0, r[:, None] - dist, fmin + r[:, None])
    depth = xp.where((dist > 0) & (dist >= r[:, None]), -xp.inf, depth)
    best = xp.argmax(depth, axis=1)
    rows = xp.arange(c.shape[0])
    bd = depth[rows, best]
    hit = xp.isfinite(bd)
    dsel, dist_sel = d[rows, best], dist[rows, best]
    face = xp.argmin(faces[rows, best], axis=-1)
    inward = xp.zeros((c.shape[0], 3))
    axis = face // 2
    sign = xp.where(face % 2 == 0, -1.0, 1.0)
    inward[rows, axis] = sign
    nrm = xp.where((dist_sel > 0)[:, None], dsel / xp.where(dist_sel > 0, dist_sel, 1)[:, None], inward)
    return xp.where(hit, bd, 0.0), xp.where(hit[:, None], nrm, 0.0), xp.where(hit, best, -1)
