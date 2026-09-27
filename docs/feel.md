# Buggy feel and controls

Dependency-free ES modules that turn a person (or a guided tour) into driver input for the buggy's vehicle engine, and the
vehicle's state into a camera, a HUD and optional sound. No physics lives here: the vehicle engine cartridge supplies
`{ id, dt, step(state, input, dt) -> state, atRest?(state) }` and this layer runs it on its fixed step.

| Module | Job |
| --- | --- |
| `controls.mjs` | Keys, standard gamepad and touch pad to `{ drive, brake, steer, handbrake }`; ramps and speed-narrowed steering, deterministic per step |
| `cameras.mjs` | Chase and driver cameras, exponential smoothing on the step, `settled()` for parking |
| `hud.mjs` | SPD / GRD / HDG lines; red only beyond a set speed or gradient limit (illustrative defaults, editable) |
| `mount.mjs` | Walk to drive and back; dismount only when stopped, beside the driver door |
| `drive-record.mjs` | Drives stored as run-length inputs + start + end state + sha256; replay through the same engine must land to the millimetre |
| `site-tour.mjs` | `buggy.site-tour.v1`: a route in grid metres with stops and captions; a pure-pursuit guide that drives through the same controls and physics |
| `sound.mjs` | Engine note, off by default, no audio created until turned on |
| `drive-session.mjs` | Everything wired to the world's frame gate: 30 fps while moving, 0 fps parked |

Keys: W/S or arrows drive and brake (reverse from rest), A/D steer, Space handbrake, Shift fine steer, C camera,
X mount/dismount, N sound, P pause a tour. Gamepad: left stick, triggers, A handbrake, Y camera, B mount.

Tests: `node --test tests/web/*.test.mjs`. The tests use a stand-in kinematic engine (`tests/web/helpers/test-engine.mjs`),
which is not the buggy's physics.
