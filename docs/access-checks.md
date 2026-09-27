# Access checks: driving as an engineering check

Driving around a measured or designed world is useful when it answers a question an engineer or a client would otherwise ask
on site: **can the delivery vehicles get in, and can the transformer get to the station?** This plug answers it along any route
the world holds: a designed access road, a line drawn over the ground, or the trace the buggy has just driven.

Everything is a pure ES module (`src/web/access/access-checks.mjs`): no DOM, no network, no clock, no randomness, no dependencies. Every
walk along a route runs on a fixed 0.25 m step, so the same inputs give the same numbers on every device, and nothing runs until
a function is called (0 CPU when the viewer is parked).

## Inputs

| Input | Accepted forms |
|---|---|
| Route | a road object from the world's road cartridge (`pointAt`, `designLevel`, `finishedAt`, `length2d`, `width`, `surface`); `{ path, groundAt, width?, surface? }`; `{ trace: [[x, y, z]], cross?, width? }` from the buggy's log |
| Vehicle | a key of `VEHICLES` or an object of the same shape (units, overhangs, width, height, masses, limits) |
| Gates | `{ x, y, width, label? }` |
| Structures | `{ x, y, kind: bridge / culvert / overhead / line / width, grossT?, axleT?, widthM?, clearanceM? }` |
| Soft zones | `{ polygon, bearingKPa, label? }` |

`profileOf(route)` turns any of these into stations (chainage, x, y, z, cross-slope, tangent); every check works on stations,
so a driven trace and a design are checked by the same code. `joinProfiles` chains roads end to start.

## Checks

| Check | Method | Severity when it fails |
|---|---|---|
| Gradient | grade over a 10 m base at every station; runs above the vehicle limit reported with chainage | block |
| Cross-slope | from the road's finished levels across a 2 m track, or from the ground either side, or from the trace's roll | block |
| Bend | radius of the circle through points 5 m either side; against the tightest front-axle radius the vehicle steers | block |
| Swept path, wheels | the vehicle is simulated: front axle on the centreline, each rear axle on a tractrix, a trailer hitched at the kingpin; every axle end must stay on the carriageway | block |
| Swept path, body | body corners over the verge; the verge must be clear of posts, cabinets and fences | check |
| Gate | swept width through the gate plus 0.3 m each side against the clear opening | block |
| Grounding | a low deck spanning its supports against the ground rising above the chord (humps, crests, bridge decks) | block |
| Bridge / culvert | gross and axle rating as given; no rating held asks for an assessment (CS 454) | block, or check if unrated |
| Headroom | vehicle height plus margin under a structure (CD 127) or an overhead line (HSE GS6; the line owner sets the clearance) | block / check |
| Soft ground | vehicle ground pressure against the zone's bearing where the route is unsurfaced; on a made road, asks for the build-up design | block / check |

Results use the world's check-HUD shape `{ id, failed, severity, line, at, working: { inputs, standard, note } }`, so the
failed lines drop straight into the HUD, and `at` places a marker in the world.

## "Can the transformer get to the station?"

`canReach({ roads, from, to, vehicle })` joins road ends within 5 m into a network, keeps only the roads the vehicle can use
on their own, takes the shortest way through them, then checks the whole way again as one route so the turns between roads are
checked too. When no way exists it reports the shortest way regardless and every blocker on it, with the reason: the roads do
not connect, every way has a blocker, or the roads pass on their own and a turn between them blocks.

## Sales view

`tour(profile, { speed, stops })` gives fixed-step camera keys (position, yaw, pitch, caption) for the world's chase or driver
camera: a drive-through of a proposed layout for a landowner or client, pausing at each stop (the station compound, a gate,
a crossing) with a caption. The player owns the clock. `summary(profile, verdicts)` gives plain lines: the route in numbers and
the delivery answer per vehicle, always ending with the assumption note.

## Vehicles (assumed, editable)

| Key | Width | Height | Gross | Grade | Cross | Min radius | Deck |
|---|---|---|---|---|---|---|---|
| hgv-artic | 2.55 m | 4.0 m | 44 t | 10 % | 5 % | 11.1 m | 7.7 m at 0.30 m |
| low-loader-transformer | 3.5 m | 4.9 m | 130 t | 8 % | 3 % | 14 m | 12 m at 0.15 m |
| mobile-crane | 3.0 m | 4.0 m | 60 t | 10 % | 4 % | 10 m | none |
| car-4x4 | 1.9 m | 1.9 m | 2.8 t | 25 % | 15 % | 6 m | none |

Every figure is typical and assumed; the haulier, the crane supplier and the structure owner give the real ones. Abnormal
loads move under SI 2003/1998. Vehicle lengths follow 96/53/EC.

## Evidence

- **Pair.** The swept path is worked out two independent ways: the analytic steady state on a circle (each axle on
  `sqrt(R^2 - L^2)`) and the fixed-step tractrix simulation. On long circles they agree within 1 % for all three heavy vehicles.
  Agreement proves the two methods are consistent, not that the vehicle figures are true.
- **A published figure.** The assumed artic, with its outer front corner on 12.5 m, keeps its inner wheels outside 5.3 m: the
  turning circle every compliant vehicle must achieve under 96/53/EC. This is the one check against an outside source.
- **Tests.** `node --test tests/web/access-checks.test.mjs`: 16 tests, every check failing and passing on purpose, determinism,
  the network search, the tour, and a public-safety scan of the source.

## How the world uses it

The world imports this module as a cartridge and does not copy it. The buggy mode hands its driven trace (x, y, z and roll per
fixed step) to `profileOf({ trace })`; the road tool hands its road objects directly. The HUD shows `failed` lines; the markers
use `at`; the sales camera plays `tour` keys.

## Limits (stated, not hidden)

- Steady-speed geometry only: no tyre scrub, no load transfer, no speed-dependent off-tracking, no rear-steer trailers.
  Rear-steered modular trailers sweep far less; give them as a shorter effective wheelbase.
- A multi-axle rigid crane is modelled with one effective wheelbase.
- Grounding covers crests and humps under the deck span; approach and departure angles at the overhangs are not modelled.
- Structure ratings are taken as given, never assessed. Overhead line clearances are for the line owner to confirm.
- The network search drops a road that blocks on its own before it looks at turns; a way that fails only at a turn is reported,
  not re-routed.
- Planned: a CuPy / NumPy batch witness (explicit engine by environment variable, recorded in a sha256 receipt) that runs the
  same checks over many routes and vehicles and must agree with this module station by station.
