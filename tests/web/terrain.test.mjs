// Unit tests for terrain.mjs. Run: node --test web/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../../src/web/terrain/terrain.mjs';

// A tile on the plane z = 10 + 0.05 x - 0.02 y (metres, BNG e/n = local x/y with origin 0).
export function planeTile(e0, n0, samples = 9, spacing = 2, f = (x, y) => 10 + 0.05 * x - 0.02 * y) {
  const q = new Uint16Array(samples * samples), baseCm = 0;
  for (let j = 0; j < samples; j++) for (let i = 0; i < samples; i++) q[j * samples + i] = Math.round(f(e0 + i * spacing, n0 + j * spacing) * 100) - baseCm;
  return { samples, spacing, e0, n0, baseCm, q };
}
const plane = (x, y) => 10 + 0.05 * x - 0.02 * y;
const near = (a, b, tol = 0.006) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('bilinear heights reproduce a plane inside, on edges and corners of a 2 x 2 tile block', () => {
  const tiles = [planeTile(0, 0), planeTile(16, 0), planeTile(0, 16), planeTile(16, 16)];
  const h = T.createHeightField(tiles);
  for (const [x, y] of [[3.3, 7.1], [16, 5], [16, 16], [0, 0], [32, 32], [31.99, 0.01], [8, 16]]) near(h(x, y), plane(x, y));
  assert.ok(Number.isNaN(h(-0.1, 5)) && Number.isNaN(h(5, 32.1)));
});

test('the answer does not depend on tile order; the finer tile wins', () => {
  const coarse = planeTile(0, 0, 5, 8, () => 1), fine = planeTile(0, 0, 9, 2, () => 2);
  assert.equal(T.createHeightField([coarse, fine])(3, 3), T.createHeightField([fine, coarse])(3, 3));
  near(T.createHeightField([coarse, fine])(3, 3), 2);
  near(T.createHeightField([coarse, fine])(20, 20), 1);
});

test('no data: NaN where a weighted node is missing, a zero-weight node is ignored, the next tile fills in', () => {
  const t = planeTile(0, 0); t.q[0] = T.NODATA;
  assert.ok(Number.isNaN(T.sampleTile(t, 1, 1)));
  near(T.sampleTile(t, 2, 1), plane(2, 1));                 // on the edge x = 2, node (0, 0) has zero weight
  const under = planeTile(0, 0, 5, 4);
  near(T.createHeightField([t, under])(1, 1), plane(1, 1));   // the coarser tile answers where the finer has a hole
});

test('normals: plane normal inside, one-sided at the survey edge, flagged where unknown', () => {
  const h = T.createHeightField([planeTile(0, 0)]);
  const L = Math.hypot(0.05, 0.02, 1);
  for (const [x, y] of [[8, 8], [0, 8], [16, 16]]) {
    const { normal, known } = T.normalAt(h, x, y);
    assert.ok(known); near(normal[0], -0.05 / L, 1e-3); near(normal[1], 0.02 / L, 1e-3); near(normal[2], 1 / L, 1e-3);
  }
  assert.equal(T.normalAt(h, 50, 50).known, false);
  assert.deepEqual(T.normalAt(h, 50, 50).normal, [0, 0, 1]);
});

test('surfaces: priority, roads over water, tracks ford, grids and areas', () => {
  const s = T.createSurfaceIndex({
    ways: [{ class: 'minor', pts: [[0, 0], [100, 0]] }, { class: 'track', pts: [[0, 40], [100, 40]] }],
    water: [{ pts: [[50, -50], [50, 90]] }],
    areas: [{ surface: 'soft', rings: [[[70, 10], [90, 10], [90, 30], [70, 30]]] }],
    grids: [{ surface: 'wet', x0: 0, y0: 10, spacing: 5, cols: 4, rows: 4, values: new Uint8Array(16).fill(9), test: v => v >= 8 }],
  });
  assert.equal(s(20, 1).surface, 'tarmac');
  assert.equal(s(50, 0).surface, 'tarmac');                   // bridge or culvert assumed
  assert.equal(s(50, 40).surface, 'water');                   // a track fords
  assert.equal(s(50, 40).note, T.WATER_NOTE);
  assert.equal(s(20, 40.5).surface, 'gravel');
  assert.equal(s(80, 20).surface, 'soft');
  assert.equal(s(5, 15).surface, 'wet');
  assert.equal(s(30, 70).surface, 'grass');
  assert.ok(T.isSoftDeposit('Peat') && T.isSoftDeposit('ALLUVIUM - CLAY, SILT') && !T.isSoftDeposit('TILL'));
});

test('sinkage: exact form equals the classic one at n = 1, is deeper at n = 0.5, rigid surfaces do not sink', () => {
  const wheel = { load: 2000, width: 0.2, diameter: 0.6 };
  const one = T.wheelOnGround(wheel, { mu: 0.5, crr: 0.05, soil: { n: 1, kc: 10e3, kphi: 500e3 } });
  near(one.sinkage, one.classicSinkage, 1e-12);
  const soft = T.wheelOnGround(wheel, T.SURFACES.soft), wet = T.wheelOnGround(wheel, T.SURFACES.wet), grass = T.wheelOnGround(wheel, T.SURFACES.grass);
  assert.ok(soft.sinkage > wet.sinkage && wet.sinkage > grass.sinkage && grass.sinkage > 0);
  assert.ok(soft.sinkage > soft.classicSinkage && soft.sinkage / soft.classicSinkage < 1.1);
  assert.ok(soft.crrEffective > T.SURFACES.soft.crr);
  assert.equal(T.wheelOnGround(wheel, T.SURFACES.tarmac).sinkage, 0);
  // Force balance holds: W = b k sqrt(D)/2 B(n+1, 1/2) z0^(n+1/2).
  const { n, kc, kphi } = T.SURFACES.soft.soil, k = kc / 0.2 + kphi;
  near(0.2 * k * Math.sqrt(0.6) / 2 * T.betaHalf(n) * Math.pow(soft.sinkage, n + 0.5), 2000, 1e-6);
  near(T.betaHalf(0.5), Math.PI / 2, 1e-12);
  near(T.betaHalf(1), 4 / 3, 1e-12);
});

test('solids: sphere against boxes, from outside and from inside, nearest face', () => {
  const idx = T.createSolidIndex([{ min: [0, 0, 0], max: [2, 1, 1.2] }, { min: [10, 10, 0], max: [11, 11, 2] }]);
  const a = idx.sphere([2.3, 0.5, 0.5], 0.4);
  assert.ok(a.hit); near(a.depth, 0.1, 1e-12); assert.deepEqual(a.normal, [1, 0, 0]); assert.equal(a.solid, 0);
  const b = idx.sphere([1.9, 0.5, 0.6], 0.3);
  assert.deepEqual(b.normal, [1, 0, 0]); near(b.depth, 0.4, 1e-12);
  assert.equal(idx.sphere([5, 5, 0.5], 1).hit, false);
  assert.ok(idx.sphere([10.5, 10.5, 2.2], 0.25).hit);
  assert.equal(idx.spheres([{ c: [5, 5, 5], r: 1 }, { c: [2.3, 0.5, 0.5], r: 0.4 }]).map(h => h.hit).join(), 'false,true');
});

test('the cartridge: contact is deterministic and carries surface, slope and sinkage', () => {
  const make = () => T.createTerrain({ tiles: [planeTile(0, 0)], layers: { water: [{ pts: [[8, 0], [8, 16]] }] } });
  const wheel = { load: 1500, width: 0.22, diameter: 0.58 };
  const a = make().contact(3.21, 4.56, wheel), b = make().contact(3.21, 4.56, wheel);
  assert.deepEqual(a, b);
  assert.ok(a.known && a.surface === 'grass' && a.sinkage > 0);
  near(a.ground, plane(3.21, 4.56));
  const w = make().contact(8.4, 5, wheel);
  assert.ok(w.water && w.note === T.WATER_NOTE);
  const world = T.createTerrain({ heightAt: plane });           // the world passes its own ground
  near(world.contact(100, 200).ground, plane(100, 200), 1e-12);
});
