// mount.mjs: getting in and out. The viewer walks up to the buggy and mounts it (X, or B on a gamepad); the camera
// moves to the chase or driver seat. Dismounting sets the walker down beside the driver's door, facing the way the
// buggy faces, and is refused while the buggy is still moving. Pure state: no DOM.

import { bodyToWorld } from './cameras.mjs';

export const MOUNT = Object.freeze({ reach: 3.5, stoppedBelow: 0.5, door: [-1.4, 0.2, 0], eye: 1.7 });

// walker { pos: [x, y, z], yaw, pitch } with pos at eye height; vehicle { pos, yaw, speed }.
export function canMount(walker, vehicle) {
  const d = Math.hypot(walker.pos[0] - vehicle.pos[0], walker.pos[1] - vehicle.pos[1]);
  if (d > MOUNT.reach) return { ok: false, reason: `walk closer to the buggy (${d.toFixed(1)} m away, reach ${MOUNT.reach} m)` };
  return { ok: true, reason: '' };
}
export function canDismount(vehicle) {
  const v = Math.abs(vehicle.speed || 0);
  if (v >= MOUNT.stoppedBelow) return { ok: false, reason: `stop first (${(v * 3.6).toFixed(0)} km/h)` };
  return { ok: true, reason: '' };
}

// Where the walker stands after getting out. groundAt(x, y) gives the ground height when known.
export function dismountPose(vehicle, groundAt = null) {
  const p = bodyToWorld(vehicle, MOUNT.door);
  const g = groundAt ? groundAt(p[0], p[1]) : NaN;
  const z = (Number.isFinite(g) ? g : vehicle.pos[2]) + MOUNT.eye;
  return { pos: [p[0], p[1], z], yaw: vehicle.yaw, pitch: 0 };
}

// The state machine: 'walk' or 'drive'. toggle() tries to change state and returns { ok, mode, reason, walker }.
export function createMount({ mode = 'walk', groundAt = null } = {}) {
  return {
    get mode() { return mode; },
    toggle(walker, vehicle) {
      if (mode === 'walk') {
        const c = canMount(walker, vehicle);
        if (!c.ok) return { ok: false, mode, reason: c.reason };
        mode = 'drive';
        return { ok: true, mode, reason: '' };
      }
      const c = canDismount(vehicle);
      if (!c.ok) return { ok: false, mode, reason: c.reason };
      mode = 'walk';
      return { ok: true, mode, reason: '', walker: dismountPose(vehicle, groundAt) };
    }
  };
}
