"""Unit tests for the terrain cartridge (array side). Run from python/: python -m unittest discover -s tests"""
import math
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))
from cartridges.terrain import engine, terrain as T  # noqa: E402

xp, INFO = engine.select()
plane = lambda x, y: 10 + 0.05 * x - 0.02 * y


def plane_tile(e0, n0, samples=9, spacing=2.0, f=plane):
    q = np.zeros(samples * samples, dtype=np.uint16)
    for j in range(samples):
        for i in range(samples):
            q[j * samples + i] = round(f(e0 + i * spacing, n0 + j * spacing) * 100)
    return {"samples": samples, "spacing": spacing, "e0": e0, "n0": n0, "baseCm": 0, "q": q}


class Heights(unittest.TestCase):
    def test_plane_edges_and_corners(self):
        tiles = [plane_tile(0, 0), plane_tile(16, 0), plane_tile(0, 16), plane_tile(16, 16)]
        pts = np.array([[3.3, 7.1], [16, 5], [16, 16], [0, 0], [32, 32], [31.99, 0.01], [8, 16]])
        for method in ("weights", "lerp"):
            h = engine.to_numpy(T.height_field(xp, tiles, method=method)(pts[:, 0], pts[:, 1]))
            np.testing.assert_allclose(h, plane(pts[:, 0], pts[:, 1]), atol=0.006)
        out = engine.to_numpy(T.height_field(xp, tiles)(np.array([-0.1, 5]), np.array([5, 32.1])))
        self.assertTrue(np.isnan(out).all())

    def test_nodata(self):
        t = plane_tile(0, 0)
        t["q"][0] = T.NODATA
        h = engine.to_numpy(T.sample_tile(xp, t, np.array([1.0, 2.0]), np.array([1.0, 1.0])))
        self.assertTrue(math.isnan(h[0]))
        self.assertAlmostEqual(h[1], plane(2, 1), delta=0.006)

    def test_normals(self):
        hf = T.height_field(xp, [plane_tile(0, 0)])
        n, slope, known = (engine.to_numpy(a) for a in T.normals(xp, hf, np.array([8.0, 0, 16, 50]), np.array([8.0, 8, 16, 50])))
        L = math.hypot(0.05, 0.02, 1)
        np.testing.assert_allclose(n[:3], [[-0.05 / L, 0.02 / L, 1 / L]] * 3, atol=1e-3)
        self.assertEqual(list(known), [True, True, True, False])
        np.testing.assert_allclose(n[3], [0, 0, 1])


class Surfaces(unittest.TestCase):
    def test_priority(self):
        layers = {"ways": [{"class": "minor", "pts": [[0, 0], [100, 0]]}, {"class": "track", "pts": [[0, 40], [100, 40]]}],
                  "water": [{"pts": [[50, -50], [50, 90]]}],
                  "areas": [{"surface": "soft", "rings": [[[70, 10], [90, 10], [90, 30], [70, 30]]]}],
                  "grids": [{"surface": "wet", "x0": 0, "y0": 10, "spacing": 5, "cols": 4, "rows": 4, "values": np.full(16, 9, np.uint8), "min": 8}]}
        pts = np.array([[20, 1], [50, 0], [50, 40], [20, 40.5], [80, 20], [5, 15], [30, 70]], dtype=float)
        r = engine.to_numpy(T.surfaces(xp, layers, pts[:, 0], pts[:, 1]))
        self.assertEqual([T.PRIORITY[i] for i in r], ["tarmac", "tarmac", "water", "gravel", "soft", "wet", "grass"])


class Sinkage(unittest.TestCase):
    def test_pair_agrees_and_force_balance(self):
        loads = np.array([0.0, 500, 2000, 4000])
        for name in ("grass", "wet", "soft"):
            soil = T.SURFACES[name]["soil"]
            a = engine.to_numpy(T.sinkage_closed(xp, loads, 0.2, 0.6, soil))
            b = engine.to_numpy(T.sinkage_numeric(xp, loads, 0.2, 0.6, soil))
            np.testing.assert_allclose(a, b, rtol=1e-5, atol=1e-12)
        self.assertAlmostEqual(T.beta_half(0.5), math.pi / 2, places=12)


class Solids(unittest.TestCase):
    def test_spheres(self):
        mins, maxs = [[0, 0, 0], [10, 10, 0]], [[2, 1, 1.2], [11, 11, 2]]
        c = [[2.3, 0.5, 0.5], [1.9, 0.5, 0.6], [5, 5, 0.5]]
        d, n, s = (engine.to_numpy(a) for a in T.sphere_boxes(xp, c, [0.4, 0.3, 1], mins, maxs))
        np.testing.assert_allclose(d, [0.1, 0.4, 0], atol=1e-12)
        np.testing.assert_allclose(n[:2], [[1, 0, 0], [1, 0, 0]])
        self.assertEqual(list(s), [0, 0, -1])


if __name__ == "__main__":
    unittest.main()
