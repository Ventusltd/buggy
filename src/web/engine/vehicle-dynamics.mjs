// Vehicle dynamics cartridge: a rigid body on four wheel contacts. Pure ES module: no DOM, no WebGL, no dependencies.
// Frame: local east (x), north (y), up (z), metres. Yaw 0 faces north (+y), yaw +π/2 faces east (+x), as the world camera.
// Roll is positive with the right side down, pitch positive with the nose up. Body right is (cos yaw, -sin yaw).
//
// Model (every simplification is stated here and in docs/dynamics.md):
//  - Rigid body with 6 degrees of freedom; roll and pitch are small angles integrated as plain rates.
//  - One spring-damper per wheel, acting vertically from a mount at the body's centre-of-mass level;
//    a bump stop at the travel limit; the spring never pulls the wheel onto the ground.
//  - The spring force is taken as the tyre normal load; the contact force is that load along the ground
//    normal plus tyre forces in the ground tangent plane, so a vehicle rolls down a slope.
//  - Tyre: simplified slip curve F = mu N sin(C atan(B s)) for slip ratio and slip angle, limited to the
//    friction circle. Slip is computed against max(|v_long|, slipRefSpeed): low-speed regularisation.
//  - Wheel spin inertia includes the reflected driveline; drive torque falls linearly to zero at top speed;
//    an open differential is taken as an equal torque split.
//  - Brake and rolling resistance use tanh(omega / 0.5 rad/s): smooth, so both integrators see the same ODE.
//  - Steering: exact Ackermann about a turn centre on the rear axle line (or mid-wheelbase for counter-phase
//    all-wheel steer). Full lock gives the preset turning circle, measured as the diameter of the path of the
//    outer front wheel contact centre.
//
// Two formulations integrate the same derivative: semi-implicit (symplectic) Euler and classical RK4.
// Fixed step. Nothing here reads a clock; the same inputs give the same numbers.

import { PRESETS } from './vehicle-presets.mjs';

export const DT = 0.001;                  // s, fixed physics step
export const G = 9.81, RHO_AIR = 1.225;
export const SPIN_REF = 0.5;              // rad/s, brake and rolling-resistance smoothing
export const GRAD_H = 0.05;               // m, central-difference step for the ground slope
export const MAX_FRAME = 0.25;            // s, a longer frame is clipped (the world was away)

// State layout (Float64Array(16))
export const STATE = Object.freeze({ X: 0, Y: 1, Z: 2, ROLL: 3, PITCH: 4, YAW: 5,
  VX: 6, VY: 7, VZ: 8, ROLL_RATE: 9, PITCH_RATE: 10, YAW_RATE: 11, SPIN: 12 });
export const WHEELS = Object.freeze(['FL', 'FR', 'RL', 'RR']);
export const N_STATE = 16;

export function params(preset) {
  const p = typeof preset === 'string' ? PRESETS[preset] : preset;
  if (!p) throw new Error(`unknown preset: ${preset}`);
  return p;
}

// Derived geometry: contact offsets, driven wheels, spring free lengths, steering limits.
export function geometry(preset) {
  const p = params(preset);
  const b = p.wheelbase * p.frontLoadFraction, a = p.wheelbase - b, ht = p.track / 2;
  const s = [a, a, -b, -b], l = [-ht, ht, -ht, ht];
  const driven = p.drive === 'all' ? [1, 1, 1, 1] : p.drive === 'front' ? [1, 1, 0, 0] : [0, 0, 1, 1];
  const wF = p.mass * G * p.frontLoadFraction / 2, wR = p.mass * G * (1 - p.frontLoadFraction) / 2;
  const load = [wF, wF, wR, wR];
  const free = load.map(w => p.cgHeight + w / p.springRate);
  const xc = p.steerCentre === 'mid' ? (a - b) / 2 : -b;
  const ro = p.turningCircle / 2, reach = a - xc;
  if (ro <= reach + ht) throw new Error('turning circle smaller than the chassis allows');
  const rc = Math.sqrt(ro * ro - reach * reach) - ht;
  return Object.freeze({ p, a, b, s, l, driven, nDriven: driven.reduce((m, d) => m + d, 0),
    staticLoad: load, free, steerCentre: xc, minRadius: rc, maxCurvature: 1 / rc });
}

// Stiffest wheel-spin rate (1/s) at static load: tyre slip stiffness plus the brake's tanh slope, over the
// spin inertia. Semi-implicit Euler is stable while stiffness * DT < 2; presets are kept below 1.5.
export function spinStiffness(preset) {
  const geo = geometry(preset), p = geo.p, R = p.wheelRadius;
  const peak = Math.max(...geo.staticLoad);
  const tyre = p.tyreB * p.tyreC * p.mu * peak * R * R / (p.wheelInertia * p.slipRefSpeed);
  const brake = (p.brakeTorque + p.rollingResistance * peak * R) / (SPIN_REF * p.wheelInertia);
  return tyre + brake;
}

// Ackermann road-wheel angles (rad, positive steers right) for steer input in [-1, 1].
export function steerAngles(geo, steer, out = new Float64Array(4)) {
  const k = Math.max(-1, Math.min(1, steer)) * geo.maxCurvature;
  for (let i = 0; i < 4; i++) out[i] = Math.atan((geo.s[i] - geo.steerCentre) * k / (1 - geo.l[i] * k));
  return out;
}

const clamp01 = v => (v > 1 ? 1 : v < 0 ? 0 : v);
const delta = new Float64Array(4);

// Time derivative of the state. diag (optional, length >= 24) receives per wheel [N, Fx, Fy, limit, slip, angle].
export function derivative(y, input, geo, groundAt, dy, diag = null) {
  const p = geo.p, m = p.mass, R = p.wheelRadius;
  const x = y[0], yy = y[1], z = y[2], roll = y[3], pitch = y[4], yaw = y[5];
  const vx = y[6], vy = y[7], vz = y[8], rollRate = y[9], pitchRate = y[10], yawRate = y[11];
  const throttle = clamp01(input.throttle || 0), brake = clamp01(input.brake || 0);
  const gear = input.gear === -1 ? -1 : 1;
  steerAngles(geo, input.steer || 0, delta);

  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  const ux = sy, uy = cy, rx = cy, ry = -sy;             // body forward and right, horizontal
  const sp = Math.sin(pitch), cp = Math.cos(pitch), sr = Math.sin(roll), cr = Math.cos(roll);

  // drive torque from the mean driven-wheel speed, falling linearly to zero at the gear's top speed
  let wMean = 0;
  for (let i = 0; i < 4; i++) if (geo.driven[i]) wMean += y[12 + i];
  wMean /= geo.nDriven;
  const vTop = gear > 0 ? p.topSpeed : p.reverseTopSpeed;
  const fall = Math.max(0, 1 - Math.max(0, gear * wMean * R) / vTop);
  const tWheel = gear * throttle * p.driveTorque * fall / geo.nDriven;

  let Fx = 0, Fy = 0, Fz = 0, Mroll = 0, Mpitch = 0, Myaw = 0;
  for (let i = 0; i < 4; i++) {
    const s = geo.s[i], l = geo.l[i];
    const dx = s * ux + l * rx, dyo = s * uy + l * ry;
    const px = x + dx, py = yy + dyo;
    const g = groundAt(px, py);
    const gx = (groundAt(px + GRAD_H, py) - groundAt(px - GRAD_H, py)) / (2 * GRAD_H);
    const gy = (groundAt(px, py + GRAD_H) - groundAt(px, py - GRAD_H)) / (2 * GRAD_H);

    // suspension
    const attachZ = z + s * sp - l * sr;
    const comp = geo.free[i] - (attachZ - g);
    const vcx = vx + yawRate * dyo, vcy = vy - yawRate * dx;
    const gdot = gx * vcx + gy * vcy;
    const compRate = -((vz + s * cp * pitchRate - l * cr * rollRate) - gdot);
    let N = 0;
    if (comp > 0) {
      N = p.springRate * comp + p.damperRate * compRate;
      if (comp > p.travel) N += 10 * p.springRate * (comp - p.travel);
      if (N < 0) N = 0;
    }

    // contact frame: ground normal, wheel heading and wheel right in the ground tangent plane
    const nn = 1 / Math.sqrt(1 + gx * gx + gy * gy);
    const nX = -gx * nn, nY = -gy * nn, nZ = nn;
    const h = yaw + delta[i], sh = Math.sin(h), ch = Math.cos(h);
    let t1x = sh, t1y = ch, t1z = gx * sh + gy * ch;
    const n1 = 1 / Math.sqrt(t1x * t1x + t1y * t1y + t1z * t1z); t1x *= n1; t1y *= n1; t1z *= n1;
    let t2x = ch, t2y = -sh, t2z = gx * ch - gy * sh;
    const n2 = 1 / Math.sqrt(t2x * t2x + t2y * t2y + t2z * t2z); t2x *= n2; t2y *= n2; t2z *= n2;

    // tyre
    const vLong = vcx * t1x + vcy * t1y + gdot * t1z, vLat = vcx * t2x + vcy * t2y + gdot * t2z;
    const w = y[12 + i];
    const vRef = Math.max(Math.abs(vLong), p.slipRefSpeed);
    const kappa = (w * R - vLong) / vRef, alpha = Math.atan(vLat / vRef);
    const lim = p.mu * N;
    let fl = lim * Math.sin(p.tyreC * Math.atan(p.tyreB * kappa));
    let fs = -lim * Math.sin(p.tyreC * Math.atan(p.tyreB * alpha));
    const fm = Math.hypot(fl, fs);
    if (fm > lim && fm > 0) { const k = lim / fm; fl *= k; fs *= k; }

    // wheel spin
    const tw = Math.tanh(w / SPIN_REF);
    const torque = (geo.driven[i] ? tWheel : 0) - brake * p.brakeTorque * tw - p.rollingResistance * N * R * tw;
    dy[12 + i] = (torque - fl * R) / p.wheelInertia;

    // contact force in the world frame
    const cx = N * nX + fl * t1x + fs * t2x, cyF = N * nY + fl * t1y + fs * t2y, cz = N * nZ + fl * t1z + fs * t2z;
    Fx += cx; Fy += cyF; Fz += cz;
    const fFwd = cx * ux + cyF * uy, fRight = cx * rx + cyF * ry;
    Mpitch += cz * s + p.cgHeight * fFwd;
    Mroll += -cz * l - p.cgHeight * fRight;
    Myaw += dyo * cx - dx * cyF;                       // clockwise seen from above is positive, as yaw
    if (diag) { const o = 6 * i; diag[o] = N; diag[o + 1] = fl; diag[o + 2] = fs; diag[o + 3] = lim; diag[o + 4] = kappa; diag[o + 5] = alpha; }
  }

  const vh = Math.hypot(vx, vy), drag = 0.5 * RHO_AIR * p.dragArea * vh;
  dy[0] = vx; dy[1] = vy; dy[2] = vz; dy[3] = rollRate; dy[4] = pitchRate; dy[5] = yawRate;
  dy[6] = (Fx - drag * vx) / m;
  dy[7] = (Fy - drag * vy) / m;
  dy[8] = Fz / m - G;
  dy[9] = Mroll / p.Ixx;
  dy[10] = Mpitch / p.Iyy;
  dy[11] = Myaw / p.Izz;
  return dy;
}

// Scratch buffers, one set per module: steps are synchronous, so sharing is safe.
const k1 = new Float64Array(N_STATE), k2 = new Float64Array(N_STATE), k3 = new Float64Array(N_STATE),
  k4 = new Float64Array(N_STATE), tmp = new Float64Array(N_STATE);

// Semi-implicit Euler: velocities first from the forces now, then positions with the new velocities.
export function stepEuler(y, input, geo, groundAt, dt = DT) {
  derivative(y, input, geo, groundAt, k1);
  for (let j = 6; j < N_STATE; j++) y[j] += k1[j] * dt;
  for (let j = 0; j < 6; j++) y[j] += y[6 + j] * dt;
  return y;
}

// Classical fourth-order Runge-Kutta on the same derivative.
export function stepRK4(y, input, geo, groundAt, dt = DT) {
  derivative(y, input, geo, groundAt, k1);
  for (let j = 0; j < N_STATE; j++) tmp[j] = y[j] + 0.5 * dt * k1[j];
  derivative(tmp, input, geo, groundAt, k2);
  for (let j = 0; j < N_STATE; j++) tmp[j] = y[j] + 0.5 * dt * k2[j];
  derivative(tmp, input, geo, groundAt, k3);
  for (let j = 0; j < N_STATE; j++) tmp[j] = y[j] + dt * k3[j];
  derivative(tmp, input, geo, groundAt, k4);
  for (let j = 0; j < N_STATE; j++) y[j] += dt / 6 * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]);
  return y;
}

export const METHODS = Object.freeze({ euler: stepEuler, rk4: stepRK4 });

export function step(y, input, geo, groundAt, method = 'rk4', dt = DT) {
  const f = METHODS[method];
  if (!f) throw new Error(`unknown method: ${method}`);
  return f(y, input, geo, groundAt, dt);
}

// A vehicle standing on the ground at (x, y), facing yaw, centre of mass at its design height.
export function spawn(geo, groundAt, { x = 0, y = 0, yaw = 0 } = {}) {
  const st = new Float64Array(N_STATE);
  st[0] = x; st[1] = y; st[2] = groundAt(x, y) + geo.p.cgHeight; st[5] = yaw;
  return st;
}

// Parked: no throttle and still. A braked vehicle parks below 0.1 m/s (the regularised brake and tyre
// otherwise creep, up to about 0.07 m/s on a 10 % slope for the heavy presets); an unbraked one parks only if it is also not accelerating. Parked means: stop stepping.
const acc = new Float64Array(N_STATE);
export function isParked(y, input, geo, groundAt) {
  if ((input.throttle || 0) > 0) return false;
  const v = Math.hypot(y[6], y[7], y[8]);
  const braked = (input.brake || 0) >= 0.5;
  if (v > (braked ? 0.1 : 0.02)) return false;
  if (Math.abs(y[9]) > 0.01 || Math.abs(y[10]) > 0.01 || Math.abs(y[11]) > 0.01) return false;
  for (let i = 0; i < 4; i++) if (Math.abs(y[12 + i]) * geo.p.wheelRadius > (braked ? 0.1 : 0.02)) return false;
  derivative(y, input, geo, groundAt, acc);
  if (Math.abs(acc[8]) > 0.05 || Math.abs(acc[9]) > 0.05 || Math.abs(acc[10]) > 0.05) return false;
  return braked || Math.hypot(acc[6], acc[7]) < 0.02;
}

// World-body pose for drawing and cameras.
export function pose(y, geo, groundAt) {
  const yaw = y[5], ux = Math.sin(yaw), uy = Math.cos(yaw), rx = Math.cos(yaw), ry = -Math.sin(yaw);
  const ang = steerAngles(geo, 0);
  const wheels = WHEELS.map((name, i) => {
    const s = geo.s[i], l = geo.l[i], wx = y[0] + s * ux + l * rx, wy = y[1] + s * uy + l * ry;
    return { name, x: wx, y: wy, ground: groundAt(wx, wy), spinRate: y[12 + i], steer: ang[i] };
  });
  const tau = 2 * Math.PI;
  return { x: y[0], y: y[1], z: y[2], roll: y[3], pitch: y[4], yaw: ((yaw % tau) + tau) % tau,
    speed: Math.hypot(y[6], y[7]), forwardSpeed: y[6] * ux + y[7] * uy, wheels };
}

// Frame-rate-independent driver for the world: whole fixed steps only, the remainder carried to the next frame.
// advance() does no work while parked, so a parked buggy costs nothing per frame; setInput() wakes it.
export function createDriver({ preset = 'site-buggy', groundAt, x = 0, y = 0, yaw = 0, method = 'rk4', dt = DT } = {}) {
  if (typeof groundAt !== 'function') throw new Error('groundAt(x, y) is required');
  if (!METHODS[method]) throw new Error(`unknown method: ${method}`);
  const geo = geometry(preset);
  const state = spawn(geo, groundAt, { x, y, yaw });
  const input = { throttle: 0, brake: 0, steer: 0, gear: 1 };
  const spin = new Float64Array(4);                   // wheel rotation angles, for drawing only
  const dtUs = Math.round(dt * 1e6), maxUs = Math.round(MAX_FRAME * 1e6);
  let carryUs = 0, ticks = 0, parked = false;       // whole microseconds, so any frame split gives the same steps
  return {
    geo, state, method, dt,
    input: () => ({ ...input }),
    setInput(next = {}) {
      for (const k of ['throttle', 'brake', 'steer', 'gear']) if (k in next) input[k] = next[k];
      parked = false;
    },
    advance(seconds) {
      if (parked) return { steps: 0, moving: false };
      carryUs += Math.min(Math.max(Math.round(seconds * 1e6), 0), maxUs);
      const n = Math.floor(carryUs / dtUs);
      carryUs -= n * dtUs;
      for (let i = 0; i < n; i++) {
        step(state, input, geo, groundAt, method, dt);
        for (let w = 0; w < 4; w++) spin[w] += state[12 + w] * dt;
      }
      ticks += n;
      parked = isParked(state, input, geo, groundAt);
      if (parked) carryUs = 0;
      return { steps: n, moving: !parked };
    },
    parked: () => parked,
    ticks: () => ticks,
    pose() { const q = pose(state, geo, groundAt); steerAngles(geo, input.steer, delta);
      q.wheels.forEach((w, i) => { w.steer = delta[i]; w.spin = spin[i]; }); return q; }
  };
}
