// cameras.mjs: chase and driver cameras for the buggy, smoothed on the fixed step. Pure: no DOM, no WebGL.
// Conventions are the world's: local east (x), north (y), up (z) in metres; yaw 0 looks north (+y), yaw +pi/2 looks
// east (+x); pitch +pi/2 looks straight up. Output { pos: [x, y, z], yaw, pitch } goes straight into the world's
// camera view(pos, yaw, pitch).
// Vehicle pose in: { pos: [x, y, z], yaw, pitch, roll } with pos at the body's reference point on the ground plane
// and pitch positive nose up.

export const MODES = Object.freeze(['chase', 'driver']);
export const CHASE = Object.freeze({ back: 6.5, up: 2.4, lookAhead: 4, lookUp: 0.9, tauPos: 0.18, tauYaw: 0.28, clearance: 0.6 });
export const DRIVER = Object.freeze({ seat: [-0.35, 0.2, 1.25], tauPitch: 0.08, tauYaw: 0.04, lookLimit: 2.4 });
export const SETTLED = Object.freeze({ pos: 0.002, ang: 0.0005 }); // metres and radians left to travel

const TAU = 2 * Math.PI;
export const wrap = a => { const d = a % TAU; return d > Math.PI ? d - TAU : d < -Math.PI ? d + TAU : d; };
// Fraction of the remaining gap closed in dt for time constant tau: frame-rate independent exponential smoothing.
export const blend = (dt, tau) => (tau > 0 ? 1 - Math.exp(-dt / tau) : 1);

// Body frame -> local world: [right, forward, up] offset of a point on a vehicle with the given yaw (pitch and
// roll are ignored for the chase target and applied to the seat only through the camera's own pitch).
export function bodyToWorld(pose, [r, f, u]) {
  const s = Math.sin(pose.yaw), c = Math.cos(pose.yaw);
  return [pose.pos[0] + f * s + r * c, pose.pos[1] + f * c - r * s, pose.pos[2] + u];
}

// Where each camera wants to be for this vehicle pose, before smoothing.
export function chaseTarget(pose, { groundAt = null, back = CHASE.back, up = CHASE.up } = {}) {
  const eye = bodyToWorld(pose, [0, -back, up]);
  if (groundAt) { const g = groundAt(eye[0], eye[1]); if (Number.isFinite(g)) eye[2] = Math.max(eye[2], g + CHASE.clearance); }
  const look = bodyToWorld(pose, [0, CHASE.lookAhead, CHASE.lookUp]);
  const d = [look[0] - eye[0], look[1] - eye[1], look[2] - eye[2]];
  return { pos: eye, yaw: Math.atan2(d[0], d[1]), pitch: Math.atan2(d[2], Math.hypot(d[0], d[1])) };
}

export function driverTarget(pose, look = 0) {
  const l = Math.max(-DRIVER.lookLimit, Math.min(DRIVER.lookLimit, look));
  return { pos: bodyToWorld(pose, DRIVER.seat), yaw: pose.yaw + l, pitch: (pose.pitch || 0) * Math.cos(l) };
}

// A camera rig. step(pose, dt) advances the smoothing one fixed step and returns the camera; the driver camera
// follows the body closely (the seat is bolted to it) while the chase camera lags so turns read as turns.
// settled() is true when the camera has nothing left to travel, so the loop may park.
export function createRig({ mode = 'chase', groundAt = null } = {}) {
  if (!MODES.includes(mode)) throw Error(`camera mode must be one of ${MODES.join(', ')}`);
  let cam = null, gap = Infinity, look = 0;
  const rig = {
    get mode() { return mode; },
    get camera() { return cam; },
    // Cycle chase -> driver -> chase. The next step snaps to the new seat rather than swooping through the body.
    toggle() { mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length]; cam = null; return mode; },
    setMode(m) { if (!MODES.includes(m)) throw Error(`unknown camera mode ${m}`); if (m !== mode) { mode = m; cam = null; } return mode; },
    // Driver's look around (radians left of or right of ahead), for mouse drag or a right stick.
    look(a) { look = a; gap = Infinity; },
    snap(pose) { cam = mode === 'chase' ? chaseTarget(pose, { groundAt }) : driverTarget(pose, look); gap = 0; return cam; },
    step(pose, dt) {
      const want = mode === 'chase' ? chaseTarget(pose, { groundAt }) : driverTarget(pose, look);
      if (!cam) { cam = want; gap = 0; return cam; }
      const tp = mode === 'chase' ? CHASE.tauPos : 0;
      const ty = mode === 'chase' ? CHASE.tauYaw : DRIVER.tauYaw;
      const tpi = mode === 'chase' ? CHASE.tauYaw : DRIVER.tauPitch;
      const kp = blend(dt, tp), ky = blend(dt, ty), kpi = blend(dt, tpi);
      const pos = cam.pos.map((v, i) => v + (want.pos[i] - v) * kp);
      const yaw = wrap(cam.yaw + wrap(want.yaw - cam.yaw) * ky);
      const pitch = cam.pitch + (want.pitch - cam.pitch) * kpi;
      gap = Math.max(Math.hypot(want.pos[0] - pos[0], want.pos[1] - pos[1], want.pos[2] - pos[2]) / SETTLED.pos,
        Math.abs(wrap(want.yaw - yaw)) / SETTLED.ang, Math.abs(want.pitch - pitch) / SETTLED.ang);
      cam = { pos, yaw, pitch };
      return cam;
    },
    settled() { return gap <= 1; }
  };
  return rig;
}
