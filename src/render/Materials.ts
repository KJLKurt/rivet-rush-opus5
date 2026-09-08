/**
 * Rivet Rush — the stylized material system.
 *
 * Everything in the world is shaded with `MeshToonMaterial` + a procedural
 * gradient ramp: it is cheap on mobile and gives the chunky, banded cel look the
 * art direction asks for. Characters, enemies and the boss additionally get an
 * inverted-hull ink outline so they pop against busy islands; the environment
 * never gets one, which keeps the draw call count sane.
 *
 * Materials, outline materials and rounded-box geometries are all cached and
 * reused — an arena asks for the same "mid metal" material hundreds of times.
 */

import * as THREE from 'three';
import { PAL } from './Palette';
import { getTexture } from './Textures';
import type { TextureKey } from './Textures';

export interface ToonOptions {
  /** Which gradient ramp to shade with. Default `'soft'`. */
  ramp?: 'soft' | 'hard3' | 'hard4';
  map?: THREE.Texture;
  emissive?: number;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  flatShading?: boolean;
  side?: THREE.Side;
  /** Skip the cache and return a unique instance the caller may mutate/animate. */
  unique?: boolean;
}

export type QualityLevel = 'low' | 'medium' | 'high';

/** Ink colour for outlines: PAL.maskDark pushed much darker — never pure black. */
const INK: number = new THREE.Color(PAL.maskDark).multiplyScalar(0.25).getHex();

const RAMP_KEY: Record<'soft' | 'hard3' | 'hard4', TextureKey> = {
  soft: 'toonRampSoft',
  hard3: 'toonRamp3',
  hard4: 'toonRamp4',
};

const toonCache = new Map<string, THREE.MeshToonMaterial>();
const glowCache = new Map<string, THREE.MeshBasicMaterial>();
const spriteCache = new Map<string, THREE.SpriteMaterial>();
const outlineCache = new Map<string, THREE.MeshBasicMaterial>();
const geoCache = new Map<string, THREE.BufferGeometry>();
/** Every live outline mesh, so a quality change can switch them all off. */
const liveOutlines = new Set<THREE.Mesh>();

let quality: QualityLevel = 'high';

// ---------------------------------------------------------------------------
// surfaces
// ---------------------------------------------------------------------------

/**
 * The main stylized surface material.
 *
 * @param color  base colour, normally a `PAL.*` constant
 * @param opts   see {@link ToonOptions}; pass `unique: true` when the caller
 *               intends to animate `opacity` / `emissiveIntensity` / `color`.
 */
export function toonMat(color: number, opts: ToonOptions = {}): THREE.MeshToonMaterial {
  const ramp = quality === 'low' ? 'soft' : opts.ramp ?? 'soft';
  const flat = quality === 'low' ? false : opts.flatShading === true;
  const emissive = opts.emissive ?? 0x000000;
  const emissiveIntensity = opts.emissiveIntensity ?? 1;
  const opacity = opts.opacity ?? 1;
  const transparent = opts.transparent ?? opacity < 1;
  const side = opts.side ?? THREE.FrontSide;

  const make = (): THREE.MeshToonMaterial => {
    const m = new THREE.MeshToonMaterial({
      color,
      gradientMap: getTexture(RAMP_KEY[ramp]),
      emissive,
      emissiveIntensity,
      transparent,
      opacity,
      side,
      fog: true,
    });
    // three r185 doesn't declare `flatShading` on MeshToonMaterial in either
    // its parameters or its class type, but WebGLPrograms reads the property
    // generically off the material, so setting it here does work at runtime.
    (m as THREE.Material & { flatShading?: boolean }).flatShading = flat;
    if (opts.map) m.map = opts.map;
    m.dithering = true;
    if (transparent) m.depthWrite = opacity > 0.92;
    return m;
  };

  if (opts.unique) return make();

  const key = [
    color, ramp, opts.map ? opts.map.uuid : '-', emissive, emissiveIntensity,
    transparent ? 1 : 0, opacity, flat ? 1 : 0, side,
  ].join('|');
  const hit = toonCache.get(key);
  if (hit) return hit;
  const m = make();
  toonCache.set(key, m);
  return m;
}

/**
 * Unlit, always-bright material for energy cores, glows and eyes. Additive
 * variants are used for anything that should read as pure light.
 */
export function glowMat(color: number, opacity = 1, additive = false): THREE.MeshBasicMaterial {
  const key = `${color}|${opacity}|${additive ? 1 : 0}`;
  const hit = glowCache.get(key);
  if (hit) return hit;

  const m = new THREE.MeshBasicMaterial({
    color,
    transparent: additive || opacity < 1,
    opacity,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite: !additive && opacity >= 1,
    fog: !additive,
    toneMapped: false,
  });
  glowCache.set(key, m);
  return m;
}

/** Billboard sprite material for particles, halos and shockwaves. */
export function spriteMat(
  texKey: 'glowSprite' | 'sparkSprite' | 'ringSprite' | 'smokeSprite' | 'cloudSprite',
  color: number,
  additive = true,
): THREE.SpriteMaterial {
  const key = `${texKey}|${color}|${additive ? 1 : 0}`;
  const hit = spriteCache.get(key);
  if (hit) return hit;

  const m = new THREE.SpriteMaterial({
    map: getTexture(texKey),
    color,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    fog: !additive,
    toneMapped: !additive,
  });
  spriteCache.set(key, m);
  return m;
}

// ---------------------------------------------------------------------------
// inverted-hull outlines (characters / enemies / boss only)
// ---------------------------------------------------------------------------

function outlineMaterial(thickness: number, color: number): THREE.MeshBasicMaterial {
  const key = `${thickness}|${color}`;
  const hit = outlineCache.get(key);
  if (hit) return hit;

  const m = new THREE.MeshBasicMaterial({
    color,
    side: THREE.BackSide,
    blending: THREE.NormalBlending,
    transparent: false,
    depthWrite: true,
    fog: true,
    toneMapped: false,
  });

  m.onBeforeCompile = (shader) => {
    shader.uniforms.outlineThickness = { value: thickness };
    shader.vertexShader = 'uniform float outlineThickness;\n' + shader.vertexShader.replace(
      '#include <project_vertex>',
      [
        '#include <project_vertex>',
        // Push the hull along the view-space normal. Because normalMatrix is the
        // inverse-transpose of the model-view matrix, the offset is in metres and
        // is therefore identical no matter how the mesh is scaled.
        'vec3 rrOutlineNormal = normalize( normalMatrix * normal );',
        'gl_Position = projectionMatrix * vec4( mvPosition.xyz + rrOutlineNormal * outlineThickness, 1.0 );',
      ].join('\n'),
    );
  };
  // All outline materials compile to the same program, so share it.
  m.customProgramCacheKey = () => 'rr-outline';

  outlineCache.set(key, m);
  return m;
}

/**
 * Builds the inverted-hull outline mesh for `geometry`. Add the result as a
 * child of the mesh it outlines (so it inherits every animated transform):
 *
 * ```ts
 * mesh.add(makeOutline(mesh.geometry));
 * ```
 */
export function makeOutline(
  geometry: THREE.BufferGeometry,
  thickness = 0.035,
  color: number = INK,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, outlineMaterial(thickness, color));
  mesh.name = 'outline';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.isOutline = true;
  mesh.renderOrder = -1;
  mesh.visible = quality !== 'low';
  liveOutlines.add(mesh);
  return mesh;
}

/**
 * Walks `root` and gives every Mesh child an outline. Meshes flagged with
 * `userData.noOutline` (and existing outlines) are skipped. Returns the meshes
 * that were added — a no-op returning `[]` on `'low'` quality.
 */
export function outlineGroup(
  root: THREE.Object3D,
  thickness = 0.035,
  color: number = INK,
): THREE.Mesh[] {
  if (quality === 'low') return [];

  const targets: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.userData.isOutline || m.userData.noOutline) return;
    if (!m.geometry || !m.geometry.getAttribute('normal')) return;
    targets.push(m);
  });

  const added: THREE.Mesh[] = [];
  for (const t of targets) {
    const o = makeOutline(t.geometry, thickness, color);
    t.add(o);
    added.push(o);
  }
  return added;
}

// ---------------------------------------------------------------------------
// quality
// ---------------------------------------------------------------------------

/**
 * Global quality hook. `'low'` disables outlines (existing ones are hidden, so
 * their draw calls disappear) and flat shading; new materials created afterwards
 * use the cheap soft ramp.
 */
export function setMaterialQuality(level: QualityLevel): void {
  if (level === quality) return;
  quality = level;
  const show = level !== 'low';
  for (const o of Array.from(liveOutlines)) {
    if (!o.parent) {
      liveOutlines.delete(o); // pruned when its owner was removed from the scene
      continue;
    }
    o.visible = show;
  }
}

export function getMaterialQuality(): QualityLevel {
  return quality;
}

// ---------------------------------------------------------------------------
// rounded box geometry
// ---------------------------------------------------------------------------

/**
 * A real rounded box: flat faces, filleted edges and spherical corners, built as
 * one indexed sphere-like grid whose octants are pushed apart by the box's inner
 * half-extents. Normals are analytic and the UVs are planar per dominant axis,
 * so tiling textures keep a constant texel density.
 *
 * Triangle budget: `segments = 1` → 48 tris (a crisp chamfer), `2` → 120,
 * `3` → 224. Results are cached, so ask for the same size repeatedly.
 */
export function roundedBoxGeometry(
  w: number,
  h: number,
  d: number,
  radius = 0.12,
  segments = 2,
): THREE.BufferGeometry {
  const seg = Math.max(1, Math.round(segments));
  const r = Math.max(0.0001, Math.min(radius, w * 0.5, h * 0.5, d * 0.5));
  const key = `rb|${w.toFixed(4)}|${h.toFixed(4)}|${d.toFixed(4)}|${r.toFixed(4)}|${seg}`;
  const hit = geoCache.get(key);
  if (hit) return hit;

  const hx = Math.max(0, w * 0.5 - r);
  const hy = Math.max(0, h * 0.5 - r);
  const hz = Math.max(0, d * 0.5 - r);

  const rows = 2 * (seg + 1);       // two hemispheres, duplicated at the equator
  const cols = 4 * (seg + 1);       // four quadrants, duplicated at each seam
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];

  for (let row = 0; row < rows; row++) {
    const hemi = row < seg + 1 ? 0 : 1;
    const i = hemi === 0 ? row : row - (seg + 1);
    const theta = (hemi * 0.5 + (i / seg) * 0.5) * Math.PI;
    const sy = hemi === 0 ? 1 : -1;
    const st = Math.sin(theta);
    const ct = Math.cos(theta);

    for (let col = 0; col < cols; col++) {
      const quad = Math.floor(col / (seg + 1));
      const j = col - quad * (seg + 1);
      const phi = (quad + j / seg) * Math.PI * 0.5;
      const sx = quad === 0 || quad === 3 ? 1 : -1;
      const sz = quad === 0 || quad === 1 ? 1 : -1;

      const nx = st * Math.cos(phi);
      const ny = ct;
      const nz = st * Math.sin(phi);

      const px = nx * r + sx * hx;
      const py = ny * r + sy * hy;
      const pz = nz * r + sz * hz;

      positions.push(px, py, pz);
      normals.push(nx, ny, nz);

      const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
      if (ay >= ax && ay >= az) uvs.push((px + w * 0.5) / w, (pz + d * 0.5) / d);
      else if (ax >= az) uvs.push((pz + d * 0.5) / d, (py + h * 0.5) / h);
      else uvs.push((px + w * 0.5) / w, (py + h * 0.5) / h);
    }
  }

  const index: number[] = [];
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols; col++) {
      const c1 = (col + 1) % cols;
      const a = row * cols + col;
      const b = row * cols + c1;
      const c = (row + 1) * cols + col;
      const dI = (row + 1) * cols + c1;
      // skip the degenerate triangles that collapse at the top / bottom faces
      if (a !== b) index.push(a, b, c);
      if (c !== dI) index.push(b, dI, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(index);
  geo.computeBoundingSphere();
  geo.name = key;

  geoCache.set(key, geo);
  return geo;
}

/** Cached geometry helper shared with the prop kit. */
export function cacheGeometry(key: string, build: () => THREE.BufferGeometry): THREE.BufferGeometry {
  const hit = geoCache.get(key);
  if (hit) return hit;
  const geo = build();
  geo.name = key;
  geoCache.set(key, geo);
  return geo;
}

/** The default ink colour, exported so characters can match trims to it. */
export const OUTLINE_INK = INK;

/** Frees every cached material and geometry. Safe to call more than once. */
export function disposeMaterials(): void {
  for (const m of toonCache.values()) m.dispose();
  for (const m of glowCache.values()) m.dispose();
  for (const m of spriteCache.values()) m.dispose();
  for (const m of outlineCache.values()) m.dispose();
  for (const g of geoCache.values()) g.dispose();
  toonCache.clear();
  glowCache.clear();
  spriteCache.clear();
  outlineCache.clear();
  geoCache.clear();
  liveOutlines.clear();
}
