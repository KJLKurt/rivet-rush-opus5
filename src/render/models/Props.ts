/**
 * Rivet Rush — the environment kit and collectible models.
 *
 * Everything here is built from Three.js primitives at runtime: no external
 * models, no downloads. The rules the whole kit follows:
 *
 *  - 1 world unit ≈ 1 metre. Rivet is ~1.4 units tall, so a crate is ~1 unit and
 *    a tree is ~4. Every platform is authored with its walkable surface at y = 0,
 *    and every prop stands on y = 0 (its origin is at its feet).
 *  - Static sub-parts are merged per material with `mergeGeometries`, so a prop
 *    is normally 1–3 draw calls and tens-to-a-few-hundred triangles.
 *  - Geometry and materials come from the shared caches in Materials.ts, so
 *    building the same prop fifty times costs almost nothing extra.
 *  - Every builder tags `userData.propKind`, and anything the game animates is
 *    exposed through `userData` (`spinner`, `field`, `disc`, …).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PAL } from '../Palette';
import { getTexture, getTextureTiled } from '../Textures';
import type { TextureKey } from '../Textures';
import { toonMat, glowMat, spriteMat, roundedBoxGeometry, cacheGeometry } from '../Materials';

export type PropTheme = 'scrapyard' | 'gardens' | 'stormworks' | 'finale';

type V3 = [number, number, number];

const TAU = Math.PI * 2;
const HALF_PI = Math.PI * 0.5;

// ---------------------------------------------------------------------------
// deterministic randomness
// ---------------------------------------------------------------------------

/**
 * Deterministic tiny PRNG (mulberry32). Props look hand-placed but rebuild
 * identically every run, so a seeded arena always looks the same.
 */
export function propRandom(seed: number): () => number {
  let a = (seed | 0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `rand` in [lo, hi). */
function rr(r: () => number, lo: number, hi: number): number {
  return lo + r() * (hi - lo);
}

// ---------------------------------------------------------------------------
// cached geometry helpers
// ---------------------------------------------------------------------------

const k = (n: number): string => n.toFixed(3);

/** Chunky rounded box — the workhorse shape of the whole kit. */
function gBox(w: number, h: number, d: number, radius = 0.06, segments = 1): THREE.BufferGeometry {
  return roundedBoxGeometry(w, h, d, radius, segments);
}

function gCyl(rt: number, rb: number, h: number, seg = 12, open = false): THREE.BufferGeometry {
  return cacheGeometry(`cy|${k(rt)}|${k(rb)}|${k(h)}|${seg}|${open ? 1 : 0}`,
    () => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open));
}

function gSph(radius: number, w = 10, h = 7): THREE.BufferGeometry {
  return cacheGeometry(`sp|${k(radius)}|${w}|${h}`, () => new THREE.SphereGeometry(radius, w, h));
}

/** Low-poly faceted ball — reads as a stylized rock / leaf clump. */
function gIco(radius: number, detail = 0): THREE.BufferGeometry {
  return cacheGeometry(`ic|${k(radius)}|${detail}`, () => new THREE.IcosahedronGeometry(radius, detail));
}

function gTorus(radius: number, tube: number, rad = 6, tub = 14, arc = TAU): THREE.BufferGeometry {
  return cacheGeometry(`to|${k(radius)}|${k(tube)}|${rad}|${tub}|${k(arc)}`,
    () => new THREE.TorusGeometry(radius, tube, rad, tub, arc));
}

function gCone(radius: number, h: number, seg = 10): THREE.BufferGeometry {
  return cacheGeometry(`co|${k(radius)}|${k(h)}|${seg}`, () => new THREE.ConeGeometry(radius, h, seg));
}

function gCap(radius: number, len: number, seg = 10): THREE.BufferGeometry {
  return cacheGeometry(`ca|${k(radius)}|${k(len)}|${seg}`,
    () => new THREE.CapsuleGeometry(radius, len, 4, seg));
}

function gCircle(radius: number, seg = 24): THREE.BufferGeometry {
  return cacheGeometry(`ci|${k(radius)}|${seg}`, () => {
    const g = new THREE.CircleGeometry(radius, seg);
    g.rotateX(-HALF_PI);
    return g;
  });
}

// ---------------------------------------------------------------------------
// part merging
// ---------------------------------------------------------------------------

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

function prepare(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.clone();
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
  }
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  if (!g.getAttribute('uv')) {
    const count = g.getAttribute('position').count;
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
  }
  g.clearGroups();
  return g;
}

/**
 * Collects transformed sub-geometries and merges them per material, so a static
 * prop ends up as one mesh per material instead of a dozen Object3Ds.
 */
class PartSet {
  private buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();

  add(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    pos?: V3,
    rot?: V3,
    scale?: V3 | number,
  ): this {
    _p.set(pos ? pos[0] : 0, pos ? pos[1] : 0, pos ? pos[2] : 0);
    _e.set(rot ? rot[0] : 0, rot ? rot[1] : 0, rot ? rot[2] : 0);
    _q.setFromEuler(_e);
    if (typeof scale === 'number') _s.setScalar(scale);
    else if (scale) _s.set(scale[0], scale[1], scale[2]);
    else _s.set(1, 1, 1);
    _m.compose(_p, _q, _s);

    const g = prepare(geo).applyMatrix4(_m);
    const list = this.buckets.get(mat);
    if (list) list.push(g);
    else this.buckets.set(mat, [g]);
    return this;
  }

  /** Merges the collected parts and appends the resulting meshes to `target`. */
  into(target: THREE.Object3D, cast = true, receive = false): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [mat, list] of this.buckets) {
      let geos = list;
      if (!geos.every((g) => g.index !== null)) {
        geos = geos.map((g) => (g.index ? g.toNonIndexed() : g));
      }
      let merged: THREE.BufferGeometry | null = geos[0];
      if (geos.length > 1) merged = mergeGeometries(geos, false) as THREE.BufferGeometry | null;
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      target.add(mesh);
      out.push(mesh);
    }
    this.buckets.clear();
    return out;
  }
}

function group(kind: string): THREE.Group {
  const g = new THREE.Group();
  g.name = kind;
  g.userData.propKind = kind;
  return g;
}

// ---------------------------------------------------------------------------
// theme styling
// ---------------------------------------------------------------------------

interface ThemeStyle {
  /** Walkable surface. */
  topTex: TextureKey;
  topTint: number;
  /** World units covered by one tile of the top texture. */
  topScale: number;
  /** Structural metal (rims, frames, posts). */
  metal: number;
  metalTex: TextureKey;
  metalScale: number;
  /** Deep shadow colour for underside rock / hull. */
  under: number;
  /** Bright trim used for stripes, lights and edges. */
  accent: number;
  /** Emissive colour for seams, cores and lamps. */
  glow: number;
}

const STYLE: Record<PropTheme, ThemeStyle> = {
  scrapyard: {
    // A warm sandy tint over the tread plate: this is a sun-baked salvage yard,
    // not a clean-room floor.
    topTex: 'metalPlate', topTint: 0xc4a373, topScale: 2.6,
    metal: PAL.metalMid, metalTex: 'rustPanel', metalScale: 3.0,
    under: PAL.rockLight, accent: PAL.hazard, glow: PAL.energyWarm,
  },
  gardens: {
    topTex: 'grassTop', topTint: 0xf2fff4, topScale: 3.6,
    metal: PAL.metalLight, metalTex: 'metalPanel', metalScale: 3.0,
    under: PAL.rockLight, accent: PAL.petal, glow: PAL.energy,
  },
  stormworks: {
    topTex: 'circuit', topTint: 0xdfe6ff, topScale: 4.0,
    metal: PAL.metalDark, metalTex: 'metalPanel', metalScale: 3.0,
    under: PAL.rockDark, accent: PAL.energy, glow: PAL.energy,
  },
  finale: {
    topTex: 'metalPlate', topTint: 0xc9b49a, topScale: 3.0,
    metal: PAL.bossPlateDark, metalTex: 'metalPanel', metalScale: 3.0,
    under: PAL.rockDark, accent: PAL.bossAccent, glow: PAL.bossCore,
  },
};

/** Textured surface material for the walkable top of a platform. */
function topMat(theme: PropTheme, span: number): THREE.Material {
  const s = STYLE[theme];
  return toonMat(s.topTint, { map: getTextureTiled(s.topTex, Math.max(1, span / s.topScale)) });
}

/** Textured structural metal for rims, frames and posts. */
function metalMat(theme: PropTheme, span = 3): THREE.Material {
  const s = STYLE[theme];
  return toonMat(s.metal, { map: getTextureTiled(s.metalTex, Math.max(1, span / s.metalScale)) });
}

/** Untextured structural metal — used on small parts where a map would alias. */
function plainMat(color: number, flat = false): THREE.Material {
  return toonMat(color, { ramp: 'hard3', flatShading: flat });
}

function rockMat(theme: PropTheme, span = 6): THREE.Material {
  return toonMat(STYLE[theme].under, { map: getTextureTiled('rockSide', Math.max(1, span / 4), 1) });
}

function hazardMat(): THREE.Material {
  return toonMat(0xffffff, { map: getTextureTiled('hazardStripe', 2, 1) });
}

// ---------------------------------------------------------------------------
// islands
// ---------------------------------------------------------------------------

export interface IslandOptions {
  /** Distance from the centre to the walkable edge, in metres. */
  radius: number;
  theme: PropTheme;
  seed?: number;
  shape?: 'round' | 'hex' | 'blob';
}

/**
 * The hero asset: a floating island.
 *
 * Built from a decorated walkable top (y = 0), a chunky bevelled rim, a tapering
 * rocky/mechanical underside and a handful of pipes, chains, vines or cables
 * dangling below. Detail is theme-driven — scrapyard gets bolted plates and
 * rust, gardens gets grass and flowers over a metal core, stormworks gets dark
 * plate with glowing seams and the finale gets heavy arena plating.
 *
 * `userData`: `{ propKind, theme, radius, shape, radiusAt(theta) }`.
 */
export function createIslandPlatform(opts: IslandOptions): THREE.Group {
  const { radius, theme } = opts;
  const shape = opts.shape ?? 'round';
  const seed = opts.seed ?? 1;
  const r = propRandom(seed);
  const s = STYLE[theme];
  const g = group('islandPlatform');

  const seg = shape === 'hex' ? 6 : radius > 8 ? 40 : 28;
  const lobeA = rr(r, 0.03, 0.075);
  const lobeB = rr(r, 0.02, 0.05);
  const phaseA = r() * TAU;
  const phaseB = r() * TAU;
  const radiusAt = shape === 'blob'
    ? (t: number): number => radius * (1 + Math.sin(t * 3 + phaseA) * lobeA + Math.sin(t * 5 + phaseB) * lobeB)
    : (): number => radius;

  /** Squashes a lathe/cylinder into the island silhouette. */
  const shapeIt = (geo: THREE.BufferGeometry): THREE.BufferGeometry => {
    if (shape !== 'blob') return geo;
    const out = geo.clone();
    const pos = out.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const d = Math.hypot(x, z);
      if (d < 1e-4) continue;
      const f = radiusAt(Math.atan2(z, x)) / radius;
      pos.setX(i, x * f);
      pos.setZ(i, z * f);
    }
    pos.needsUpdate = true;
    out.computeVertexNormals();
    return out;
  };

  const depth = Math.min(5.2, Math.max(1.9, radius * 0.82));
  const rimTop = radius;
  const deckR = radius - 0.16;

  // --- walkable surface ----------------------------------------------------
  const deck = new PartSet();
  deck.add(shapeIt(gCircle(deckR, seg)), topMat(theme, radius * 2), [0, 0, 0]);
  deck.into(g, false, true);

  // --- rim: bevel lip + skirt ---------------------------------------------
  const hull = new PartSet();
  const rimM = metalMat(theme, radius * 1.4);
  hull.add(shapeIt(gCyl(deckR, rimTop, 0.22, seg, true)), rimM, [0, -0.11, 0]);
  hull.add(shapeIt(gCyl(rimTop, rimTop * 0.97, 0.5, seg, true)), rimM, [0, -0.47, 0]);

  // --- tapering underside --------------------------------------------------
  const profile: THREE.Vector2[] = [];
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const rad = rimTop * (0.97 - Math.pow(t, 1.35) * 0.97) + 0.02;
    const y = -0.72 - t * (depth - 0.72);
    const wob = i === 0 || i === steps ? 1 : rr(r, 0.9, 1.12);
    profile.push(new THREE.Vector2(Math.max(0.02, rad * wob), y));
  }
  const lathe = cacheGeometry(
    `isl|${k(radius)}|${seg}|${seed}|${theme}`,
    () => new THREE.LatheGeometry(profile, seg),
  );
  hull.add(shapeIt(lathe), rockMat(theme, radius * 2));
  hull.into(g, false, true);

  // --- top decoration ------------------------------------------------------
  const deco = new PartSet();
  const trim = plainMat(s.metal);
  const accent = plainMat(s.accent);
  const glow = glowMat(s.glow, 1, false);

  if (theme === 'gardens') {
    // stone kerb chunks + flower clumps around the rim
    const kerbs = Math.max(8, Math.round(radius * 2.2));
    for (let i = 0; i < kerbs; i++) {
      const a = (i / kerbs) * TAU + rr(r, -0.05, 0.05);
      const rad = radiusAt(a) - 0.42;
      deco.add(gBox(0.5, 0.26, 0.34, 0.1, 1), trim,
        [Math.cos(a) * rad, 0.09, Math.sin(a) * rad], [0, -a, rr(r, -0.1, 0.1)]);
    }
    const clumps = Math.max(3, Math.round(radius * 0.8));
    for (let i = 0; i < clumps; i++) {
      const a = r() * TAU;
      const rad = rr(r, 0.35, 0.8) * radiusAt(a);
      const cx = Math.cos(a) * rad;
      const cz = Math.sin(a) * rad;
      deco.add(gIco(rr(r, 0.22, 0.34), 0), plainMat(PAL.leafDark, true), [cx, 0.1, cz], [0, r() * TAU, 0]);
      for (let f = 0; f < 3; f++) {
        const fa = r() * TAU;
        deco.add(gSph(0.09, 6, 5), plainMat(f % 2 === 0 ? PAL.petal : PAL.bolt),
          [cx + Math.cos(fa) * 0.28, 0.24, cz + Math.sin(fa) * 0.28]);
      }
    }
  } else {
    // bolted perimeter + a couple of raised repair plates
    const bolts = Math.max(10, Math.round(radius * 3.2));
    for (let i = 0; i < bolts; i++) {
      const a = (i / bolts) * TAU;
      const rad = radiusAt(a) - 0.3;
      deco.add(gCyl(0.1, 0.12, 0.09, 6), trim, [Math.cos(a) * rad, 0.05, Math.sin(a) * rad]);
    }
    const plates = 2 + Math.floor(r() * 2);
    for (let i = 0; i < plates; i++) {
      const a = r() * TAU;
      const rad = rr(r, 0.42, 0.74) * radiusAt(a);
      const cx = Math.cos(a) * rad;
      const cz = Math.sin(a) * rad;
      const w = rr(r, 1.1, 1.9);
      const d = rr(r, 0.9, 1.5);
      const rot = r() * TAU;
      deco.add(gBox(w, 0.1, d, 0.05, 1), trim, [cx, 0.05, cz], [0, rot, 0]);
      for (let b = 0; b < 4; b++) {
        const bx = ((b & 1) ? 1 : -1) * (w * 0.5 - 0.16);
        const bz = ((b & 2) ? 1 : -1) * (d * 0.5 - 0.16);
        deco.add(gCyl(0.06, 0.07, 0.07, 6), accent,
          [cx + bx * Math.cos(rot) - bz * Math.sin(rot), 0.12, cz + bx * Math.sin(rot) + bz * Math.cos(rot)]);
      }
    }
  }

  if (theme === 'stormworks' || theme === 'finale') {
    // Glowing seams radiating from the middle — reads instantly as "powered".
    // These must be WIDE and DIM: an earlier pass drew them 0.12 wide at full
    // brightness, and at the game's grazing camera angle a 20-metre strip that
    // thin aliases into a laser beam shooting across the arena. Inlaid floor
    // trim wants width, not intensity.
    const seam = glowMat(s.glow, 0.32, true);
    const arms = theme === 'finale' ? 6 : 4;
    for (let i = 0; i < arms; i++) {
      const a = (i / arms) * TAU + 0.2;
      const len = radiusAt(a) * 0.74;
      deco.add(gBox(len, 0.04, 0.62, 0.02, 1), seam,
        [Math.cos(a) * len * 0.5, 0.03, Math.sin(a) * len * 0.5], [0, -a, 0]);
    }
    deco.add(gTorus(radius * 0.28, 0.17, 5, 32), seam, [0, 0.03, 0], [HALF_PI, 0, 0]);
  }
  if (theme === 'finale') {
    // hazard-striped border segments
    const segsN = 8;
    for (let i = 0; i < segsN; i++) {
      const a = (i / segsN) * TAU + Math.PI / segsN;
      const rad = radiusAt(a) - 0.9;
      deco.add(gBox(1.5, 0.07, 0.42, 0.03, 1), hazardMat(),
        [Math.cos(a) * rad, 0.05, Math.sin(a) * rad], [0, -a, 0]);
    }
  }
  deco.into(g, true, true);

  // --- things hanging underneath ------------------------------------------
  const hang = new PartSet();
  const hangs = Math.max(3, Math.round(radius * 0.7));
  for (let i = 0; i < hangs; i++) {
    const a = (i / hangs) * TAU + rr(r, -0.3, 0.3);
    const rad = rr(r, 0.45, 0.85) * radius;
    const x = Math.cos(a) * rad;
    const z = Math.sin(a) * rad;
    const len = rr(r, 0.8, 2.1);
    const y0 = -0.7 - depth * 0.1;

    if (theme === 'gardens') {
      hang.add(gCyl(0.05, 0.04, len, 5), plainMat(PAL.leafDark), [x, y0 - len * 0.5, z]);
      for (let l = 0; l < 3; l++) {
        hang.add(gIco(rr(r, 0.13, 0.2), 0), plainMat(PAL.leafMid, true),
          [x + rr(r, -0.16, 0.16), y0 - len * (0.3 + l * 0.25), z + rr(r, -0.16, 0.16)], [0, r() * TAU, 0]);
      }
    } else if (theme === 'stormworks') {
      hang.add(gCyl(0.06, 0.06, len, 5), plainMat(PAL.hazardDark), [x, y0 - len * 0.5, z], [0, 0, rr(r, -0.12, 0.12)]);
      hang.add(gSph(0.15, 7, 5), glow, [x, y0 - len, z]);
    } else {
      hang.add(gCyl(0.11, 0.11, len, 6), plainMat(s.metal), [x, y0 - len * 0.5, z], [0, 0, rr(r, -0.1, 0.1)]);
      hang.add(gTorus(0.15, 0.05, 4, 8), plainMat(s.metal), [x, y0 - len, z], [rr(r, 0, 1), 0, 0]);
      hang.add(gTorus(0.15, 0.05, 4, 8), plainMat(s.metal), [x, y0 - len - 0.24, z], [rr(r, 0, 1), 1.2, 0]);
    }
  }
  hang.into(g, false, false);

  g.userData.theme = theme;
  g.userData.radius = radius;
  g.userData.shape = shape;
  g.userData.radiusAt = radiusAt;
  return g;
}

/**
 * A connecting walkway between two islands, running along +X with its deck at
 * y = 0 and its centre at the origin. Comes with railings on both sides.
 */
export function createBridge(length: number, theme: PropTheme): THREE.Group {
  const g = group('bridge');
  const width = 2.4;
  const s = STYLE[theme];
  const parts = new PartSet();

  // deck — planks in the gardens, plate everywhere else
  const deckTex: TextureKey = theme === 'gardens' ? 'woodPlank' : 'metalPlate';
  const deckMat = toonMat(theme === 'gardens' ? PAL.woodLight : s.topTint, {
    map: getTextureTiled(deckTex, Math.max(1, length / 3), 1),
  });
  parts.add(gBox(length, 0.22, width, 0.07, 1), deckMat, [0, -0.11, 0]);

  // cross beams + edge kerbs under the deck
  const beams = Math.max(2, Math.round(length / 1.6));
  for (let i = 0; i <= beams; i++) {
    const x = -length * 0.5 + (i / beams) * length;
    parts.add(gBox(0.22, 0.26, width + 0.18, 0.06, 1), plainMat(s.metal), [x, -0.3, 0]);
  }
  parts.add(gBox(length, 0.14, 0.2, 0.05, 1), plainMat(s.metal), [0, -0.3, width * 0.5 - 0.02]);
  parts.add(gBox(length, 0.14, 0.2, 0.05, 1), plainMat(s.metal), [0, -0.3, -width * 0.5 + 0.02]);
  // spine truss for a readable silhouette from the side
  parts.add(gBox(length * 0.98, 0.16, 0.3, 0.06, 1), plainMat(s.metal), [0, -0.5, 0]);
  parts.into(g, true, true);

  const railA = createRailing(length, theme);
  railA.position.z = width * 0.5 - 0.12;
  const railB = createRailing(length, theme);
  railB.position.z = -width * 0.5 + 0.12;
  g.add(railA, railB);

  g.userData.length = length;
  g.userData.width = width;
  g.userData.theme = theme;
  return g;
}

/**
 * A railing running along +X, centred on the origin, standing on y = 0.
 * Posts every ~1.3 m with two rails and a bright cap on each post.
 */
export function createRailing(length: number, theme: PropTheme): THREE.Group {
  const g = group('railing');
  const s = STYLE[theme];
  const parts = new PartSet();
  const posts = Math.max(2, Math.round(length / 1.3));
  const postMat = plainMat(s.metal);
  const capMat = plainMat(s.accent);

  for (let i = 0; i <= posts; i++) {
    const x = -length * 0.5 + (i / posts) * length;
    parts.add(gBox(0.16, 0.86, 0.16, 0.05, 1), postMat, [x, 0.43, 0]);
    parts.add(gCyl(0.11, 0.09, 0.1, 6), capMat, [x, 0.9, 0]);
  }
  parts.add(gBox(length, 0.1, 0.12, 0.045, 1), postMat, [0, 0.8, 0]);
  parts.add(gBox(length, 0.08, 0.1, 0.035, 1), postMat, [0, 0.44, 0]);
  parts.into(g, true, false);

  g.userData.length = length;
  g.userData.theme = theme;
  return g;
}

// ---------------------------------------------------------------------------
// Scrapyard set dressing
// ---------------------------------------------------------------------------

/**
 * A bolted crate. Smashable: dashing through one pops it into scrap and drops
 * bolts, so it doubles as the tutorial for "dash breaks things".
 * `userData.collider` = its half-width, so the arena can push the player out.
 */
export function createCrate(size = 1): THREE.Group {
  const g = group('crate');
  const parts = new PartSet();
  const s = size;
  const body = toonMat(PAL.woodLight, { map: getTextureTiled('woodPlank', 1, 1) });
  const frame = plainMat(PAL.metalMid);
  const bolt = plainMat(PAL.bolt);

  parts.add(gBox(0.94 * s, 0.9 * s, 0.94 * s, 0.07, 1), body, [0, 0.45 * s, 0]);
  // Corner bracing gives the silhouette its bevelled, toy-like read.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.add(gBox(0.12 * s, 0.94 * s, 0.12 * s, 0.04, 1), frame,
        [sx * 0.44 * s, 0.45 * s, sz * 0.44 * s]);
    }
  }
  for (const sy of [0.06, 0.86]) {
    parts.add(gBox(0.98 * s, 0.1 * s, 0.98 * s, 0.035, 1), frame, [0, sy * s, 0]);
  }
  // Rivets, and a bright energy stencil on two faces so it reads as "loot".
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.add(gSph(0.05 * s, 6, 5), bolt, [sx * 0.44 * s, 0.14 * s, sz * 0.44 * s]);
      parts.add(gSph(0.05 * s, 6, 5), bolt, [sx * 0.44 * s, 0.78 * s, sz * 0.44 * s]);
    }
  }
  parts.into(g, true, true);

  const decal = new THREE.Mesh(gTorus(0.19 * s, 0.045 * s, 5, 12), glowMat(PAL.energyWarm, 0.85, true));
  decal.position.set(0, 0.46 * s, 0.49 * s);
  g.add(decal);
  const decal2 = decal.clone();
  decal2.position.set(0.49 * s, 0.46 * s, 0);
  decal2.rotation.y = HALF_PI;
  g.add(decal2);

  g.userData.collider = 0.62 * s;
  g.userData.size = s;
  return g;
}

/** A heap of discarded machine parts. Pure silhouette filler for the rim. */
export function createScrapPile(seed = 1): THREE.Group {
  const g = group('scrapPile');
  const r = propRandom(seed * 977 + 13);
  const parts = new PartSet();
  const a = plainMat(PAL.metalMid);
  const b = plainMat(PAL.metalDark);
  const c = plainMat(PAL.hazard);

  parts.add(gIco(0.95, 0), b, [0, 0.42, 0], [0.4, 0.7, 0.2], [1.5, 0.7, 1.4]);
  for (let i = 0; i < 7; i++) {
    const ang = rr(r, 0, TAU);
    const rad = rr(r, 0.15, 0.95);
    const mat = i % 3 === 0 ? c : i % 2 === 0 ? a : b;
    const px = Math.cos(ang) * rad;
    const pz = Math.sin(ang) * rad;
    const py = rr(r, 0.2, 1.05);
    if (i % 2 === 0) {
      parts.add(gBox(rr(r, 0.3, 0.7), rr(r, 0.25, 0.5), rr(r, 0.3, 0.7), 0.06, 1), mat,
        [px, py, pz], [rr(r, -0.6, 0.6), rr(r, 0, TAU), rr(r, -0.6, 0.6)]);
    } else {
      parts.add(gCyl(rr(r, 0.14, 0.26), rr(r, 0.14, 0.26), rr(r, 0.5, 1.0), 8), mat,
        [px, py, pz], [rr(r, -1.4, 1.4), rr(r, 0, TAU), rr(r, -1.4, 1.4)]);
    }
  }
  // One bent girder poking out is what makes a pile read as a *pile*.
  parts.add(gBox(0.2, 1.9, 0.2, 0.05, 1), a, [0.5, 0.9, -0.3], [0.35, 0.7, 0.5]);
  parts.into(g, true, true);
  g.userData.collider = 1.15;
  return g;
}

/** Bundled pipework with valve wheels and a warm indicator lamp. */
export function createPipeCluster(seed = 1): THREE.Group {
  const g = group('pipeCluster');
  const r = propRandom(seed * 613 + 7);
  const parts = new PartSet();
  const pipe = metalMat('scrapyard', 3);
  const trim = plainMat(PAL.hazard);

  const heights = [1.9, 2.6, 1.4];
  const offs: V3[] = [[-0.4, 0, 0.1], [0.35, 0, -0.15], [0.05, 0, 0.45]];
  for (let i = 0; i < 3; i++) {
    const h = heights[i]! * rr(r, 0.85, 1.15);
    const o = offs[i]!;
    const rad = 0.24 - i * 0.03;
    parts.add(gCyl(rad, rad, h, 10), pipe, [o[0], h * 0.5, o[2]]);
    parts.add(gTorus(rad + 0.03, 0.06, 5, 12), trim, [o[0], h * 0.72, o[2]], [HALF_PI, 0, 0]);
    parts.add(gCyl(rad + 0.09, rad + 0.09, 0.14, 10), pipe, [o[0], 0.07, o[2]]);
  }
  // Elbow joint across the top, tying the bundle together.
  parts.add(gCyl(0.16, 0.16, 0.95, 8), pipe, [-0.05, 1.85, 0.15], [0, 0.3, HALF_PI]);
  const wheel = new THREE.Mesh(gTorus(0.3, 0.055, 5, 14), plainMat(PAL.scarf));
  wheel.position.set(0.35, 1.6, -0.15);
  wheel.rotation.x = HALF_PI;
  g.add(wheel);
  g.userData.spinner = wheel;
  g.userData.spinSpeed = 0.5;
  g.userData.spinAxis = 'z';
  parts.into(g, true, true);

  const lamp = new THREE.Mesh(gSph(0.11, 8, 6), glowMat(PAL.energyWarm, 0.95, true));
  lamp.position.set(-0.4, 2.0, 0.1);
  g.add(lamp);
  g.userData.collider = 0.85;
  return g;
}

/** A toothed gear. Decor when standing, hazard housing when laid flat. */
export function createGear(radius = 1.2, teeth = 10): THREE.Group {
  const g = group('gear');
  const parts = new PartSet();
  const body = plainMat(PAL.metalMid);
  const hub = plainMat(PAL.hazard);
  const thickness = radius * 0.24;

  parts.add(gCyl(radius * 0.86, radius * 0.86, thickness, Math.max(12, teeth * 2)), body, [0, 0, 0]);
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * TAU;
    parts.add(gBox(radius * 0.3, thickness * 1.02, radius * 0.34, 0.03, 1), body,
      [Math.cos(a) * radius * 0.93, 0, Math.sin(a) * radius * 0.93], [0, -a, 0]);
  }
  parts.add(gCyl(radius * 0.26, radius * 0.26, thickness * 1.3, 10), hub, [0, 0, 0]);
  // Spokes: three bars keep it from reading as a solid disc.
  for (let i = 0; i < 3; i++) {
    parts.add(gBox(radius * 1.3, thickness * 0.5, radius * 0.16, 0.03, 1), body,
      [0, 0, 0], [0, (i / 3) * Math.PI, 0]);
  }
  const spin = new THREE.Group();
  parts.into(spin, true, true);
  spin.rotation.x = HALF_PI;
  spin.position.y = radius * 0.9;
  g.add(spin);

  const post = new THREE.Mesh(gBox(0.22, radius * 0.9, 0.22, 0.05, 1), plainMat(PAL.metalDark));
  post.position.y = radius * 0.45;
  post.castShadow = true;
  g.add(post);

  g.userData.spinner = spin;
  g.userData.spinSpeed = 0.9;
  g.userData.spinAxis = 'z';
  g.userData.collider = 0.4;
  return g;
}

/** A tall radio mast with a blinking beacon. Great vertical rim silhouette. */
export function createAntenna(): THREE.Group {
  const g = group('antenna');
  const parts = new PartSet();
  const strut = plainMat(PAL.metalMid);
  const trim = plainMat(PAL.hazard);
  const H = 4.4;

  // Tapering lattice: three legs plus cross-braces.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU;
    parts.add(gCyl(0.05, 0.075, H, 5), strut,
      [Math.cos(a) * 0.24, H * 0.5, Math.sin(a) * 0.24],
      [Math.sin(a) * 0.06, 0, -Math.cos(a) * 0.06]);
  }
  for (let level = 1; level <= 4; level++) {
    const y = (level / 5) * H;
    const rad = 0.26 * (1 - y / (H * 1.6));
    parts.add(gTorus(rad, 0.03, 4, 9), strut, [0, y, 0], [HALF_PI, 0, 0]);
  }
  parts.add(gBox(0.7, 0.16, 0.7, 0.05, 1), strut, [0, 0.08, 0]);
  parts.add(gBox(1.05, 0.09, 0.14, 0.03, 1), trim, [0, H * 0.72, 0], [0, 0.4, 0]);
  parts.add(gBox(0.8, 0.09, 0.12, 0.03, 1), trim, [0, H * 0.84, 0], [0, -0.5, 0]);
  parts.into(g, true, false);

  const beacon = new THREE.Mesh(gSph(0.14, 8, 6), glowMat(PAL.danger, 0.9, true));
  beacon.position.y = H + 0.1;
  g.add(beacon);
  const dish = new THREE.Mesh(
    new THREE.SphereGeometry(0.42, 12, 8, 0, TAU, 0, Math.PI * 0.42),
    plainMat(PAL.metalLight),
  );
  dish.position.set(0.3, H * 0.62, 0.1);
  dish.rotation.set(1.1, 0.5, 0);
  dish.castShadow = true;
  g.add(dish);
  g.userData.collider = 0.55;
  return g;
}

/** Rivet's kind of place: a cluttered workbench with a vice and a lamp. */
export function createWorkbench(): THREE.Group {
  const g = group('workbench');
  const parts = new PartSet();
  const wood = toonMat(PAL.woodLight, { map: getTextureTiled('woodPlank', 2, 1) });
  const legs = plainMat(PAL.metalDark);
  const tools = plainMat(PAL.metalLight);

  parts.add(gBox(2.4, 0.16, 1.05, 0.05, 1), wood, [0, 0.94, 0]);
  parts.add(gBox(2.3, 0.1, 0.95, 0.04, 1), wood, [0, 0.36, 0]);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.add(gBox(0.14, 0.94, 0.14, 0.04, 1), legs, [sx * 1.05, 0.47, sz * 0.42]);
    }
  }
  // Vice, toolbox and a scattering of parts on the top.
  parts.add(gBox(0.36, 0.3, 0.3, 0.06, 1), tools, [-0.85, 1.16, 0]);
  parts.add(gBox(0.7, 0.32, 0.42, 0.07, 1), plainMat(PAL.scarf), [0.6, 1.18, -0.05]);
  parts.add(gCyl(0.11, 0.11, 0.28, 8), tools, [0.05, 1.16, 0.22], [0.2, 0, 0.5]);
  parts.add(gBox(0.5, 0.06, 0.14, 0.02, 1), tools, [-0.15, 1.05, -0.3], [0, 0.35, 0]);
  parts.into(g, true, true);

  // Gooseneck lamp — the warm pool of light is a nice focal accent.
  const arm = new THREE.Mesh(gCyl(0.035, 0.035, 1.0, 5), legs);
  arm.position.set(1.0, 1.5, -0.3);
  arm.rotation.z = 0.45;
  g.add(arm);
  const shade = new THREE.Mesh(gCone(0.22, 0.26, 10), plainMat(PAL.hazard));
  shade.position.set(0.75, 1.92, -0.3);
  shade.rotation.z = Math.PI + 0.5;
  g.add(shade);
  const bulb = new THREE.Mesh(gSph(0.1, 8, 6), glowMat(PAL.overdriveHot, 0.95, true));
  bulb.position.set(0.71, 1.79, -0.3);
  g.add(bulb);
  g.userData.collider = 1.15;
  return g;
}

/** A stretch of conveyor with rollers the game slowly spins. */
export function createConveyorSegment(length = 5): THREE.Group {
  const g = group('conveyor');
  const parts = new PartSet();
  const frame = plainMat(PAL.metalDark);
  const belt = toonMat(0x3a3f57, { map: getTextureTiled('hazardStripe', Math.max(2, length / 2), 1) });

  parts.add(gBox(length, 0.14, 1.25, 0.05, 1), belt, [0, 0.78, 0]);
  for (const sz of [-1, 1]) {
    parts.add(gBox(length + 0.1, 0.24, 0.14, 0.05, 1), frame, [0, 0.78, sz * 0.68]);
  }
  const legCount = Math.max(2, Math.round(length / 2.2));
  for (let i = 0; i <= legCount; i++) {
    const x = -length * 0.5 + (i / legCount) * length;
    parts.add(gBox(0.16, 0.72, 0.16, 0.04, 1), frame, [x, 0.36, 0.5]);
    parts.add(gBox(0.16, 0.72, 0.16, 0.04, 1), frame, [x, 0.36, -0.5]);
  }
  parts.into(g, true, true);

  const rollers = new THREE.Group();
  const rollerCount = Math.max(2, Math.round(length / 1.1));
  for (let i = 0; i <= rollerCount; i++) {
    const x = -length * 0.5 + (i / rollerCount) * length;
    const roll = new THREE.Mesh(gCyl(0.14, 0.14, 1.34, 8), plainMat(PAL.metalLight));
    roll.position.set(x, 0.62, 0);
    roll.rotation.x = HALF_PI;
    roll.castShadow = true;
    rollers.add(roll);
  }
  g.add(rollers);
  g.userData.spinner = rollers;
  g.userData.spinSpeed = 1.1;
  g.userData.spinAxis = 'z';
  g.userData.collider = 0.7;
  return g;
}

/** A banded fuel drum with a bright hazard stripe. */
export function createBarrel(): THREE.Group {
  const g = group('barrel');
  const parts = new PartSet();
  const body = toonMat(PAL.scarf, { map: getTextureTiled('metalPanel', 2, 1) });
  const band = plainMat(PAL.metalLight);

  parts.add(gCyl(0.46, 0.46, 1.2, 14), body, [0, 0.6, 0]);
  for (const y of [0.22, 0.6, 0.98]) {
    parts.add(gTorus(0.47, 0.055, 5, 14), band, [0, y, 0], [HALF_PI, 0, 0]);
  }
  parts.add(gCyl(0.44, 0.44, 0.08, 14), band, [0, 1.22, 0]);
  parts.add(gCyl(0.12, 0.12, 0.1, 8), plainMat(PAL.bolt), [0.2, 1.28, 0]);
  parts.into(g, true, true);
  g.userData.collider = 0.55;
  return g;
}

// ---------------------------------------------------------------------------
// Cloudtop Gardens set dressing
// ---------------------------------------------------------------------------

/**
 * A stylized tree: chunky faceted canopy clumps on a tapered trunk, growing out
 * of a riveted mechanical planter. The planter is what keeps the gardens
 * reading as *mechanical* gardens rather than generic nature.
 */
export function createTree(seed = 1): THREE.Group {
  const g = group('tree');
  const r = propRandom(seed * 331 + 5);
  const parts = new PartSet();
  const bark = toonMat(PAL.woodDark, { map: getTextureTiled('woodPlank', 1, 2) });
  const planter = plainMat(PAL.metalLight);
  const trim = plainMat(PAL.leafDark);
  const leaves = [plainMat(PAL.leafMid), plainMat(PAL.leafLight), plainMat(PAL.leafDark)];

  // Planter.
  parts.add(gCyl(0.82, 0.7, 0.62, 12), planter, [0, 0.31, 0]);
  parts.add(gTorus(0.84, 0.08, 5, 14), trim, [0, 0.6, 0], [HALF_PI, 0, 0]);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    parts.add(gSph(0.06, 6, 5), plainMat(PAL.bolt), [Math.cos(a) * 0.78, 0.42, Math.sin(a) * 0.78]);
  }

  // Trunk with a gentle lean.
  const H = rr(r, 2.1, 2.9);
  const lean = rr(r, -0.14, 0.14);
  parts.add(gCyl(0.16, 0.3, H, 8), bark, [lean * H * 0.4, 0.6 + H * 0.5, 0], [0, 0, lean]);
  parts.add(gCyl(0.1, 0.14, 0.9, 6), bark,
    [lean * H * 0.7 + 0.34, 0.6 + H * 0.72, 0.1], [0.2, 0, -0.8]);

  // Canopy: 5–7 overlapping faceted clumps, biggest in the middle.
  const topY = 0.6 + H + 0.25;
  const topX = lean * H * 0.85;
  const clumps = 5 + Math.floor(r() * 3);
  for (let i = 0; i < clumps; i++) {
    const a = (i / clumps) * TAU + rr(r, -0.3, 0.3);
    const rad = i === 0 ? 0 : rr(r, 0.5, 0.95);
    const size = i === 0 ? rr(r, 0.98, 1.2) : rr(r, 0.55, 0.85);
    parts.add(gIco(size, 1), leaves[i % 3]!,
      [topX + Math.cos(a) * rad, topY + rr(r, -0.25, 0.45), Math.sin(a) * rad],
      [rr(r, 0, TAU), rr(r, 0, TAU), 0], [1, 0.86, 1]);
  }
  parts.into(g, true, true);

  // A few blossom dots for colour.
  for (let i = 0; i < 5; i++) {
    const a = rr(r, 0, TAU);
    const rad = rr(r, 0.6, 1.15);
    const petal = new THREE.Mesh(gSph(0.09, 6, 5), plainMat(PAL.petal));
    petal.position.set(topX + Math.cos(a) * rad, topY + rr(r, -0.2, 0.5), Math.sin(a) * rad);
    g.add(petal);
  }
  g.userData.collider = 0.85;
  return g;
}

/** A low faceted shrub with a couple of berries. Fills gaps cheaply. */
export function createBush(seed = 1): THREE.Group {
  const g = group('bush');
  const r = propRandom(seed * 179 + 3);
  const parts = new PartSet();
  const leaves = [plainMat(PAL.leafMid), plainMat(PAL.leafLight)];

  const lobes = 3 + Math.floor(r() * 3);
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * TAU + rr(r, -0.4, 0.4);
    const rad = i === 0 ? 0 : rr(r, 0.25, 0.5);
    const size = i === 0 ? rr(r, 0.55, 0.7) : rr(r, 0.34, 0.5);
    parts.add(gIco(size, 1), leaves[i % 2]!,
      [Math.cos(a) * rad, size * 0.78, Math.sin(a) * rad],
      [rr(r, 0, TAU), rr(r, 0, TAU), 0], [1, 0.82, 1]);
  }
  parts.into(g, true, true);
  for (let i = 0; i < 3; i++) {
    const berry = new THREE.Mesh(gSph(0.075, 6, 5), plainMat(PAL.heart));
    berry.position.set(rr(r, -0.45, 0.45), rr(r, 0.5, 0.85), rr(r, -0.45, 0.45));
    g.add(berry);
  }
  g.userData.collider = 0.5;
  return g;
}

/** A flat patch of flowers. No collider — the player rides right over it. */
export function createFlowerPatch(seed = 1): THREE.Group {
  const g = group('flowerPatch');
  const r = propRandom(seed * 91 + 11);
  const parts = new PartSet();
  const stem = plainMat(PAL.leafDark);
  const petals = [plainMat(PAL.petal), plainMat(PAL.overdrive), plainMat(0xfff1f6)];

  const mat = new THREE.Mesh(gCircle(1.15, 16), toonMat(PAL.leafMid, {
    map: getTextureTiled('grassTop', 1, 1), transparent: true, opacity: 0.95,
  }));
  mat.position.y = 0.015;
  mat.receiveShadow = true;
  g.add(mat);

  const count = 7 + Math.floor(r() * 5);
  for (let i = 0; i < count; i++) {
    const a = rr(r, 0, TAU);
    const rad = rr(r, 0.1, 0.95);
    const x = Math.cos(a) * rad;
    const z = Math.sin(a) * rad;
    const h = rr(r, 0.22, 0.42);
    parts.add(gCyl(0.022, 0.03, h, 4), stem, [x, h * 0.5, z]);
    const head = petals[Math.floor(r() * 3)]!;
    // Five little petals around a centre — cheap but reads as a flower.
    for (let p = 0; p < 5; p++) {
      const pa = (p / 5) * TAU;
      parts.add(gSph(0.052, 5, 4), head,
        [x + Math.cos(pa) * 0.07, h + 0.02, z + Math.sin(pa) * 0.07], undefined, [1, 0.6, 1]);
    }
    parts.add(gSph(0.04, 5, 4), plainMat(PAL.bolt), [x, h + 0.05, z]);
  }
  parts.into(g, false, false);
  g.userData.collider = 0;
  return g;
}

/** A trellis post wrapped in vines with a hanging lantern. */
export function createVinePost(): THREE.Group {
  const g = group('vinePost');
  const parts = new PartSet();
  const post = toonMat(PAL.woodLight, { map: getTextureTiled('woodPlank', 1, 2) });
  const vine = plainMat(PAL.leafDark);
  const leaf = plainMat(PAL.leafLight);
  const H = 2.9;

  parts.add(gBox(0.24, H, 0.24, 0.06, 1), post, [0, H * 0.5, 0]);
  parts.add(gBox(1.5, 0.16, 0.18, 0.05, 1), post, [0.3, H - 0.15, 0]);
  parts.add(gBox(0.6, 0.16, 0.16, 0.04, 1), post, [0, H * 0.55, 0], [0, HALF_PI, 0]);

  // Vine spiralling up the post.
  const turns = 14;
  for (let i = 0; i < turns; i++) {
    const t = i / turns;
    const a = t * TAU * 2.4;
    const y = 0.15 + t * (H - 0.4);
    parts.add(gSph(0.075, 5, 4), vine, [Math.cos(a) * 0.18, y, Math.sin(a) * 0.18]);
    if (i % 2 === 0) {
      parts.add(gIco(0.15, 0), leaf,
        [Math.cos(a) * 0.32, y + 0.04, Math.sin(a) * 0.32],
        [rr(propRandom(i + 1), 0, TAU), a, 0], [1, 0.45, 1]);
    }
  }
  parts.into(g, true, true);

  const lantern = new THREE.Group();
  lantern.position.set(0.95, H - 0.5, 0);
  const cage = new THREE.Mesh(gBox(0.3, 0.36, 0.3, 0.09, 1), plainMat(PAL.metalLight));
  lantern.add(cage);
  const light = new THREE.Mesh(gSph(0.13, 8, 6), glowMat(PAL.overdriveHot, 0.95, true));
  lantern.add(light);
  const chain = new THREE.Mesh(gCyl(0.02, 0.02, 0.34, 4), plainMat(PAL.metalDark));
  chain.position.y = 0.34;
  lantern.add(chain);
  g.add(lantern);
  g.userData.collider = 0.34;
  return g;
}

/** A windmill whose sails the game spins. Big, readable, very "gardens". */
export function createWindmill(): THREE.Group {
  const g = group('windmill');
  const parts = new PartSet();
  const tower = toonMat(PAL.metalLight, { map: getTextureTiled('metalPanel', 1, 2) });
  const trim = plainMat(PAL.leafMid);
  const H = 3.6;

  parts.add(gCyl(0.42, 0.72, H, 10), tower, [0, H * 0.5, 0]);
  parts.add(gTorus(0.74, 0.09, 5, 14), trim, [0, 0.12, 0], [HALF_PI, 0, 0]);
  parts.add(gTorus(0.45, 0.08, 5, 14), trim, [0, H - 0.15, 0], [HALF_PI, 0, 0]);
  parts.add(gCone(0.6, 0.7, 10), trim, [0, H + 0.32, 0]);
  parts.add(gBox(0.34, 0.5, 0.1, 0.05, 1), plainMat(PAL.woodDark), [0, 0.9, 0.7]);
  parts.into(g, true, true);

  // Sails on their own pivot.
  const sails = new THREE.Group();
  sails.position.set(0, H * 0.82, 0.62);
  const hub = new THREE.Mesh(gCyl(0.16, 0.16, 0.3, 10), plainMat(PAL.metalDark));
  hub.rotation.x = HALF_PI;
  sails.add(hub);
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Group();
    blade.rotation.z = (i / 4) * TAU;
    const spar = new THREE.Mesh(gBox(0.12, 1.7, 0.08, 0.03, 1), plainMat(PAL.woodDark));
    spar.position.y = 0.85;
    blade.add(spar);
    const vane = new THREE.Mesh(gBox(0.5, 1.2, 0.05, 0.03, 1), plainMat(i % 2 ? PAL.petal : PAL.leafLight));
    vane.position.set(0.28, 0.95, 0.03);
    blade.add(vane);
    blade.traverse((o) => {
      (o as THREE.Mesh).castShadow = true;
    });
    sails.add(blade);
  }
  g.add(sails);
  g.userData.spinner = sails;
  g.userData.spinSpeed = 0.85;
  g.userData.spinAxis = 'z';
  g.userData.collider = 0.8;
  return g;
}

/** A tiered fountain with a glowing energy pool instead of water. */
export function createFountain(): THREE.Group {
  const g = group('fountain');
  const parts = new PartSet();
  const stone = toonMat(PAL.metalLight, { map: getTextureTiled('metalPanel', 2, 1) });
  const trim = plainMat(PAL.leafMid);

  parts.add(gCyl(1.35, 1.45, 0.42, 16), stone, [0, 0.21, 0]);
  parts.add(gTorus(1.36, 0.11, 5, 18), trim, [0, 0.42, 0], [HALF_PI, 0, 0]);
  parts.add(gCyl(0.3, 0.38, 0.85, 10), stone, [0, 0.82, 0]);
  parts.add(gCyl(0.72, 0.62, 0.2, 14), stone, [0, 1.32, 0]);
  parts.add(gTorus(0.72, 0.07, 5, 14), trim, [0, 1.42, 0], [HALF_PI, 0, 0]);
  parts.add(gCyl(0.16, 0.2, 0.5, 8), stone, [0, 1.65, 0]);
  parts.into(g, true, true);

  const pool = new THREE.Mesh(gCircle(1.28, 20), glowMat(PAL.energy, 0.5, true));
  pool.position.y = 0.36;
  g.add(pool);
  const upper = new THREE.Mesh(gCircle(0.62, 16), glowMat(PAL.energy, 0.55, true));
  upper.position.y = 1.4;
  g.add(upper);
  const spout = new THREE.Mesh(gSph(0.19, 10, 8), glowMat(PAL.cellHot, 0.85, true));
  spout.position.y = 1.98;
  g.add(spout);
  g.userData.collider = 1.5;
  return g;
}

// ---------------------------------------------------------------------------
// Stormworks set dressing
// ---------------------------------------------------------------------------

/** A tesla coil: stacked toroids with an arcing crown. Very Area 3. */
export function createTeslaCoil(): THREE.Group {
  const g = group('teslaCoil');
  const parts = new PartSet();
  const base = toonMat(PAL.metalDark, { map: getTextureTiled('circuit', 1, 1) });
  const copper = plainMat(PAL.bossAccent);
  const H = 3.2;

  parts.add(gBox(1.25, 0.5, 1.25, 0.1, 1), base, [0, 0.25, 0]);
  parts.add(gCyl(0.34, 0.44, 0.5, 10), base, [0, 0.72, 0]);
  // Coil winding: a stack of thin torii reads as wound copper for almost nothing.
  for (let i = 0; i < 16; i++) {
    const y = 0.95 + (i / 16) * (H - 1.5);
    parts.add(gTorus(0.3 - i * 0.004, 0.045, 4, 12), copper, [0, y, 0], [HALF_PI, 0, 0]);
  }
  parts.add(gCyl(0.12, 0.12, H - 1.2, 6), base, [0, 0.95 + (H - 1.4) * 0.5, 0]);
  parts.into(g, true, true);

  const crown = new THREE.Mesh(gTorus(0.62, 0.2, 8, 18), plainMat(PAL.metalLight));
  crown.position.y = H;
  crown.rotation.x = HALF_PI;
  crown.castShadow = true;
  g.add(crown);
  const orb = new THREE.Mesh(gSph(0.28, 12, 9), glowMat(PAL.energy, 0.9, true));
  orb.position.y = H;
  g.add(orb);
  // Four little arc stubs sticking out of the crown.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    const arc = new THREE.Mesh(gCyl(0.025, 0.01, 0.5, 4), glowMat(PAL.cellHot, 0.8, true));
    arc.position.set(Math.cos(a) * 0.62, H + 0.24, Math.sin(a) * 0.62);
    arc.rotation.set(Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6);
    g.add(arc);
  }
  g.userData.collider = 0.75;
  return g;
}

/** A ducted turbine with spinning blades. */
export function createTurbine(): THREE.Group {
  const g = group('turbine');
  const parts = new PartSet();
  const shell = toonMat(PAL.metalDark, { map: getTextureTiled('metalPanel', 2, 1) });
  const trim = plainMat(PAL.energy);

  parts.add(gBox(0.9, 1.5, 0.9, 0.12, 1), shell, [0, 0.75, 0]);
  parts.add(gCyl(1.05, 1.05, 1.15, 16, true), shell, [0, 2.0, 0], [HALF_PI, 0, 0]);
  parts.add(gTorus(1.06, 0.1, 5, 18), trim, [0, 2.0, 0.56]);
  parts.add(gTorus(1.06, 0.1, 5, 18), trim, [0, 2.0, -0.56]);
  parts.into(g, true, true);

  const blades = new THREE.Group();
  blades.position.y = 2.0;
  const hub = new THREE.Mesh(gCyl(0.2, 0.2, 0.34, 10), plainMat(PAL.metalLight));
  hub.rotation.x = HALF_PI;
  blades.add(hub);
  for (let i = 0; i < 6; i++) {
    const blade = new THREE.Mesh(gBox(0.26, 1.7, 0.07, 0.03, 1), plainMat(PAL.metalLight));
    blade.position.y = 0;
    blade.rotation.z = (i / 6) * TAU;
    blade.rotation.y = 0.4;
    blade.translateY(0.5);
    blade.castShadow = true;
    blades.add(blade);
  }
  g.add(blades);
  g.userData.spinner = blades;
  g.userData.spinSpeed = 3.2;
  g.userData.spinAxis = 'z';
  g.userData.collider = 0.75;
  return g;
}

/** A power pylon carrying humming cables. */
export function createPylon(): THREE.Group {
  const g = group('pylon');
  const parts = new PartSet();
  const steel = plainMat(PAL.metalDark);
  const glow = plainMat(PAL.energy);
  const H = 4.8;

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.add(gCyl(0.05, 0.1, H, 5), steel,
        [sx * 0.3, H * 0.5, sz * 0.3], [sz * 0.05, 0, -sx * 0.05]);
    }
  }
  for (let i = 1; i <= 5; i++) {
    const y = (i / 6) * H;
    const w = 0.72 * (1 - y / (H * 2.2));
    parts.add(gBox(w, 0.08, 0.08, 0.03, 1), steel, [0, y, 0]);
    parts.add(gBox(0.08, 0.08, w, 0.03, 1), steel, [0, y, 0]);
    if (i % 2 === 0) {
      parts.add(gBox(w * 1.4, 0.06, 0.06, 0.02, 1), steel, [0, y, 0], [0, 0, 0.5]);
    }
  }
  // Cross-arms with insulators.
  for (const y of [H * 0.72, H * 0.92]) {
    parts.add(gBox(2.5, 0.12, 0.14, 0.04, 1), steel, [0, y, 0]);
    for (const sx of [-1, 1]) {
      parts.add(gCyl(0.09, 0.09, 0.26, 8), glow, [sx * 1.15, y - 0.2, 0]);
    }
  }
  parts.add(gBox(0.95, 0.16, 0.95, 0.05, 1), steel, [0, 0.08, 0]);
  parts.into(g, true, false);

  const beacon = new THREE.Mesh(gSph(0.13, 8, 6), glowMat(PAL.danger, 0.9, true));
  beacon.position.y = H + 0.12;
  g.add(beacon);
  g.userData.collider = 0.5;
  return g;
}

/** A bank of capacitors with a pulsing charge readout. */
export function createCapacitorBank(): THREE.Group {
  const g = group('capacitorBank');
  const parts = new PartSet();
  const frame = toonMat(PAL.metalDark, { map: getTextureTiled('circuit', 2, 1) });
  const cap = plainMat(PAL.metalMid);
  const trim = plainMat(PAL.bossAccent);

  parts.add(gBox(2.3, 0.34, 1.1, 0.08, 1), frame, [0, 0.17, 0]);
  parts.add(gBox(2.3, 1.5, 0.18, 0.06, 1), frame, [0, 0.9, -0.45]);
  for (let i = 0; i < 4; i++) {
    const x = -0.82 + i * 0.55;
    parts.add(gCyl(0.2, 0.2, 1.1, 10), cap, [x, 0.9, 0.1]);
    parts.add(gTorus(0.21, 0.045, 4, 12), trim, [x, 1.38, 0.1], [HALF_PI, 0, 0]);
    parts.add(gCyl(0.06, 0.06, 0.2, 6), trim, [x, 1.52, 0.1]);
  }
  // Bus bar linking the tops.
  parts.add(gBox(2.0, 0.08, 0.1, 0.03, 1), trim, [0, 1.6, 0.1]);
  parts.into(g, true, true);

  for (let i = 0; i < 4; i++) {
    const led = new THREE.Mesh(gSph(0.07, 6, 5), glowMat(PAL.energy, 0.9, true));
    led.position.set(-0.82 + i * 0.55, 1.3, -0.34);
    g.add(led);
  }
  g.userData.collider = 1.25;
  return g;
}

/** A big elbow of storm pipework with glowing joints. */
export function createStormPipe(): THREE.Group {
  const g = group('stormPipe');
  const parts = new PartSet();
  const pipe = toonMat(PAL.metalDark, { map: getTextureTiled('metalPanel', 2, 1) });
  const joint = plainMat(PAL.metalMid);

  parts.add(gCyl(0.38, 0.38, 2.2, 12), pipe, [0, 1.1, 0]);
  parts.add(gTorus(0.4, 0.09, 5, 14), joint, [0, 2.1, 0], [HALF_PI, 0, 0]);
  parts.add(gCyl(0.34, 0.34, 1.5, 12), pipe, [0.75, 2.25, 0], [0, 0, HALF_PI]);
  parts.add(gTorus(0.36, 0.08, 5, 14), joint, [1.4, 2.25, 0], [0, HALF_PI, 0]);
  parts.add(gCyl(0.5, 0.5, 0.2, 12), joint, [0, 0.1, 0]);
  parts.into(g, true, true);

  for (const p of [[0, 2.1, 0], [1.42, 2.25, 0]] as V3[]) {
    const ring = new THREE.Mesh(gTorus(0.42, 0.04, 4, 14), glowMat(PAL.energy, 0.8, true));
    ring.position.set(p[0], p[1], p[2]);
    ring.rotation.x = HALF_PI;
    g.add(ring);
  }
  g.userData.collider = 0.55;
  return g;
}

// ---------------------------------------------------------------------------
// Gameplay props: collectibles, portal, hazards
// ---------------------------------------------------------------------------

/**
 * The common collectible: a chunky gold hex-bolt with a bright core.
 *
 * This one is worth agonising over — the player sees hundreds per run at small
 * on-screen size. It's a hexagonal head with a bevelled collar and a glowing
 * inner slot, plus an unlit halo billboard so it stays visible against a bright
 * sky *and* a dark storm without ever changing colour.
 */
export function createBoltPickup(): THREE.Group {
  const g = group('bolt');
  const parts = new PartSet();
  const gold = plainMat(PAL.bolt);
  const hot = plainMat(PAL.boltHot);

  parts.add(gCyl(0.24, 0.24, 0.16, 6), gold, [0, 0, 0]);
  parts.add(gCyl(0.26, 0.26, 0.05, 6), hot, [0, 0.09, 0]);
  parts.add(gCyl(0.15, 0.15, 0.22, 8), gold, [0, -0.14, 0]);
  parts.into(g, false, false);

  const core = new THREE.Mesh(gCyl(0.1, 0.1, 0.2, 6), glowMat(PAL.boltHot, 0.95, true));
  g.add(core);
  const halo = new THREE.Sprite(spriteMat('glowSprite', PAL.bolt, true));
  halo.scale.setScalar(0.9);
  g.add(halo);

  g.userData.core = core;
  g.userData.halo = halo;
  // Tipped over slightly and scaled up: the hex head reads as a *bolt* from
  // the game camera instead of dissolving into its own glow.
  g.rotation.set(0.42, 0, 0.26);
  g.scale.setScalar(1.25);
  return g;
}

/**
 * The major collectible: a cyan energy cell in a metal cradle. Deliberately
 * twice the size of a bolt and a different *shape*, not just a different
 * colour, so it never gets lost in a crowd of bolts.
 */
export function createEnergyCell(): THREE.Group {
  const g = group('energyCell');
  const parts = new PartSet();
  const shell = plainMat(PAL.metalLight);
  const dark = plainMat(PAL.metalDark);

  // Cradle: two end caps joined by four ribs, leaving the core visible.
  for (const sy of [-1, 1]) {
    parts.add(gCyl(0.28, 0.24, 0.14, 8), shell, [0, sy * 0.4, 0]);
    parts.add(gTorus(0.28, 0.05, 4, 12), dark, [0, sy * 0.33, 0], [HALF_PI, 0, 0]);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    parts.add(gBox(0.08, 0.72, 0.08, 0.03, 1), shell,
      [Math.cos(a) * 0.24, 0, Math.sin(a) * 0.24], [0, -a, 0]);
  }
  parts.into(g, false, false);

  const core = new THREE.Mesh(gCap(0.19, 0.44, 10), glowMat(PAL.cellHot, 0.95, true));
  g.add(core);
  const halo = new THREE.Sprite(spriteMat('glowSprite', PAL.cell, true));
  halo.scale.setScalar(2.0);
  g.add(halo);
  const ring = new THREE.Mesh(gTorus(0.42, 0.03, 4, 18), glowMat(PAL.cell, 0.7, true));
  ring.rotation.x = HALF_PI;
  g.add(ring);

  g.userData.core = core;
  g.userData.halo = halo;
  g.userData.ring = ring;
  return g;
}

/**
 * The cage a Sparkie is trapped in. A dark clamped base with a translucent
 * dome and three energy locks — dashing or zapping it pops the dome open.
 * `userData`: `{ dome, locks, glow }`.
 */
export function createSparkiePod(): THREE.Group {
  const g = group('sparkiePod');
  const parts = new PartSet();
  const base = plainMat(PAL.metalDark);
  const clamp = plainMat(PAL.droneShellDark);

  parts.add(gCyl(0.62, 0.72, 0.26, 14), base, [0, 0.13, 0]);
  parts.add(gTorus(0.6, 0.08, 5, 16), clamp, [0, 0.28, 0], [HALF_PI, 0, 0]);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU;
    parts.add(gBox(0.16, 0.62, 0.14, 0.05, 1), clamp,
      [Math.cos(a) * 0.52, 0.5, Math.sin(a) * 0.52], [0, -a, 0.12]);
  }
  parts.add(gCyl(0.2, 0.26, 0.12, 8), base, [0, 0.02, 0]);
  parts.into(g, true, true);

  // Translucent dome — the Sparkie model goes inside it.
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(0.56, 14, 10, 0, TAU, 0, Math.PI * 0.55),
    toonMat(PAL.sparkieShell, { transparent: true, opacity: 0.34, unique: true, side: THREE.DoubleSide }),
  );
  dome.position.y = 0.28;
  g.add(dome);

  // Three magenta locks: the "this is hostile tech" colour cue.
  const locks: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.5;
    const lock = new THREE.Mesh(gSph(0.11, 8, 6), glowMat(PAL.droneTrim, 0.95, true));
    lock.position.set(Math.cos(a) * 0.55, 0.62, Math.sin(a) * 0.55);
    g.add(lock);
    locks.push(lock);
  }
  const glow = new THREE.Mesh(gCircle(0.85, 18), glowMat(PAL.droneTrim, 0.35, true));
  glow.position.y = 0.03;
  g.add(glow);

  g.userData.dome = dome;
  g.userData.locks = locks;
  g.userData.glow = glow;
  g.userData.collider = 0.7;
  return g;
}

/** A repair pickup: a heart made out of two bolt-heads and a wrench tail. */
export function createHeartPickup(): THREE.Group {
  const g = group('heart');
  const parts = new PartSet();
  const body = plainMat(PAL.heart);
  const trim = plainMat(0xffd0dc);

  for (const sx of [-1, 1]) {
    parts.add(gSph(0.19, 10, 8), body, [sx * 0.15, 0.12, 0]);
    parts.add(gCyl(0.1, 0.1, 0.06, 6), trim, [sx * 0.15, 0.12, 0.19], [HALF_PI, 0, 0]);
  }
  parts.add(gCone(0.3, 0.42, 4), body, [0, -0.14, 0], [Math.PI, Math.PI * 0.25, 0]);
  parts.into(g, false, false);

  const halo = new THREE.Sprite(spriteMat('glowSprite', PAL.heart, true));
  halo.scale.setScalar(1.7);
  g.add(halo);
  g.userData.halo = halo;
  return g;
}

/**
 * The stage exit: a decorated arch with a swirling energy disc.
 * `userData`: `{ ring, disc, glow, arms }`.
 */
export function createPortal(theme: PropTheme): THREE.Group {
  const g = group('portal');
  const s = STYLE[theme];
  const parts = new PartSet();
  const frame = metalMat(theme, 4);
  const trim = plainMat(s.accent);

  // Base plinth + two supports.
  parts.add(gBox(3.4, 0.32, 1.4, 0.1, 1), frame, [0, 0.16, 0]);
  parts.add(gBox(3.6, 0.12, 1.6, 0.05, 1), trim, [0, 0.34, 0]);
  for (const sx of [-1, 1]) {
    parts.add(gBox(0.4, 2.6, 0.5, 0.12, 1), frame, [sx * 1.5, 1.6, 0], [0, 0, sx * 0.06]);
    parts.add(gBox(0.5, 0.24, 0.6, 0.07, 1), trim, [sx * 1.55, 2.95, 0]);
    parts.add(gCyl(0.13, 0.13, 0.7, 8), frame, [sx * 1.2, 3.1, 0], [0, 0, sx * 0.5]);
  }
  parts.into(g, true, true);

  // The ring the disc lives in.
  const ring = new THREE.Mesh(gTorus(1.42, 0.18, 8, 26), plainMat(s.metal));
  ring.position.y = 2.1;
  ring.castShadow = true;
  g.add(ring);
  const innerRing = new THREE.Mesh(gTorus(1.28, 0.07, 5, 26), glowMat(s.glow, 0.9, true));
  innerRing.position.y = 2.1;
  g.add(innerRing);

  // Swirling disc — the game scrolls this material's map.
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(1.26, 28),
    new THREE.MeshBasicMaterial({
      map: getTexture('gridGlow'),
      color: s.glow,
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    }),
  );
  disc.position.y = 2.1;
  g.add(disc);

  // Four orbiting energy nodes so the portal reads as *active*.
  const arms = new THREE.Group();
  arms.position.y = 2.1;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    const node = new THREE.Mesh(gSph(0.15, 8, 6), glowMat(s.glow, 0.95, true));
    node.position.set(Math.cos(a) * 1.42, 0, Math.sin(a) * 1.42);
    arms.add(node);
  }
  g.add(arms);

  const glow = new THREE.Mesh(gCircle(2.4, 24), glowMat(s.glow, 0.3, true));
  glow.position.y = 0.05;
  g.add(glow);

  g.userData.ring = innerRing;
  g.userData.disc = disc;
  g.userData.glow = glow;
  g.userData.arms = arms;
  return g;
}

/** A chevron speed pad. Flat, no collider — the player rides straight over it. */
export function createBoostPad(): THREE.Group {
  const g = group('boostPad');
  // A visibly raised, brightly rimmed slab. A near-flush dark plate reads as a
  // wireframe rectangle from the game camera and the player never notices it.
  const plate = new THREE.Mesh(gBox(2.4, 0.26, 3.6, 0.09, 1), plainMat(0x6f7bb0));
  plate.position.y = 0.13;
  plate.receiveShadow = true;
  plate.castShadow = true;
  g.add(plate);
  const rim = new THREE.Mesh(gBox(2.62, 0.14, 3.82, 0.07, 1), plainMat(PAL.energy));
  rim.position.y = 0.07;
  g.add(rim);

  // Three chevrons pointing along -Z (the pad's forward direction).
  const chevrons: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const chev = new THREE.Group();
    for (const sx of [-1, 1]) {
      const bar = new THREE.Mesh(gBox(1.25, 0.1, 0.46, 0.045, 1), glowMat(PAL.energy, 0.95, true));
      bar.position.set(sx * 0.42, 0, 0);
      bar.rotation.y = sx * 0.62;
      chev.add(bar);
    }
    chev.position.set(0, 0.28, 0.95 - i * 0.95);
    g.add(chev);
    chevrons.push(chev as unknown as THREE.Mesh);
  }
  const edge = new THREE.Mesh(gBox(2.5, 0.06, 3.7, 0.03, 1), glowMat(PAL.energy, 0.3, true));
  edge.position.y = 0.235;
  g.add(edge);

  g.userData.chevrons = chevrons;
  g.userData.collider = 0;
  return g;
}

/**
 * A rotating blade hazard. The housing is hazard-striped and the blade sits
 * *above* the deck so the danger zone is always visible from the game camera.
 * `userData.spinner` is the blade assembly.
 */
export function createHazardFan(radius = 2.2): THREE.Group {
  const g = group('hazardFan');
  const parts = new PartSet();
  const housing = hazardMat();
  const dark = plainMat(PAL.hazardDark);

  parts.add(gCyl(radius * 0.42, radius * 0.5, 0.3, 14), dark, [0, 0.15, 0]);
  parts.add(gTorus(radius, 0.16, 6, 24), housing, [0, 0.14, 0], [HALF_PI, 0, 0]);
  // Spokes tying the outer ring to the hub — also reads as a warning pattern.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    parts.add(gBox(radius * 1.9, 0.1, 0.16, 0.04, 1), dark, [0, 0.14, 0], [0, a, 0]);
  }
  parts.add(gCyl(0.2, 0.2, 1.05, 10), dark, [0, 0.55, 0]);
  parts.into(g, true, true);

  const blades = new THREE.Group();
  blades.position.y = 0.95;
  const hub = new THREE.Mesh(gCyl(0.3, 0.3, 0.24, 12), plainMat(PAL.metalLight));
  blades.add(hub);
  for (let i = 0; i < 3; i++) {
    const blade = new THREE.Mesh(gBox(radius * 1.85, 0.11, 0.44, 0.05, 1), plainMat(PAL.metalLight));
    blade.rotation.y = (i / 3) * Math.PI;
    blade.rotation.z = 0.12;
    blade.castShadow = true;
    blades.add(blade);
    const tip = new THREE.Mesh(gSph(0.16, 8, 6), plainMat(PAL.hazard));
    tip.position.set(Math.cos((i / 3) * Math.PI) * radius * 0.92, 0, -Math.sin((i / 3) * Math.PI) * radius * 0.92);
    blades.add(tip);
  }
  g.add(blades);

  // Ground decal marking the swept area — the readability guarantee.
  const decal = new THREE.Mesh(gCircle(radius, 28), new THREE.MeshBasicMaterial({
    map: getTexture('ringSprite'), color: PAL.hazard, transparent: true, opacity: 0.4,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false,
  }));
  decal.position.y = 0.02;
  g.add(decal);

  g.userData.spinner = blades;
  g.userData.spinSpeed = 3.0;
  g.userData.spinAxis = 'y';
  g.userData.radius = radius;
  g.userData.collider = 0.45;
  return g;
}

/** A floor vent that periodically jets steam. The game drives the particles. */
export function createSteamVent(): THREE.Group {
  const g = group('steamVent');
  const parts = new PartSet();
  const frame = hazardMat();
  const grate = plainMat(PAL.metalDark);

  parts.add(gCyl(0.78, 0.85, 0.16, 12), frame, [0, 0.08, 0]);
  parts.add(gCyl(0.6, 0.6, 0.1, 12), grate, [0, 0.17, 0]);
  for (let i = 0; i < 5; i++) {
    parts.add(gBox(1.15, 0.06, 0.11, 0.02, 1), plainMat(PAL.metalMid),
      [0, 0.22, -0.42 + i * 0.21]);
  }
  parts.into(g, false, true);

  const glow = new THREE.Mesh(gCircle(0.58, 16), glowMat(PAL.hazard, 0.35, true));
  glow.position.y = 0.24;
  g.add(glow);
  g.userData.glow = glow;
  g.userData.collider = 0;
  return g;
}

/**
 * A moving energy wall between two posts. `userData.field` is the animated
 * plane (the game scrolls its texture and pulses its opacity).
 */
export function createEnergyBarrier(width = 6, height = 3.2): THREE.Group {
  const g = group('energyBarrier');
  const parts = new PartSet();
  const post = plainMat(PAL.metalDark);
  const trim = plainMat(PAL.danger);

  for (const sx of [-1, 1]) {
    const x = sx * width * 0.5;
    parts.add(gBox(0.44, height + 0.5, 0.44, 0.1, 1), post, [x, (height + 0.5) * 0.5, 0]);
    parts.add(gBox(0.7, 0.22, 0.7, 0.07, 1), post, [x, 0.11, 0]);
    parts.add(gTorus(0.3, 0.07, 5, 12), trim, [x, height * 0.35, 0], [HALF_PI, 0, 0]);
    parts.add(gTorus(0.3, 0.07, 5, 12), trim, [x, height * 0.8, 0], [HALF_PI, 0, 0]);
    parts.add(gCyl(0.18, 0.24, 0.3, 8), trim, [x, height + 0.6, 0]);
  }
  parts.into(g, true, true);

  const fieldTex = getTextureTiled('gridGlow', Math.max(2, width / 2), 2);
  const field = new THREE.Mesh(
    new THREE.PlaneGeometry(width - 0.4, height),
    new THREE.MeshBasicMaterial({
      map: fieldTex,
      color: PAL.danger,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    }),
  );
  field.position.y = height * 0.5 + 0.1;
  g.add(field);

  // Bright edge lines so the wall's extent is unmistakable.
  for (const y of [0.14, height + 0.06]) {
    const edge = new THREE.Mesh(gBox(width - 0.4, 0.07, 0.07, 0.03, 1), glowMat(PAL.danger, 0.9, true));
    edge.position.y = y;
    g.add(edge);
  }

  g.userData.field = field;
  g.userData.width = width;
  g.userData.height = height;
  return g;
}

// ---------------------------------------------------------------------------
// Background dressing
// ---------------------------------------------------------------------------

/** A chunky merged-sphere cloud for the mid-distance sky layer. */
export function createCloudPuff(seed = 1): THREE.Group {
  const g = group('cloudPuff');
  const r = propRandom(seed * 71 + 17);
  const parts = new PartSet();
  const mat = toonMat(0xffffff, { ramp: 'soft', unique: false });
  const lobes = 5 + Math.floor(r() * 4);
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * TAU + rr(r, -0.4, 0.4);
    const rad = i === 0 ? 0 : rr(r, 0.5, 1.5);
    parts.add(gSph(rr(r, 0.7, 1.35), 8, 6), mat,
      [Math.cos(a) * rad, rr(r, -0.2, 0.35), Math.sin(a) * rad * 0.55],
      undefined, [1, 0.7, 1]);
  }
  parts.into(g, false, false);
  return g;
}

/**
 * A cheap silhouette island for the horizon ring. No shadows, low poly, and a
 * couple of theme-coloured lumps on top so it isn't just a grey blob.
 */
export function createDistantIsland(seed: number, theme: PropTheme): THREE.Group {
  const g = group('distantIsland');
  const r = propRandom(seed * 53 + 29);
  const s = STYLE[theme];
  const parts = new PartSet();
  const top = plainMat(s.topTint);
  const rock = plainMat(s.under);
  const accent = plainMat(s.accent);

  const radius = rr(r, 2.2, 3.6);
  parts.add(gCyl(radius, radius * 0.86, 0.5, 10), top, [0, 0, 0]);
  parts.add(gCone(radius * 0.92, rr(r, 2.0, 3.6), 9), rock,
    [0, -rr(r, 1.1, 1.9), 0], [Math.PI, 0, 0]);

  // A silhouette or two on top: a tower, a tree-ish lump, a mast.
  const bits = 1 + Math.floor(r() * 3);
  for (let i = 0; i < bits; i++) {
    const a = rr(r, 0, TAU);
    const d = rr(r, 0, radius * 0.6);
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (theme === 'gardens' && r() < 0.7) {
      parts.add(gIco(rr(r, 0.5, 0.9), 0), plainMat(PAL.leafMid), [x, rr(r, 0.7, 1.2), z]);
      parts.add(gCyl(0.1, 0.14, 0.8, 5), rock, [x, 0.55, z]);
    } else {
      const h = rr(r, 0.9, 2.2);
      parts.add(gBox(rr(r, 0.5, 0.9), h, rr(r, 0.5, 0.9), 0.08, 1), top, [x, 0.25 + h * 0.5, z]);
      parts.add(gBox(0.36, 0.16, 0.36, 0.05, 1), accent, [x, 0.3 + h, z]);
    }
  }
  parts.into(g, false, false);
  return g;
}

/** Frees the geometry created directly by this module. */
export function disposeProps(): void {
  // Geometry and materials all come from the shared caches in Materials.ts and
  // Textures.ts, which own their own lifetimes; nothing extra is retained here.
}
