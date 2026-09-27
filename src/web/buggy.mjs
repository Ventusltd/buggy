// buggy.mjs: the one entry point the world imports. Dependency-free ES module, no DOM, no timers.
//
//   import { createVehicleCartridge, createTerrain, createDriveSession } from './buggy/buggy.mjs';
//   const terrain = createTerrain({ heightAt });                        // the world's own ground, sampled one way only
//   const engine  = createVehicleCartridge({ preset: 'site-buggy', groundAt: terrain.heightAt });
//   const session = createDriveSession({ engine, state: engine.spawn({ x, y, yaw }), gate, raw, groundAt: terrain.heightAt });
//
// createVehicleCartridge adapts the four-contact rigid body (engine/vehicle-dynamics.mjs, 1 ms steps) to the feel
// layer's vehicle contract { id, dt, step(state, input, dt) -> state, atRest(state) }. One cartridge step is a whole
// number of 1 ms physics steps, so the physics stays bit-exact for the same inputs whatever the frame rate.
// Input mapping (feel -> dynamics): drive > 0 throttle forwards, drive < 0 throttle in reverse gear,
// brake and handbrake both apply the service brake (the dynamics model has one brake).
// Hold: with no throttle and the vehicle below HOLD_SPEED, the brake is applied (an automatic park brake, as utility
// vehicles have), so a buggy left on a slope stays put and the session can park it at 0 frames per second.

import { DT, N_STATE, geometry, spawn, step, isParked, pose } from './engine/vehicle-dynamics.mjs';

export * as dynamics from './engine/vehicle-dynamics.mjs';
export { PRESETS, PRESET_NAMES } from './engine/vehicle-presets.mjs';
export { createTerrain } from './terrain/terrain.mjs';
export { createDriveSession } from './feel/drive-session.mjs';
export { attachControls } from './feel/controls.mjs';
export * as access from './access/access-checks.mjs';

export const CARTRIDGE_VERSION = '20260927.01';
export const HOLD_SPEED = 0.3; // m/s, below this an idle vehicle is held on the brake

// Feel-layer input -> dynamics input.
export function toDynamicsInput(u = {}) {
  const drive = Math.max(-1, Math.min(1, u.drive || 0));
  return {
    throttle: Math.abs(drive),
    gear: drive < 0 ? -1 : 1,
    brake: Math.max(0, Math.min(1, Math.max(u.brake || 0, u.handbrake ? 1 : 0))),
    steer: Math.max(-1, Math.min(1, u.steer || 0))
  };
}

export function createVehicleCartridge({ preset = 'site-buggy', groundAt, subSteps = 8, method = 'rk4' } = {}) {
  if (typeof groundAt !== 'function') throw new Error('groundAt(x, y) is required');
  if (!(Number.isInteger(subSteps) && subSteps >= 1)) throw new Error('subSteps must be a whole number >= 1');
  const geo = geometry(preset);
  const dt = subSteps * DT;

  // The feel layer's state is a plain object; the full 16-number physics state rides along as `y`.
  function view(y, lastInput) {
    const q = pose(y, geo, groundAt);
    return { pos: [q.x, q.y, q.z], yaw: q.yaw, pitch: q.pitch, roll: q.roll, speed: q.forwardSpeed,
      y, input: lastInput, preset };
  }
  // A state without `y` (a recorded drive's start, or one the world moved) is rebuilt: standing on the ground at pos,
  // moving at `speed` along its heading. A state whose pos was shifted (the world moved its origin) is shifted to match.
  function vector(s) {
    if (s && s.y instanceof Float64Array && s.y.length === N_STATE) {
      const y = Float64Array.from(s.y);
      if (s.pos && (s.pos[0] !== y[0] || s.pos[1] !== y[1])) {
        const q = pose(y, geo, groundAt);
        y[0] += s.pos[0] - q.x; y[1] += s.pos[1] - q.y;
      }
      return y;
    }
    const p = (s && s.pos) || [0, 0, 0], yaw = (s && s.yaw) || 0, v = (s && s.speed) || 0;
    const y = spawn(geo, groundAt, { x: p[0], y: p[1], yaw });
    y[6] = v * Math.sin(yaw); y[7] = v * Math.cos(yaw);
    for (let i = 0; i < 4; i++) y[12 + i] = v / geo.p.wheelRadius;
    return y;
  }

  return {
    id: `buggy-dynamics.${preset}.${method}.v${CARTRIDGE_VERSION}`,
    dt,
    preset,
    geo,
    spawn({ x = 0, y = 0, yaw = 0 } = {}) { return view(spawn(geo, groundAt, { x, y, yaw }), toDynamicsInput()); },
    step(state, input, h = dt) {
      if (Math.abs(h - dt) > 1e-12) throw new Error(`this cartridge steps in ${dt} s, not ${h} s`);
      const y = vector(state), u = toDynamicsInput(input);
      if (!u.throttle && Math.abs((state && state.speed) || 0) < HOLD_SPEED) u.brake = 1;
      for (let i = 0; i < subSteps; i++) step(y, u, geo, groundAt, method, DT);
      return view(y, u);
    },
    atRest(state) {
      const y = vector(state);
      return isParked(y, state.input || toDynamicsInput(), geo, groundAt);
    }
  };
}
