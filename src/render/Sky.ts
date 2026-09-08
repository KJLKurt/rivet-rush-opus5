import * as THREE from 'three';
import type { AreaTheme } from './Palette';
import { getTexture } from './Textures';
import { makeRandom, damp, clamp01 } from '../core/Util';

/**
 * The sky is most of what the player actually sees, so it gets real attention:
 *
 *  1. A three-stop gradient dome (custom shader, one draw call, no texture).
 *  2. A warm sun disc with a soft halo that sits under the horizon haze.
 *  3. Three parallax layers of soft cloud billboards that drift and slowly
 *     churn, giving genuine depth behind the islands.
 *  4. A ring of low-poly distant islands so the world reads as *huge*.
 *  5. Storm lightning for Area 3 — a full-screen flash plus a bolt flare.
 *
 * Everything here is additive to the mood and costs almost nothing: the dome
 * and sun are unlit, the clouds are a single instanced-ish sprite batch, and
 * the distant islands never cast or receive shadows.
 */

const SkyShader = {
  vertexShader: /* glsl */ `
    varying vec3 vWorld;
    void main() {
      vWorld = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uTop;
    uniform vec3 uMid;
    uniform vec3 uLow;
    uniform vec3 uBelow;
    uniform vec3 uSunDir;
    uniform vec3 uSunColor;
    uniform float uSunSize;
    uniform float uFlash;
    varying vec3 vWorld;

    void main() {
      vec3 dir = normalize(vWorld);
      float h = dir.y;

      // Three bands. The one below the horizon matters most: at this camera
      // pitch almost the whole frame sits under it, so that region is doing
      // the work of selling "we are very high up".
      vec3 col = mix(uLow, uMid, smoothstep(-0.06, 0.28, h));
      col = mix(col, uTop, smoothstep(0.22, 0.86, h));
      col = mix(col, uBelow, smoothstep(-0.02, -0.55, h));

      // Sun disc + broad halo, only above the horizon.
      float d = max(dot(dir, normalize(uSunDir)), 0.0);
      float disc = smoothstep(1.0 - uSunSize, 1.0 - uSunSize * 0.35, d);
      float halo = pow(d, 26.0) * 0.45 + pow(d, 5.0) * 0.16;
      col += uSunColor * (disc * 0.9 + halo);

      // Faint banding-free dither; large gradients on 8-bit displays band badly.
      float dither = fract(sin(dot(dir.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
      col += dither * 0.0035;

      col += vec3(uFlash);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

interface CloudLayer {
  group: THREE.Group;
  drift: number;
  radius: number;
}

export class Sky {
  readonly root = new THREE.Group();
  private dome: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private layers: CloudLayer[] = [];
  private distant = new THREE.Group();
  private theme: AreaTheme | null = null;
  private flash = 0;
  private lightningTimer = 4;
  private stormy = false;
  private time = 0;
  private reducedMotion = false;

  /** Called when lightning strikes so the game can duck audio/light with it. */
  onLightning: (() => void) | null = null;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color(0x2f7fe0) },
        uMid: { value: new THREE.Color(0x8fd0ff) },
        uLow: { value: new THREE.Color(0xffe6b8) },
        uSunDir: { value: new THREE.Vector3(0.55, 1, 0.45).normalize() },
        uSunColor: { value: new THREE.Color(0xfff2d6) },
        uSunSize: { value: 0.012 },
        uBelow: { value: new THREE.Color(0x6ea6d8) },
        uFlash: { value: 0 },
      },
      vertexShader: SkyShader.vertexShader,
      fragmentShader: SkyShader.fragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(320, 32, 20), this.mat);
    this.dome.renderOrder = -100;
    this.dome.frustumCulled = false;
    this.root.add(this.dome);

    this.buildClouds();
    this.root.add(this.distant);
  }

  private buildClouds(): void {
    const tex = getTexture('cloudSprite');
    const rng = makeRandom(9128371);
    // Three shells at different radii; the nearest drifts fastest, which is
    // what actually sells the parallax.
    const config = [
      // The "cloud sea" far below and well outside the arena. Kept at a
      // distance on purpose: any closer and the puffs read as a fog bank
      // sitting on the island's rim instead of weather a long way down.
      // Sparse on purpose. Enough puffs to read as a cloud sea a long way
      // down, few enough that they never merge into an opaque wall across the
      // horizon — which is what kills the sense of altitude.
      { count: 14, radius: 215, y: [-118, -74], scale: [44, 76], drift: 0.020, opacity: 0.7 },
      { count: 18, radius: 290, y: [-150, -60], scale: [70, 118], drift: 0.012, opacity: 0.55 },
      { count: 16, radius: 360, y: [-190, -30], scale: [104, 176], drift: 0.007, opacity: 0.42 },
      // A thin high layer, for the boss reveal and the title camera.
      { count: 12, radius: 250, y: [26, 95], scale: [58, 112], drift: 0.010, opacity: 0.45 },
    ];
    for (const c of config) {
      const group = new THREE.Group();
      for (let i = 0; i < c.count; i++) {
        const mat = new THREE.SpriteMaterial({
          map: tex,
          transparent: true,
          depthWrite: false,
          opacity: c.opacity * (0.7 + rng() * 0.3),
          fog: false,
          toneMapped: false,
        });
        const sprite = new THREE.Sprite(mat);
        const a = rng() * Math.PI * 2;
        const r = c.radius * (0.75 + rng() * 0.35);
        const s = c.scale[0]! + rng() * (c.scale[1]! - c.scale[0]!);
        sprite.position.set(Math.cos(a) * r, c.y[0]! + rng() * (c.y[1]! - c.y[0]!), Math.sin(a) * r);
        sprite.scale.set(s, s * (0.44 + rng() * 0.16), 1);
        sprite.userData.bob = rng() * Math.PI * 2;
        sprite.userData.baseY = sprite.position.y;
        sprite.renderOrder = -50;
        group.add(sprite);
      }
      this.root.add(group);
      this.layers.push({ group, drift: c.drift, radius: c.radius });
    }
  }

  /** Populates the far-horizon island ring for the given theme. */
  async buildDistantIslands(
    factory: (seed: number) => THREE.Object3D | null,
    count = 9,
  ): Promise<void> {
    this.clearDistant();
    const rng = makeRandom(4477);
    for (let i = 0; i < count; i++) {
      const obj = factory(Math.floor(rng() * 1e6));
      if (!obj) continue;
      const a = (i / count) * Math.PI * 2 + rng() * 0.35;
      const r = 78 + rng() * 110;
      obj.position.set(Math.cos(a) * r, -18 - rng() * 40, Math.sin(a) * r);
      const s = 2.4 + rng() * 3.4;
      obj.scale.setScalar(s);
      obj.rotation.y = rng() * Math.PI * 2;
      obj.traverse((o) => {
        o.castShadow = false;
        o.receiveShadow = false;
      });
      obj.userData.bob = rng() * Math.PI * 2;
      obj.userData.baseY = obj.position.y;
      this.distant.add(obj);
    }
  }

  private clearDistant(): void {
    for (const child of [...this.distant.children]) {
      this.distant.remove(child);
      child.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry?.dispose();
          const mat = m.material;
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else mat?.dispose();
        }
      });
    }
  }

  applyTheme(theme: AreaTheme): void {
    this.theme = theme;
    this.stormy = theme.skyTop === 0x151a45;
    const u = this.mat.uniforms;
    (u.uSunDir!.value as THREE.Vector3).set(...theme.sunDir).normalize();
    (u.uSunColor!.value as THREE.Color).setHex(theme.sunColor);
    for (const layer of this.layers) {
      for (const child of layer.group.children) {
        const sprite = child as THREE.Sprite;
        sprite.material.color.setHex(theme.cloudColor);
      }
    }
  }

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
  }

  /** Manually trigger a storm flash (used for boss phase changes too). */
  strike(strength = 1): void {
    this.flash = Math.max(this.flash, 0.5 * strength);
    this.onLightning?.();
  }

  update(dt: number, cameraX: number, cameraZ: number): void {
    this.time += dt;
    // The sky follows the camera so the player can never reach its edge.
    this.root.position.set(cameraX, 0, cameraZ);

    const t = this.theme;
    if (t) {
      const u = this.mat.uniforms;
      const k = 1 - Math.exp(-1.6 * dt);
      (u.uTop!.value as THREE.Color).lerp(_c.setHex(t.skyTop), k);
      (u.uMid!.value as THREE.Color).lerp(_c.setHex(t.skyMid), k);
      (u.uLow!.value as THREE.Color).lerp(_c.setHex(t.skyLow), k);
      (u.uBelow!.value as THREE.Color).lerp(_c.setHex(t.skyBelow), k);
    }

    const motion = this.reducedMotion ? 0.35 : 1;
    for (const layer of this.layers) {
      layer.group.rotation.y += layer.drift * dt * motion;
      if (!this.reducedMotion) {
        for (const child of layer.group.children) {
          const bob = child.userData.bob as number;
          child.position.y = (child.userData.baseY as number) + Math.sin(this.time * 0.22 + bob) * 1.4;
        }
      }
    }

    this.distant.rotation.y += 0.0035 * dt * motion;
    for (const child of this.distant.children) {
      const bob = child.userData.bob as number;
      child.position.y = (child.userData.baseY as number) + Math.sin(this.time * 0.32 + bob) * 0.9;
      child.rotation.y += 0.05 * dt;
    }

    if (this.stormy && !this.reducedMotion) {
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        this.lightningTimer = 3.5 + Math.random() * 5.5;
        this.strike(0.7 + Math.random() * 0.5);
      }
    }
    this.flash = damp(this.flash, 0, 9, dt);
    this.mat.uniforms.uFlash!.value = clamp01(this.flash);
  }

  get flashAmount(): number {
    return this.flash;
  }

  dispose(): void {
    this.clearDistant();
    this.dome.geometry.dispose();
    this.mat.dispose();
    for (const layer of this.layers) {
      for (const child of layer.group.children) (child as THREE.Sprite).material.dispose();
    }
  }
}

const _c = new THREE.Color();
