// CPU witness for the terrain pair check: runs the web module (the one the world imports) on the pair's
// fixture and photons and prints its answers as JSON. Usage: node tools/js_witness.mjs <fixture.json>
import { readFileSync } from 'node:fs';
import * as T from '../src/web/terrain/terrain.mjs';

const fx = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const tiles = fx.tiles.map(t => ({ ...t, q: Uint16Array.from(t.q) }));
const grids = (fx.layers.grids || []).map(g => ({ ...g, values: Uint8Array.from(g.values), test: v => v >= g.min }));
const terrain = T.createTerrain({ tiles, layers: { ...fx.layers, grids }, solids: fx.solids });
const num = v => (Number.isFinite(v) ? v : null);
const out = { heights: [], normals: [], known: [], surfaces: [], sinkage: {}, spheres: [], constants: { SURFACES: T.SURFACES, PRIORITY: T.PRIORITY } };
for (const [x, y] of fx.photons) {
  const c = terrain.contact(x, y);
  out.heights.push(num(c.ground)); out.normals.push(c.normal); out.known.push(c.known); out.surfaces.push(c.surface);
}
for (const name of fx.soils) {
  out.sinkage[name] = fx.loads.map(load => T.wheelOnGround({ load, width: fx.wheel.width, diameter: fx.wheel.diameter }, T.SURFACES[name]).sinkage);
}
for (const s of fx.spheres) {
  const h = terrain.sphere(s.c, s.r);
  out.spheres.push(h.hit ? { depth: h.depth, normal: h.normal, solid: h.solid } : { depth: 0, normal: [0, 0, 0], solid: -1 });
}
process.stdout.write(JSON.stringify(out));
