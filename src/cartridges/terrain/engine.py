"""Array engine selection. The engine is chosen explicitly by the BUGGY_ENGINE environment variable
("numpy", the default, or "cupy") and recorded in every receipt. If CuPy is asked for but cannot run (not
installed, or no CUDA device), NumPy is used and the receipt says what was asked for, what ran, and why.
"""
import os

import numpy as np


def select(requested=None):
    """Return (xp, info) where xp is the array module and info is the record for receipts."""
    req = (requested or os.environ.get("BUGGY_ENGINE", "numpy")).strip().lower()
    if req not in ("numpy", "cupy"):
        raise ValueError(f"BUGGY_ENGINE must be numpy or cupy, not {req!r}")
    info = {"requested": req, "engine": "numpy", "numpy": np.__version__}
    if req == "cupy":
        try:
            import cupy as cp
            cp.cuda.runtime.getDeviceCount()
            cp.asarray([1.0]).sum().item()
            props = cp.cuda.runtime.getDeviceProperties(0)  # no device name: receipts stay free of brand names
            info.update(engine="cupy", cupy=cp.__version__, compute_capability=f"{props['major']}.{props['minor']}",
                        device_memory_gib=round(props["totalGlobalMem"] / 2**30, 1))
            return cp, info
        except Exception as exc:  # CuPy absent or no device: fall back, and say so
            info["fallback_reason"] = f"{type(exc).__name__}: {exc}"[:200]
    return np, info


def to_numpy(a):
    """Bring an array back to host memory (a no-op for NumPy)."""
    return a.get() if hasattr(a, "get") else np.asarray(a)
