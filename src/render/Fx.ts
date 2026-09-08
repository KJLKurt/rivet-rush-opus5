import * as THREE from 'three';
import { getTexture } from './Textures';
import { clamp01, makeRandom, swapRemove } from '../core/Util';

/**
 * Every non-character visual effect in the game lives here.
 *
 * Budget-conscious by construction:
 *  - All point particles share three `THREE.Points` batches (one per sprite
 *    look), each a fixed-size pre-allocated buffer with a free list. Emitting a
 *    thousand sparks costs zero allocations and zero new draw calls.
 *  - Ground rings, flashes and debris are pooled meshes that are hidden rather
 *    than destroyed.
 *  - When the budget is exhausted the oldest particle is recycled, so a heavy
 *    moment degrades gracefully instead of stuttering.
 */

const PARTICLE_VS = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aAlpha;
  attribute float aRot;
  uniform float uPixelScale;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vRot;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vRot = aRot;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(1.0, aSize * uPixelScale / max(0.001, -mv.z));
  }
`;

const PARTICLE_FS = /* glsl */ `
  uniform sampler2D uMap;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vRot;
  void main() {
    if (vAlpha <= 0.001) discard;
    vec2 uv = gl_PointCoord - 0.5;
    float s = sin(vRot);
    float c = cos(vRot);
    uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c) + 0.5;
    vec4 tex = texture2D(uMap, uv);
    gl_FragColor = vec4(vColor * tex.rgb, tex.a * vAlpha);
    if (gl_FragColor.a < 0.004) discard;
  }
`;

type ParticleKind = 'glow' | 'spark' | 'smoke';

interface Particle {
  idx: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; maxLife: number;
  size: number; endSize: number;
  r: number; g: number; b: number;
  alpha: number;
  drag: number;
  gravity: number;
  rot: number; spin: number;
  /** Bounce off the ground plane instead of passing through it. */
  bounce: number;
  /** Fade curve: 0 = linear, 1 = fast-in slow-out. */
  curve: number;
}

class ParticleBatch {
  readonly points: THREE.Points;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly rot: Float32Array;
  private readonly live: Particle[] = [];
  private readonly freeIdx: number[] = [];
  readonly capacity: number;

  constructor(kind: ParticleKind, capacity: number, additive: boolean) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.rot = new Float32Array(capacity);
    for (let i = capacity - 1; i >= 0; i--) {
      this.freeIdx.push(i);
      this.pos[i * 3 + 1] = -9999;
    }

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    this.geo.setAttribute('aRot', new THREE.BufferAttribute(this.rot, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const texKey = kind === 'glow' ? 'glowSprite' : kind === 'spark' ? 'sparkSprite' : 'smokeSprite';
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: getTexture(texKey) },
        uPixelScale: { value: 600 },
      },
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: false,
    });

    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 12 : 10;
  }

  setPixelScale(v: number): void {
    this.mat.uniforms.uPixelScale!.value = v;
  }

  spawn(p: Omit<Particle, 'idx'>): void {
    let idx = this.freeIdx.pop();
    if (idx === undefined) {
      // Budget exhausted: steal the oldest live particle.
      const oldest = this.live.shift();
      if (!oldest) return;
      idx = oldest.idx;
    }
    const particle = p as Particle;
    particle.idx = idx;
    this.live.push(particle);
  }

  update(dt: number): void {
    const { pos, col, size, alpha, rot, live } = this;
    for (let i = live.length - 1; i >= 0; i--) {
      const p = live[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        const j = p.idx * 3;
        pos[j + 1] = -9999;
        alpha[p.idx] = 0;
        this.freeIdx.push(p.idx);
        swapRemove(live, i);
        continue;
      }
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vz *= d;
      p.vy = (p.vy - p.gravity * dt) * d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.bounce > 0 && p.y < 0.06 && p.vy < 0) {
        p.y = 0.06;
        p.vy = -p.vy * p.bounce;
        p.vx *= 0.7;
        p.vz *= 0.7;
      }
      p.rot += p.spin * dt;

      const t = 1 - p.life / p.maxLife; // 0 at birth, 1 at death
      const fade = p.curve > 0 ? 1 - t * t : 1 - t;
      const j = p.idx * 3;
      pos[j] = p.x;
      pos[j + 1] = p.y;
      pos[j + 2] = p.z;
      col[j] = p.r;
      col[j + 1] = p.g;
      col[j + 2] = p.b;
      size[p.idx] = p.size + (p.endSize - p.size) * t;
      alpha[p.idx] = p.alpha * fade;
      rot[p.idx] = p.rot;
    }
    this.geo.attributes.position!.needsUpdate = true;
    this.geo.attributes.aColor!.needsUpdate = true;
    this.geo.attributes.aSize!.needsUpdate = true;
    this.geo.attributes.aAlpha!.needsUpdate = true;
    this.geo.attributes.aRot!.needsUpdate = true;
  }

  clear(): void {
    for (const p of this.live) {
      this.pos[p.idx * 3 + 1] = -9999;
      this.alpha[p.idx] = 0;
      this.freeIdx.push(p.idx);
    }
    this.live.length = 0;
    this.geo.attributes.position!.needsUpdate = true;
    this.geo.attributes.aAlpha!.needsUpdate = true;
  }

  get liveCount(): number {
    return this.live.length;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// --- ground rings ----------------------------------------------------------

interface Ring {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
  from: number;
  to: number;
  alpha: number;
  /** Rings lying flat on the ground vs. billboarded spheres. */
  vertical: boolean;
}

export interface EmitOptions {
  count?: number;
  color?: number;
  color2?: number;
  speed?: number;
  spread?: number;
  size?: number;
  endSize?: number;
  life?: number;
  gravity?: number;
  drag?: number;
  /** Bias the burst along this direction (already normalised). */
  dirX?: number;
  dirY?: number;
  dirZ?: number;
  /** 0 = fully spherical, 1 = tightly along dir. */
  focus?: number;
  bounce?: number;
  alpha?: number;
  spin?: number;
  upBias?: number;
}

export class Fx {
  readonly root = new THREE.Group();
  private glow: ParticleBatch;
  private sparkB: ParticleBatch;
  private smoke: ParticleBatch;
  private rings: Ring[] = [];
  private ringPool: Ring[] = [];
  private rng = makeRandom(20260907);
  private intensity = 1;
  private ringGeo: THREE.PlaneGeometry;
  private ringTex: THREE.Texture;
  private glowTex: THREE.Texture;

  constructor(budgetScale = 1) {
    const s = budgetScale;
    this.glow = new ParticleBatch('glow', Math.floor(700 * s), true);
    this.sparkB = new ParticleBatch('spark', Math.floor(520 * s), true);
    this.smoke = new ParticleBatch('smoke', Math.floor(280 * s), false);
    this.root.add(this.glow.points, this.sparkB.points, this.smoke.points);
    this.ringGeo = new THREE.PlaneGeometry(1, 1);
    this.ringTex = getTexture('ringSprite');
    this.glowTex = getTexture('glowSprite');
    this.root.frustumCulled = false;
  }

  /** 0..1 — reduced-motion and low-quality both scale effect density down. */
  setIntensity(v: number): void {
    this.intensity = clamp01(v);
  }

  /** Point size scales with render height so effects look right on any screen. */
  setPixelScale(renderHeightPx: number, fovDeg: number): void {
    const scale = renderHeightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.glow.setPixelScale(scale);
    this.sparkB.setPixelScale(scale);
    this.smoke.setPixelScale(scale);
  }

  private batchFor(kind: ParticleKind): ParticleBatch {
    return kind === 'glow' ? this.glow : kind === 'spark' ? this.sparkB : this.smoke;
  }

  /** Generic burst emitter — the workhorse behind almost every effect. */
  burst(kind: ParticleKind, x: number, y: number, z: number, opts: EmitOptions = {}): void {
    const rng = this.rng;
    const n = Math.max(1, Math.round((opts.count ?? 10) * this.intensity));
    const c1 = _c1.setHex(opts.color ?? 0xffffff);
    const c2 = _c2.setHex(opts.color2 ?? opts.color ?? 0xffffff);
    const speed = opts.speed ?? 6;
    const spread = opts.spread ?? 1;
    const size = opts.size ?? 0.55;
    const endSize = opts.endSize ?? size * 0.15;
    const life = opts.life ?? 0.5;
    const focus = opts.focus ?? 0;
    const dx = opts.dirX ?? 0;
    const dy = opts.dirY ?? 0;
    const dz = opts.dirZ ?? 0;
    const batch = this.batchFor(kind);

    for (let i = 0; i < n; i++) {
      // Uniform point on a sphere, then blended toward the focus direction.
      const u = rng() * 2 - 1;
      const th = rng() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - u * u));
      let vx = Math.cos(th) * r;
      let vy = u;
      let vz = Math.sin(th) * r;
      if (focus > 0) {
        vx = vx * (1 - focus) + dx * focus;
        vy = vy * (1 - focus) + dy * focus;
        vz = vz * (1 - focus) + dz * focus;
      }
      vy += opts.upBias ?? 0;
      const sp = speed * (0.45 + rng() * 0.85) * spread;
      const mix = rng();
      batch.spawn({
        x: x + vx * 0.16,
        y: y + vy * 0.16,
        z: z + vz * 0.16,
        vx: vx * sp,
        vy: vy * sp,
        vz: vz * sp,
        life: life * (0.7 + rng() * 0.6),
        maxLife: life,
        size: size * (0.7 + rng() * 0.6),
        endSize,
        r: c1.r + (c2.r - c1.r) * mix,
        g: c1.g + (c2.g - c1.g) * mix,
        b: c1.b + (c2.b - c1.b) * mix,
        alpha: opts.alpha ?? 1,
        drag: opts.drag ?? 3.2,
        gravity: opts.gravity ?? 0,
        rot: rng() * Math.PI * 2,
        spin: (opts.spin ?? 4) * (rng() * 2 - 1),
        bounce: opts.bounce ?? 0,
        curve: 1,
      });
    }
  }

  /** Continuous emitter helper (hover dust, damage smoke, boss exhaust). */
  emitOne(
    kind: ParticleKind,
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    color: number, size: number, life: number, alpha = 1, drag = 2.4, gravity = 0,
  ): void {
    const c = _c1.setHex(color);
    this.batchFor(kind).spawn({
      x, y, z, vx, vy, vz,
      life, maxLife: life,
      size, endSize: size * 0.2,
      r: c.r, g: c.g, b: c.b,
      alpha, drag, gravity,
      rot: this.rng() * 6.28, spin: 2 * (this.rng() * 2 - 1),
      bounce: 0, curve: 1,
    });
  }

  // --- rings ---------------------------------------------------------------

  private acquireRing(vertical: boolean): Ring {
    const r = this.ringPool.pop();
    if (r) {
      r.mesh.visible = true;
      r.vertical = vertical;
      return r;
    }
    const mat = new THREE.MeshBasicMaterial({
      map: this.ringTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
    const mesh = new THREE.Mesh(this.ringGeo, mat);
    mesh.renderOrder = 11;
    this.root.add(mesh);
    return { mesh, mat, life: 0, maxLife: 1, from: 1, to: 4, alpha: 1, vertical };
  }

  /** Expanding shockwave lying flat on the ground. Dash, slams, explosions. */
  shockwave(
    x: number, y: number, z: number,
    from: number, to: number, life: number, color: number, alpha = 1, vertical = false,
  ): void {
    if (this.intensity < 0.2) return;
    const ring = this.acquireRing(vertical);
    ring.mesh.position.set(x, y, z);
    if (vertical) ring.mesh.rotation.set(0, 0, 0);
    else ring.mesh.rotation.set(-Math.PI / 2, 0, this.rng() * 6.28);
    ring.mat.color.setHex(color);
    ring.life = life;
    ring.maxLife = life;
    ring.from = from;
    ring.to = to;
    ring.alpha = alpha;
    ring.mesh.scale.setScalar(from);
    ring.mat.opacity = alpha;
    this.rings.push(ring);
  }

  /** A soft additive light-blob, used for muzzle flashes and pickups. */
  flash(x: number, y: number, z: number, radius: number, color: number, life = 0.22): void {
    const ring = this.acquireRing(true);
    ring.mesh.position.set(x, y, z);
    ring.mesh.rotation.set(0, 0, 0);
    ring.mat.map = this.glowTex;
    ring.mat.color.setHex(color);
    ring.life = life;
    ring.maxLife = life;
    ring.from = radius * 0.4;
    ring.to = radius;
    ring.alpha = 1;
    ring.mesh.scale.setScalar(ring.from);
    this.rings.push(ring);
    ring.mesh.userData.isFlash = true;
  }

  update(dt: number, camera: THREE.Camera): void {
    this.glow.update(dt);
    this.sparkB.update(dt);
    this.smoke.update(dt);

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i]!;
      ring.life -= dt;
      if (ring.life <= 0) {
        ring.mesh.visible = false;
        ring.mat.map = this.ringTex;
        ring.mesh.userData.isFlash = false;
        this.ringPool.push(ring);
        swapRemove(this.rings, i);
        continue;
      }
      const t = 1 - ring.life / ring.maxLife;
      const eased = 1 - Math.pow(1 - t, 3);
      const scale = ring.from + (ring.to - ring.from) * eased;
      ring.mesh.scale.setScalar(scale);
      ring.mat.opacity = ring.alpha * (1 - t) * (1 - t);
      if (ring.vertical) ring.mesh.quaternion.copy(camera.quaternion);
    }
  }

  clear(): void {
    this.glow.clear();
    this.sparkB.clear();
    this.smoke.clear();
    for (const ring of this.rings) {
      ring.mesh.visible = false;
      ring.mat.map = this.ringTex;
      this.ringPool.push(ring);
    }
    this.rings.length = 0;
  }

  get liveParticles(): number {
    return this.glow.liveCount + this.sparkB.liveCount + this.smoke.liveCount;
  }

  dispose(): void {
    this.glow.dispose();
    this.sparkB.dispose();
    this.smoke.dispose();
    this.ringGeo.dispose();
    for (const ring of [...this.rings, ...this.ringPool]) ring.mat.dispose();
  }
}

const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
