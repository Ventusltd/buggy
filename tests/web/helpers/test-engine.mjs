// A stand-in vehicle engine for testing the feel layer only: a kinematic bicycle on flat ground with simple
// longitudinal forces. It is NOT the buggy's physics (that is the vehicle cartridge); it only honours the same
// contract: { id, dt, step(state, input, dt) -> new state } with state { pos, yaw, pitch, roll, speed }.

export const WHEELBASE = 2.2, MAX_STEER = 0.6;

export function createTestEngine({ dt = 1 / 120, pitch = 0 } = {}) {
  return {
    id: 'test-bicycle.v1',
    dt,
    step(s, u, h) {
      const accel = 3.0 * u.drive;
      const drag = 0.05 * s.speed + 0.02 * s.speed * Math.abs(s.speed);
      const stopping = 6.0 * u.brake + (u.handbrake ? 4.0 : 0) + 0.15; // 0.15 m/s2 rolling resistance
      let v = s.speed + (accel - drag) * h;
      const dv = stopping * h;
      v = Math.abs(v) <= dv ? 0 : v - Math.sign(v) * dv;
      const yawRate = (v / WHEELBASE) * Math.tan(u.steer * MAX_STEER);
      const yaw = s.yaw + yawRate * h;
      return {
        pos: [s.pos[0] + Math.sin(yaw) * v * h, s.pos[1] + Math.cos(yaw) * v * h, s.pos[2]],
        yaw, pitch, roll: 0, speed: v
      };
    }
  };
}

export const rest = (x = 0, y = 0, yaw = 0) => ({ pos: [x, y, 0], yaw, pitch: 0, roll: 0, speed: 0 });

// A fake frame gate and requestAnimationFrame clock, to count frames drawn without a browser.
export function fakeGate() {
  const g = { moving: false, fps: 0, calls: [], invalidate() {}, setMoving(on, fps) { g.moving = on; if (fps) g.fps = fps; g.calls.push(on); } };
  return g;
}
