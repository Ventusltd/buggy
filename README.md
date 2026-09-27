# buggy
Because driving around Lidar and Virtually created worlds is fun and RELEVANT FOR ENGINEERING AND SALES

## What this is

The buggy engine for the federation's worlds: drive a vehicle over LiDAR-derived or generated ground, feel the slope and
the surface, and check whether real delivery vehicles can make the same trip. It is built as primordial-brain style
cartridges and plugs, so a world imports it rather than keeping its own copy.

| Part | Kind | Web (ES module) | Python (CuPy / NumPy) | Docs |
|---|---|---|---|---|
| Engine entry | engine | `src/web/buggy.mjs` | | this README |
| Dynamics | cartridge | `src/web/engine/vehicle-dynamics.mjs`, `vehicle-presets.mjs` | `src/cartridges/dynamics/` | [docs/dynamics.md](docs/dynamics.md) |
| Terrain | cartridge | `src/web/terrain/terrain.mjs` | `src/cartridges/terrain/` | in the module header |
| Feel and controls | plug | `src/web/feel/*.mjs` | | [docs/feel.md](docs/feel.md) |
| Access checks | plug | `src/web/access/access-checks.mjs` | (planned) | [docs/access-checks.md](docs/access-checks.md) |

Every module is registered in [catalogue.json](catalogue.json) in the primordial-brain schema; the repository's place in
the federation is in [federation.json](federation.json); its conduct is in [DHARMA.md](DHARMA.md).

## Rules the web engine keeps

- **Dependency-free ES modules.** Relative imports only; no DOM in the physics; a test fails if a package or a clock sneaks in.
- **Deterministic.** Fixed 1 ms physics steps; the same inputs give the same numbers, bit for bit. Recorded drives replay to the millimetre.
- **0 CPU when parked.** A still vehicle is held on its brake, the session tells the world's frame gate to stop, and nothing runs until an input arrives.
- **Assumed figures are labelled.** Vehicle presets, grip and soil values are assumptions for a class of vehicle or ground, not data for any product or site.

## Using it from a world

```js
import { createTerrain, createVehicleCartridge, createDriveSession, attachControls } from './buggy/src/web/buggy.mjs';

const terrain = createTerrain({ heightAt });                 // the world's own ground function, sampled one way only
const engine  = createVehicleCartridge({ preset: 'site-buggy', groundAt: terrain.heightAt });
const session = createDriveSession({ engine, state: engine.spawn({ x, y, yaw }), gate, raw, groundAt: terrain.heightAt, onCamera });
// in the gate's draw(now): session.frame(now)
```

Presets: `site-buggy` and `utility-4x4` for driving; `rigid-hgv` and `mobile-crane` for access and swept-path checks.
The vehicle contract is `{ id, dt, step(state, input, dt) -> state, atRest(state) }`; one cartridge step is eight 1 ms
physics steps (125 Hz).

## Python cartridges and the pair method

```sh
BUGGY_ENGINE=numpy python -m pytest -q tests/python
BUGGY_ENGINE=cupy  python tools/pair_dynamics.py --rows 4096 --seconds 6   # Euler (electron) against RK4 (positron)
BUGGY_ENGINE=cupy  python tools/pair_terrain.py --photons 20000            # two formulations, Node witness
```

The engine is chosen explicitly by `BUGGY_ENGINE` (`numpy` or `cupy`) and recorded in every receipt. Each pair run
counts and locates disagreements, re-runs a sample on NumPy as a CPU witness, compares with the JS module, and writes an
LF receipt with a sha256 digest. Receipts from one GPU run are in [receipts/](receipts/).

What the pair runs show: the two integrators, the Python mirror and the JS module agree with each other. That is
consistency, not proof that the vehicle or soil figures are real.

## Tests

```sh
node --test tests/web/*.test.mjs        # dynamics, terrain, feel, access checks, the assembled engine
python -m pytest -q tests/python        # Python mirrors (NumPy by default)
python tools/validate_catalogue.py      # catalogue.json and federation.json
```

CI (`.github/workflows/ci.yml`) runs 7 CPU jobs on GitHub-hosted runners, uploads the pair receipts as artifacts, and
has an opt-in GPU job for a self-hosted runner labelled `gpu` (run the workflow by hand with `gpu` ticked).

## Known limits

- The dynamics brake is smoothed so both integrators see the same equations; a braked heavy vehicle can creep at up to
  about 0.07 m/s on a 10 % slope until parking freezes it.
- Multi-axle chassis are reduced to four contacts.
- The dynamics cartridge takes grip from the preset; the terrain cartridge's per-surface grip and sinkage are not yet fed into the tyre model.
- Soil and sinkage values are illustrative.
- Access checks have no Python mirror yet.

## Licence

Code: Apache License 2.0 (see [LICENSE](LICENSE)).
