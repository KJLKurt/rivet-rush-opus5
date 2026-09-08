import * as THREE from 'three';
import { clamp01 } from '../core/Util';

/**
 * The hoverboard's magnetic ribbon.
 *
 * A fixed-length strip of quads whose vertices are rewritten each frame from a
 * ring buffer of recent positions. One draw call, no allocation, and it tapers
 * and fades along its length so it reads as motion rather than as a solid tube.
 * Width and brightness are driven by speed, so the trail visibly *swells* when
 * the player dashes — which is a huge part of why dashing feels good.
 */

const TRAIL_VS = /* glsl */ `
  attribute float aT;      // 0 at the head, 1 at the tail
  attribute float aSide;   // -1 / +1 across the ribbon
  varying float vT;
  varying float vSide;
  void main() {
    vT = aT;
    vSide = aSide;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TRAIL_FS = /* glsl */ `
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform float uOpacity;
  uniform float uGlow;
  varying float vT;
  varying float vSide;
  void main() {
    float edge = 1.0 - abs(vSide);
    float core = smoothstep(0.0, 0.55, edge);
    float fade = pow(1.0 - vT, 1.35);
    vec3 col = mix(uColorA, uColorB, vT);
    col += vec3(uGlow) * core * fade;
    float a = fade * core * uOpacity;
    if (a < 0.005) discard;
    gl_FragColor = vec4(col, a);
  }
`;

export class Trail {
  readonly mesh: THREE.Mesh;
  private readonly segments: number;
  private readonly positions: Float32Array;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;

  /** Ring buffer of world-space samples (x,y,z) + a per-sample width scale. */
  private readonly hist: Float32Array;
  private readonly histW: Float32Array;
  private head = 0;
  private filled = 0;
  private accum = 0;
  private lastX = 0;
  private lastY = 0;
  private lastZ = 0;
  private width = 0.5;
  private targetWidth = 0.5;
  private opacity = 0;

  constructor(segments = 30, colorA = 0x53f2ff, colorB = 0x2b7de0) {
    this.segments = segments;
    this.positions = new Float32Array(segments * 2 * 3);
    this.hist = new Float32Array(segments * 3);
    this.histW = new Float32Array(segments);

    const aT = new Float32Array(segments * 2);
    const aSide = new Float32Array(segments * 2);
    for (let i = 0; i < segments; i++) {
      const t = i / (segments - 1);
      aT[i * 2] = t;
      aT[i * 2 + 1] = t;
      aSide[i * 2] = -1;
      aSide[i * 2 + 1] = 1;
    }
    const indices: number[] = [];
    for (let i = 0; i < segments - 1; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
    this.geo.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1));
    this.geo.setIndex(indices);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uColorA: { value: new THREE.Color(colorA) },
        uColorB: { value: new THREE.Color(colorB) },
        uOpacity: { value: 0 },
        uGlow: { value: 0.25 },
      },
      vertexShader: TRAIL_VS,
      fragmentShader: TRAIL_FS,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
  }

  setColors(a: number, b: number): void {
    (this.mat.uniforms.uColorA!.value as THREE.Color).setHex(a);
    (this.mat.uniforms.uColorB!.value as THREE.Color).setHex(b);
  }

  setGlow(v: number): void {
    this.mat.uniforms.uGlow!.value = v;
  }

  reset(x: number, y: number, z: number): void {
    this.head = 0;
    this.filled = 0;
    this.lastX = x;
    this.lastY = y;
    this.lastZ = z;
    this.opacity = 0;
    for (let i = 0; i < this.segments; i++) {
      this.hist[i * 3] = x;
      this.hist[i * 3 + 1] = y;
      this.hist[i * 3 + 2] = z;
      this.histW[i] = 0;
    }
  }

  /**
   * @param widthScale  0..~2, driven by speed/dash/overdrive
   * @param visible     fades the whole ribbon out when standing still
   */
  update(
    dt: number, x: number, y: number, z: number,
    widthScale: number, visible: number, camera: THREE.Camera,
  ): void {
    this.targetWidth = widthScale;
    this.width += (this.targetWidth - this.width) * Math.min(1, dt * 16);
    this.opacity += (clamp01(visible) - this.opacity) * Math.min(1, dt * 12);
    this.mat.uniforms.uOpacity!.value = this.opacity;

    // Sample at a fixed spatial rate so the ribbon's shape doesn't depend on
    // frame rate. At very low speeds we still push samples on a timer so the
    // tail collapses in behind the player rather than hanging in the air.
    this.accum += dt;
    const moved = Math.hypot(x - this.lastX, y - this.lastY, z - this.lastZ);
    if (moved > 0.14 || this.accum > 0.045) {
      this.accum = 0;
      this.lastX = x;
      this.lastY = y;
      this.lastZ = z;
      this.head = (this.head - 1 + this.segments) % this.segments;
      this.hist[this.head * 3] = x;
      this.hist[this.head * 3 + 1] = y;
      this.hist[this.head * 3 + 2] = z;
      this.histW[this.head] = this.width;
      if (this.filled < this.segments) this.filled++;
    } else {
      // Keep the head glued to the player between samples.
      this.hist[this.head * 3] = x;
      this.hist[this.head * 3 + 1] = y;
      this.hist[this.head * 3 + 2] = z;
    }

    // Build the ribbon: each rib is perpendicular to the local direction and
    // to the camera, so the strip always faces the viewer.
    const pos = this.positions;
    const camPos = _camPos.setFromMatrixPosition(camera.matrixWorld);
    for (let i = 0; i < this.segments; i++) {
      const idx = (this.head + i) % this.segments;
      const nx = this.hist[idx * 3]!;
      const ny = this.hist[idx * 3 + 1]!;
      const nz = this.hist[idx * 3 + 2]!;
      const nIdx = (this.head + Math.min(i + 1, this.segments - 1)) % this.segments;
      const dx = this.hist[nIdx * 3]! - nx;
      const dy = this.hist[nIdx * 3 + 1]! - ny;
      const dz = this.hist[nIdx * 3 + 2]! - nz;

      _dir.set(dx, dy, dz);
      if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, 1);
      _dir.normalize();
      _toCam.set(camPos.x - nx, camPos.y - ny, camPos.z - nz).normalize();
      _side.crossVectors(_dir, _toCam);
      if (_side.lengthSq() < 1e-8) _side.set(1, 0, 0);
      _side.normalize();

      const taper = 1 - (i / (this.segments - 1)) * 0.82;
      const w = this.histW[idx]! * 0.5 * taper;
      const j = i * 6;
      pos[j] = nx - _side.x * w;
      pos[j + 1] = ny - _side.y * w;
      pos[j + 2] = nz - _side.z * w;
      pos[j + 3] = nx + _side.x * w;
      pos[j + 4] = ny + _side.y * w;
      pos[j + 5] = nz + _side.z * w;
    }
    this.geo.attributes.position!.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _camPos = new THREE.Vector3();
