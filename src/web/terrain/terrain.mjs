// terrain.mjs: the buggy's ground. Heights and normals at wheel contacts from LiDAR terrain tiles, the surface
// under each wheel from open-data layers (friction, rolling resistance), soft-ground sinkage, water crossings
// and collision with solids (tables, fences, compounds). Pure: no imports, no DOM, no timers, no randomness.
// Every call is a function of its arguments, so a fixed-step integrator stays deterministic, and nothing runs
// while the buggy is parked.
//
// Units: local metres, x east, y north, z up. Loads in newtons.
//
// The world imports this module as a cartridge and passes its own ground in:
//   createTerrain({ heightAt })            the world's heightAt(x, y) (its terrain layer, NaN where unknown)
//   createTerrain({ tiles, origin })       or tiles in the terrain-tile shape, for standalone use and tests
// so heights are never sampled two ways. Surfaces and solids come in as plain data (see createSurfaceIndex and
// createSolidIndex).
//
// EVERY FRICTION, ROLLING-RESISTANCE AND SOIL VALUE BELOW IS TYPICAL OR ILLUSTRATIVE, NOT MEASURED. The sinkage
// model is a simple pressure-sinkage (Bekker-style) model for a rigid wheel: illustrative, not a site assessment.

export const NODATA = 0xffff;
export const ILLUSTRATIVE = 'illustrative values, not measured at this site';
export const WATER_NOTE = 'water crossing: depth not surveyed';

// ---------------------------------------------------------------------------------------------------------
// Surfaces. mu: peak tyre-ground friction coefficient (typical). crr: tyre rolling-resistance coefficient
// (typical, hysteresis only). soil: pressure-sinkage parameters p = (kc / b + kphi) * z^n, SI units
// (kc in N/m^(n+1), kphi in N/m^(n+2)); null means the surface is treated as rigid. All illustrative.
export const SURFACES = Object.freeze({
  tarmac: Object.freeze({ mu: 0.85, crr: 0.015, soil: null }),
  gravel: Object.freeze({ mu: 0.60, crr: 0.030, soil: null }),
  grass:  Object.freeze({ mu: 0.50, crr: 0.050, soil: Object.freeze({ n: 0.6, kc: 30e3, kphi: 2000e3 }) }),
  wet:    Object.freeze({ mu: 0.35, crr: 0.060, soil: Object.freeze({ n: 0.5, kc: 13e3, kphi: 692e3 }) }),
  soft:   Object.freeze({ mu: 0.25, crr: 0.080, soil: Object.freeze({ n: 0.5, kc: 2e3, kphi: 200e3 }) }),
  water:  Object.freeze({ mu: 0.20, crr: 0.150, soil: Object.freeze({ n: 0.5, kc: 2e3, kphi: 200e3 }) }),
});
// When layers overlap, the first in this list wins. Assumed: a sealed road crosses water on a bridge or culvert,
// an unsealed track may ford it, and a made surface (road, track) bridges wet or soft ground beneath it.
export const PRIORITY = Object.freeze(['tarmac', 'water', 'gravel', 'soft', 'wet', 'grass']);
export const DEFAULT_SURFACE = 'grass';

// Way classes (as the ways layer names them) -> surface. Assumed: public roads are sealed, tracks are not.
export const WAY_SURFACE = Object.freeze({ motorway: 'tarmac', A: 'tarmac', B: 'tarmac', minor: 'tarmac', local: 'tarmac', track: 'gravel' });
export const DEFAULT_WAY_WIDTH = Object.freeze({ motorway: 11, A: 7.3, B: 6.5, minor: 5.5, local: 4.8, track: 3 });
export const WATER_LINE_WIDTH_M = 2;   // assumed width of a watercourse centreline with no width given

// Superficial deposit names that suggest soft ground (keywords, case-insensitive). A hint for a desktop study only.
export const SOFT_DEPOSITS = Object.freeze(['PEAT', 'ALLUVIUM', 'LACUSTRINE', 'TIDAL FLAT', 'MARINE BEACH']);
export const isSoftDeposit = name => SOFT_DEPOSITS.some(k => String(name || '').toUpperCase().includes(k));

// ---------------------------------------------------------------------------------------------------------
// Heights. Tile shape (as the world's terrain layer decodes it): { samples, spacing, e0, n0, baseCm, q } with
// q a Uint16Array of samples * samples, rows south to north, height = (baseCm + q) / 100, q = NODATA no data.
// Neighbouring tiles share their edge row and column.

// Bilinear height at (u, v) metres from the tile's south-west node. NaN outside, or where a weighted node has
// no data. Weights form (the electron); the positron in the Python pair uses lerp-of-lerps.
export function sampleTile(t, u, v) {
  const s = t.samples - 1, gx = u / t.spacing, gy = v / t.spacing;
  if (!(gx >= 0 && gy >= 0 && gx <= s && gy <= s)) return NaN;
  const i = Math.min(Math.floor(gx), s - 1), j = Math.min(Math.floor(gy), s - 1);
  const fx = gx - i, fy = gy - j, n = t.samples, k = j * n + i;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
  const q00 = t.q[k], q10 = t.q[k + 1], q01 = t.q[k + n], q11 = t.q[k + n + 1];
  // A node with zero weight may lack data without spoiling the sample (a point on a cell edge).
  if ((w00 && q00 === NODATA) || (w10 && q10 === NODATA) || (w01 && q01 === NODATA) || (w11 && q11 === NODATA)) return NaN;
  const sum = (w00 ? w00 * q00 : 0) + (w10 ? w10 * q10 : 0) + (w01 ? w01 * q01 : 0) + (w11 ? w11 * q11 : 0);
  return (t.baseCm + sum) / 100;
}

// heightAt over many tiles. origin = [e, n] of local (0, 0). The finest tile holding the point wins; ties go to
// the tile with the lowest e0, then n0, so the answer never depends on load order. On a shared edge both tiles
// hold the same nodes, so either gives the same height.
export function createHeightField(tiles, origin = [0, 0]) {
  const list = tiles.map(t => ({ t, x0: t.e0 - origin[0], y0: t.n0 - origin[1], size: (t.samples - 1) * t.spacing }))
    .sort((a, b) => a.t.spacing - b.t.spacing || a.t.e0 - b.t.e0 || a.t.n0 - b.t.n0);
  return function heightAt(x, y) {
    for (const r of list) {
      if (x < r.x0 || y < r.y0 || x > r.x0 + r.size || y > r.y0 + r.size) continue;
      const h = sampleTile(r.t, x - r.x0, y - r.y0);
      if (Number.isFinite(h)) return h;
    }
    return NaN;
  };
}

// Unit ground normal by central differences over step h (default 1 m: smooth across cell edges). Where one side
// has no data, a one-sided difference is used; where neither side has, that slope component is taken as 0 and
// known is false.
export function normalAt(heightAt, x, y, h = 1) {
  const c = heightAt(x, y);
  const d = (a, b, span) => (Number.isFinite(a) && Number.isFinite(b) ? (a - b) / span : NaN);
  const e = heightAt(x + h, y), w = heightAt(x - h, y), n = heightAt(x, y + h), s = heightAt(x, y - h);
  let gx = d(e, w, 2 * h), gy = d(n, s, 2 * h), known = Number.isFinite(c);
  if (!Number.isFinite(gx)) gx = Number.isFinite(e) ? d(e, c, h) : d(c, w, h);
  if (!Number.isFinite(gy)) gy = Number.isFinite(n) ? d(n, c, h) : d(c, s, h);
  if (!Number.isFinite(gx)) { gx = 0; known = false; }
  if (!Number.isFinite(gy)) { gy = 0; known = false; }
  const L = Math.hypot(gx, gy, 1);
  return { normal: [0 - gx / L, 0 - gy / L, 1 / L], slopeDeg: Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI, known };
}

// ---------------------------------------------------------------------------------------------------------
// Surfaces from open data. layers (all optional, local metres):
//   ways:  [{ class, width_m?, pts: [[x, y], ...] }]          roads and tracks (centrelines)
//   water: [{ width_m?, pts }] lines and/or [{ rings }] areas  watercourses and water bodies
//   areas: [{ surface, rings: [[[x, y], ...], ...] }]           e.g. soft from superficial deposits, wet hollows
//   grids: [{ surface, x0, y0, spacing, cols, rows, values, test }] cell-centred rasters; test(v) true = surface
//          (e.g. flow accumulation class at or above a threshold -> 'wet'; a hollow mask -> 'wet')
// cell: spatial-hash cell size for lines and areas, metres.
export function createSurfaceIndex(layers = {}, { cell = 16 } = {}) {
  const hash = new Map(), items = [];
  const key = (i, j) => i * 73856093 ^ j * 19349663;
  const add = (it, x0, y0, x1, y1) => {
    const id = items.push(it) - 1;
    for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++)
      for (let j = Math.floor(y0 / cell); j <= Math.floor(y1 / cell); j++) {
        const k = key(i, j); let b = hash.get(k); if (!b) hash.set(k, b = []); b.push(id);
      }
  };
  const line = (surface, pts, half) => {
    for (let s = 1; s < pts.length; s++) {
      const [ax, ay] = pts[s - 1], [bx, by] = pts[s];
      add({ kind: 'seg', surface, ax, ay, bx, by, half }, Math.min(ax, bx) - half, Math.min(ay, by) - half, Math.max(ax, bx) + half, Math.max(ay, by) + half);
    }
  };
  const area = (surface, rings) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rings) for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    if (x0 <= x1) add({ kind: 'area', surface, rings }, x0, y0, x1, y1);
  };
  for (const w of layers.ways || []) {
    const surface = WAY_SURFACE[w.class]; if (!surface) continue;
    line(surface, w.pts, (w.width_m || DEFAULT_WAY_WIDTH[w.class]) / 2);
  }
  for (const w of layers.water || []) {
    if (w.rings) area('water', w.rings); else line('water', w.pts, (w.width_m || WATER_LINE_WIDTH_M) / 2);
  }
  for (const a of layers.areas || []) if (SURFACES[a.surface]) area(a.surface, a.rings);
  const grids = (layers.grids || []).filter(g => SURFACES[g.surface]);
  const rank = s => PRIORITY.indexOf(s);

  // Surface under (x, y): { surface, ...SURFACES[surface], water, note }.
  return function surfaceAt(x, y) {
    let best = DEFAULT_SURFACE;
    const take = s => { if (rank(s) < rank(best)) best = s; };
    for (const id of hash.get(key(Math.floor(x / cell), Math.floor(y / cell))) || []) {
      const it = items[id];
      if (rank(it.surface) >= rank(best)) continue;
      if (it.kind === 'seg' ? segDist(it, x, y) <= it.half : inRings(it.rings, x, y)) take(it.surface);
    }
    for (const g of grids) {
      if (rank(g.surface) >= rank(best)) continue;
      const i = Math.floor((x - g.x0) / g.spacing), j = Math.floor((y - g.y0) / g.spacing);
      if (i >= 0 && j >= 0 && i < g.cols && j < g.rows && g.test(g.values[j * g.cols + i])) take(g.surface);
    }
    const water = best === 'water';
    return { surface: best, ...SURFACES[best], water, note: water ? WATER_NOTE : ILLUSTRATIVE };
  };
}

function segDist({ ax, ay, bx, by }, x, y) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

// Even-odd rule over all rings (outer and holes alike).
export function inRings(rings, x, y) {
  let inside = false;
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------------------------------------
// Sinkage of a rigid wheel (illustrative). With p = k z^n, k = kc / b + kphi, and the contact arc taken as
// x^2 = D (z0 - z), the vertical force balance W = b * integral of p dx over the arc gives exactly
//   W = b k sqrt(D) / 2 * B(n + 1, 1/2) * z0^(n + 1/2)
// so z0 = (2 W / (b k sqrt(D) B(n + 1, 1/2)))^(2 / (2n + 1)). The classic closed form replaces 2 / B with
// 3 / (3 - n) (equal at n = 1, about 6 per cent lower at n = 0.5); it is returned as classicSinkage for
// comparison only. Compaction resistance Rc = b k z0^(n+1) / (n+1).
export function lnGamma(x) {                     // Lanczos, g = 7, n = 9; x > 0
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1; let a = c[0]; const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
export const betaHalf = n => Math.exp(lnGamma(n + 1) + lnGamma(0.5) - lnGamma(n + 1.5));

// wheel: { load (N, vertical, >= 0), width (m), diameter (m) }. surface: an entry of SURFACES (or surfaceAt's
// result). Returns { sinkage, classicSinkage, compaction (N), rolling (N), crrEffective, mu, illustrative }.
export function wheelOnGround({ load, width, diameter }, surface) {
  const W = Math.max(0, load), soil = surface.soil, rolling0 = surface.crr * W;
  if (!soil || W === 0) return { sinkage: 0, classicSinkage: 0, compaction: 0, rolling: rolling0, crrEffective: surface.crr, mu: surface.mu, illustrative: ILLUSTRATIVE };
  const { n, kc, kphi } = soil, k = kc / width + kphi, sD = Math.sqrt(diameter), ex = 2 / (2 * n + 1);
  const z0 = Math.pow(2 * W / (width * k * sD * betaHalf(n)), ex);
  const zc = Math.pow(3 * W / ((3 - n) * width * k * sD), ex);
  const Rc = width * k * Math.pow(z0, n + 1) / (n + 1);
  return { sinkage: z0, classicSinkage: zc, compaction: Rc, rolling: rolling0 + Rc, crrEffective: surface.crr + Rc / W, mu: surface.mu, illustrative: ILLUSTRATIVE };
}

// ---------------------------------------------------------------------------------------------------------
// Solids: axis-aligned boxes { min: [x, y, z], max: [x, y, z], ...tags } as the world's fence, table and canopy
// modules make them. Indexed on a plan grid so a query touches only nearby boxes.
export function createSolidIndex(solids = [], { cell = 8 } = {}) {
  const hash = new Map(), key = (i, j) => i * 73856093 ^ j * 19349663;
  solids.forEach((s, id) => {
    for (let i = Math.floor(s.min[0] / cell); i <= Math.floor(s.max[0] / cell); i++)
      for (let j = Math.floor(s.min[1] / cell); j <= Math.floor(s.max[1] / cell); j++) {
        const k = key(i, j); let b = hash.get(k); if (!b) hash.set(k, b = []); b.push(id);
      }
  });
  // Deepest contact of a sphere (centre c, radius r) with any box: { hit, depth, normal, point, solid } or
  // { hit: false }. normal points out of the box towards the sphere centre. Ties go to the lowest solid index.
  function sphere(c, r) {
    const seen = new Set(); let best = null;
    for (let i = Math.floor((c[0] - r) / cell); i <= Math.floor((c[0] + r) / cell); i++)
      for (let j = Math.floor((c[1] - r) / cell); j <= Math.floor((c[1] + r) / cell); j++)
        for (const id of hash.get(key(i, j)) || []) {
          if (seen.has(id)) continue; seen.add(id);
          const h = sphereBox(c, r, solids[id]);
          if (h && (!best || h.depth > best.depth || (h.depth === best.depth && id < best.solid))) best = { ...h, solid: id };
        }
    return best ? { hit: true, ...best } : { hit: false };
  }
  return { sphere, spheres: list => list.map(s => sphere(s.c, s.r)), count: solids.length };
}

export function sphereBox(c, r, { min, max }) {
  const p = [0, 1, 2].map(a => Math.min(Math.max(c[a], min[a]), max[a]));
  const d = [c[0] - p[0], c[1] - p[1], c[2] - p[2]], dist = Math.hypot(d[0], d[1], d[2]);
  if (dist > 0) return dist < r ? { depth: r - dist, normal: d.map(v => v / dist), point: p } : null;
  // Centre inside the box: push out through the nearest face.
  let axis = 0, sign = 1, least = Infinity;
  for (let a = 0; a < 3; a++) {
    const lo = c[a] - min[a], hi = max[a] - c[a];
    if (lo < least) { least = lo; axis = a; sign = -1; }
    if (hi < least) { least = hi; axis = a; sign = 1; }
  }
  const normal = [0, 0, 0]; normal[axis] = sign;
  return { depth: least + r, normal, point: p };
}

// ---------------------------------------------------------------------------------------------------------
// The cartridge: one object the chassis integrator calls each fixed step.
//   createTerrain({ heightAt | tiles + origin, layers?, solids?, normalStep? })
//   .contact(x, y, wheel?) -> { known, ground, normal, slopeDeg, surface, mu, crr, water, note, sinkage, rolling, ... }
//   .collide(spheres)      -> per sphere { hit, depth, normal, point, solid }
export function createTerrain({ heightAt, tiles, origin = [0, 0], layers = {}, solids = [], normalStep = 1 } = {}) {
  const hAt = heightAt || createHeightField(tiles || [], origin);
  const surfaceAt = createSurfaceIndex(layers);
  const solidIndex = createSolidIndex(solids);
  function contact(x, y, wheel = null) {
    const ground = hAt(x, y), nrm = normalAt(hAt, x, y, normalStep), s = surfaceAt(x, y);
    const out = { known: Number.isFinite(ground) && nrm.known, ground, normal: nrm.normal, slopeDeg: nrm.slopeDeg,
      surface: s.surface, mu: s.mu, crr: s.crr, water: s.water, note: s.note };
    return wheel ? { ...out, ...wheelOnGround(wheel, s) } : out;
  }
  return { heightAt: hAt, normalAt: (x, y) => normalAt(hAt, x, y, normalStep), surfaceAt, contact,
    collide: list => solidIndex.spheres(list), sphere: solidIndex.sphere };
}
