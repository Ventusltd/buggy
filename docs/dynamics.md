# Dynamics cartridge

A rigid body on four wheel contacts, for driving over terrain and LiDAR-derived ground. The same model is written twice:

| Side | File | Runs on |
|---|---|---|
| Web | `src/web/engine/vehicle-dynamics.mjs`, `src/web/engine/vehicle-presets.mjs` | any browser, Node; no dependencies |
| Python | `src/cartridges/dynamics/engine.py` | NumPy, or CuPy with `BUGGY_ENGINE=cupy` |

The JS module is the reference. `tools/golden-dynamics.mjs` writes `tests/data/dynamics-golden.json` and `src/cartridges/dynamics/presets.json`, and the Python mirror has to reproduce the golden runs to a relative 1e-9.

## Frame and state

Local east (x), north (y), up (z), in metres. Yaw 0 faces north and yaw +π/2 faces east, which is the same convention as the world camera. Roll is positive with the right side down. Pitch is positive with the nose up.

The state is 16 numbers: position (3), roll, pitch, yaw, linear velocity (3), roll, pitch and yaw rates, and the spin rate of each wheel (FL, FR, RL, RR).

## Model and assumptions

- **Body.** Six degrees of freedom. Roll and pitch are small angles, integrated as plain rates.
- **Suspension.** Each wheel has one vertical spring-damper, mounted at the level of the centre of mass. There is a bump stop at the travel limit, and the spring never pulls. Free lengths are set so that the vehicle rests at its design height with the static load split.
- **Contact.** The spring force is taken as the tyre's normal load. That load acts along the ground normal, and the tyre forces act in the ground's tangent plane, so a vehicle rolls downhill. The ground slope comes from central differences 5 cm either side of the contact.
- **Tyre.** A simplified slip curve, F = μN sin(C atan(B s)), applied to the slip ratio and to the slip angle, then limited to the friction circle. Slip is measured against max(|v_long|, `slipRefSpeed`). This low-speed regularisation keeps the step stable.
- **Drive and brake.** Drive torque falls linearly to zero at top speed. An open differential is modelled as an equal torque split. Brake torque and rolling resistance follow tanh(ω / 0.5 rad/s), so both integrators see the same smooth ODE. The cost of this smoothing is creep: a braked heavy vehicle on a 10 % slope creeps at up to about 0.07 m/s until parking freezes it (see below).
- **Wheel inertia.** The spin inertia of each wheel includes the driveline reflected through the gearing. The presets choose it so that the stiffest wheel-spin rate × DT stays below 1.5. `spinStiffness()` computes that rate, and a test holds every preset to the limit.
- **Steering.** Exact Ackermann geometry about a turn centre, which sits on the rear axle line, or at mid-wheelbase for counter-phase all-wheel steer. At full lock the vehicle meets the preset turning circle, measured as the diameter of the path traced by the outer front wheel's contact centre.
- **Aero.** Drag is ½ρ·CdA·v², horizontal only.
- **Multi-axle vehicles.** These are reduced to an equivalent four-contact chassis. This is an assumption, and each preset's basis line says so.

## Presets

All figures are assumptions for a class of vehicle, not the data of any product.

| Preset | Mass | Wheelbase / track | Turning circle | Drive | Use |
|---|---|---|---|---|---|
| `site-buggy` | 650 kg | 2.0 / 1.3 m | 7.0 m | rear | driving the world |
| `utility-4x4` | 2 300 kg | 3.1 / 1.6 m | 12.4 m | all | driving the world |
| `rigid-hgv` | 18 t | 5.0 / 2.0 m | 17.0 m | rear | access and swept-path checks only |
| `mobile-crane` | 48 t | 7.0 / 2.5 m equivalent | 20.0 m, counter-phase steer | all | access checks only |

## Integrators: the pair

Both integrators work on the same `derivative()`:

- **Semi-implicit Euler** (the electron): it takes the velocities from the forces now, then the positions from the new velocities.
- **Classical RK4** (the positron).

The fixed step is DT = 1 ms. On the golden manoeuvre the two integrators agree to within 5 cm and 0.5°, and a test enforces that. `tools/pair_dynamics.py` runs both over a batch of vehicles on bumpy ground and checks them against each other and against the friction circle. It then re-runs a sample of rows on NumPy as a CPU witness, compares the NumPy mirror with the JS golden file, and writes an LF receipt with sha256 digests. The receipt records the engine that was used.

In the browser, one RK4 step costs about 1.4 µs, so one simulated second (1 000 steps) takes about 1.4 ms of CPU.

## World integration

The world imports the module. It does not copy it. Most worlds should use `src/web/buggy.mjs` (`createVehicleCartridge`), which wraps this driver for the feel layer; the lower-level driver below is for a world that brings its own controls and cameras.

```js
import { createDriver } from './engine/vehicle-dynamics.mjs';
const car = createDriver({ preset: 'site-buggy', groundAt, x, y, yaw, method: 'rk4' });
car.setInput({ throttle, brake, steer, gear });      // steer in [-1, 1], gear 1 or -1; wakes a parked car
const { moving } = car.advance(frameSeconds);        // whole 1 ms steps; the remainder carries to the next frame
frameGate.setMoving(moving, 30);                     // parked => no steps and no frames
const pose = car.pose();                             // x, y, z, yaw, pitch, roll, speed, wheels[{x, y, ground, steer, spin}]
```

- **Deterministic.** Frame time is counted in whole microseconds. Any split of the same total time gives the same steps and the same numbers, bit for bit.
- **No CPU when parked.** With no throttle, the car parks when it is still. A braked car parks below 0.1 m/s; an unbraked one parks only if it is also not accelerating. While parked, `advance()` does no work, and it returns `moving: false` so the frame gate can stop drawing.
- **Ground.** `groundAt(x, y)` is the world's own terrain height function. The ground slope comes from calling it at the contact.

## Tests

- `node --test tests/web/dynamics.test.mjs` covers presets and JSON parity, the stability limit, Ackermann geometry, rest loads, the turning circle, the braking bound, top speed, signs, slope hold, Euler against RK4, bit-exact determinism, and the driver's frame splits and parking.
- `BUGGY_ENGINE=numpy python -m pytest tests/python/test_dynamics.py` covers golden parity with the JS module, rest loads, Ackermann geometry, the friction circle and the explicit engine choice.
