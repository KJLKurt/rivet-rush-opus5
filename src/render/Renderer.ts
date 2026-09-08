import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { AreaTheme } from './Palette';
import { clamp, clamp01, damp } from '../core/Util';
import { setMaterialQuality } from './Materials';

export type Quality = 'low' | 'medium' | 'high';

/**
 * Full-screen grade pass. Cheap, and it does a lot of heavy lifting for the
 * "premium" look: a soft vignette, a gentle saturation/contrast lift, a
 * radial speed blur during dashes and Overdrive, and a colour wash used for
 * damage (red flash) and Overdrive (gold).
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: 0.34 },
    uSaturation: { value: 1.12 },
    uContrast: { value: 1.05 },
    uSpeed: { value: 0.0 },
    uWashColor: { value: new THREE.Color(0xffffff) },
    uWash: { value: 0.0 },
    uAspect: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uSpeed;
    uniform vec3 uWashColor;
    uniform float uWash;
    uniform float uAspect;
    varying vec2 vUv;

    void main() {
      vec2 uv = vUv;
      vec2 toCenter = uv - 0.5;

      vec3 col;
      if (uSpeed > 0.001) {
        // Radial streak: a handful of taps pulled toward the centre. Reads as
        // speed without the cost of a real motion-blur pass.
        col = vec3(0.0);
        float total = 0.0;
        for (int i = 0; i < 6; i++) {
          float t = float(i) / 5.0;
          float scale = 1.0 - uSpeed * 0.055 * t;
          float w = 1.0 - t * 0.55;
          col += texture2D(tDiffuse, toCenter * scale + 0.5).rgb * w;
          total += w;
        }
        col /= total;
      } else {
        col = texture2D(tDiffuse, uv).rgb;
      }

      // Saturation + contrast around mid grey.
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);
      col = (col - 0.5) * uContrast + 0.5;

      // Screen-space wash (damage / overdrive / phase transitions).
      col = mix(col, uWashColor, uWash);

      // Vignette, aspect-corrected so ultrawide phones aren't over-darkened.
      vec2 v = toCenter * vec2(uAspect, 1.0);
      float vig = smoothstep(0.95, 0.28, length(v));
      col *= mix(1.0, vig, uVignette);

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;

  /** Key light. Its shadow frustum is re-centred on the player every frame. */
  readonly sun: THREE.DirectionalLight;
  readonly ambient: THREE.HemisphereLight;
  readonly rim: THREE.DirectionalLight;

  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private gradePass: ShaderPass | null = null;
  private renderTarget: THREE.WebGLRenderTarget | null = null;

  quality: Quality = 'high';
  private autoQuality = true;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private baseBloom = 0.6;

  // Rolling FPS estimate used for automatic quality stepping.
  private frameAccum = 0;
  private frameCount = 0;
  private avgFps = 60;
  private qualityCooldown = 3;
  private contextLost = false;

  /** Fires when the WebGL context is lost / restored, so the game can pause. */
  onContextLost: (() => void) | null = null;
  onContextRestored: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // handled by MSAA on the composer target instead
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      failIfMajorPerformanceCaveat: false,
    });
    this.renderer.setClearColor(0x0b1030, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = true;

    this.camera = new THREE.PerspectiveCamera(46, 1, 0.6, 420);
    this.camera.position.set(0, 21, 17);
    this.camera.lookAt(0, 0, 0);

    this.scene.background = new THREE.Color(0x9fd0ff);
    this.scene.fog = new THREE.Fog(0xa8d8ff, 60, 190);

    this.ambient = new THREE.HemisphereLight(0xbfe2ff, 0xffd9a0, 1.15);
    this.scene.add(this.ambient);

    this.sun = new THREE.DirectionalLight(0xfff2d6, 2.3);
    this.sun.position.set(24, 42, 20);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const cam = this.sun.shadow.camera;
    cam.near = 1;
    cam.far = 150;
    cam.left = -34;
    cam.right = 34;
    cam.top = 34;
    cam.bottom = -34;
    this.sun.shadow.bias = -0.0012;
    this.sun.shadow.normalBias = 0.035;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Cool fill from the opposite side: keeps shadowed sides readable and
    // gives the chunky shapes a rim that separates them from the sky.
    this.rim = new THREE.DirectionalLight(0x9fd8ff, 0.75);
    this.rim.position.set(-18, 14, -22);
    this.scene.add(this.rim);

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.onContextLost?.();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.rebuildComposer();
      this.onContextRestored?.();
    });
  }

  /** Picks a starting quality from the device before the first frame. */
  detectQuality(): Quality {
    const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
    const cores = navigator.hardwareConcurrency ?? 4;
    const px = window.innerWidth * window.innerHeight * (window.devicePixelRatio || 1);
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    let score = 0;
    if (mem >= 8) score += 2;
    else if (mem >= 4) score += 1;
    if (cores >= 8) score += 2;
    else if (cores >= 6) score += 1;
    if (!coarse) score += 2;
    if (px > 4_000_000) score -= 1;
    if (score >= 5) return 'high';
    if (score >= 2) return 'medium';
    return 'low';
  }

  setQuality(q: Quality | 'auto'): void {
    if (q === 'auto') {
      this.autoQuality = true;
      this.applyQuality(this.detectQuality());
    } else {
      this.autoQuality = false;
      this.applyQuality(q);
    }
  }

  private applyQuality(q: Quality): void {
    this.quality = q;
    setMaterialQuality(q);
    const maxDpr = q === 'high' ? 2 : q === 'medium' ? 1.6 : 1.15;
    this.dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    this.renderer.shadowMap.enabled = q !== 'low';
    this.sun.castShadow = q !== 'low';
    this.sun.shadow.mapSize.set(q === 'high' ? 2048 : 1024, q === 'high' ? 2048 : 1024);
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
    this.rebuildComposer();
    this.resize(this.width, this.height, true);
  }

  private rebuildComposer(): void {
    this.composer?.dispose();
    this.renderTarget?.dispose();
    this.composer = null;
    this.bloomPass = null;
    this.gradePass = null;
    this.renderTarget = null;
    if (this.quality === 'low') return;

    const samples = this.quality === 'high' ? 4 : 2;
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    this.renderTarget = target;
    const composer = new EffectComposer(this.renderer, target);
    composer.addPass(new RenderPass(this.scene, this.camera));

    const bloomRes = new THREE.Vector2(
      Math.max(1, Math.floor(this.width * 0.5)),
      Math.max(1, Math.floor(this.height * 0.5)),
    );
    // A high threshold is essential here. The world is bright and saturated by
    // design, so a low threshold makes *everything* bloom and the whole image
    // turns into pale soup. At 0.9 only genuine light sources — energy cores,
    // trails, the Overdrive glow — actually bleed.
    const bloom = new UnrealBloomPass(bloomRes, this.baseBloom, 0.48, 0.9);
    composer.addPass(bloom);
    this.bloomPass = bloom;

    const grade = new ShaderPass(GradeShader);
    grade.uniforms.uSaturation.value = 1.1;
    composer.addPass(grade);
    this.gradePass = grade;

    composer.addPass(new OutputPass());
    this.composer = composer;
  }

  resize(cssWidth: number, cssHeight: number, force = false): void {
    const w = Math.max(1, Math.floor(cssWidth));
    const h = Math.max(1, Math.floor(cssHeight));
    if (!force && w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Portrait phones need a wider vertical FOV or Rivet fills the screen.
    const portrait = h > w;
    this.camera.fov = portrait ? 58 : 46;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setSize(w, h);
      this.composer.setPixelRatio(this.dpr);
    }
    if (this.gradePass) {
      this.gradePass.uniforms.uAspect.value = w / h;
    }
  }

  applyTheme(theme: AreaTheme, instant = false): void {
    const sunDir = new THREE.Vector3(...theme.sunDir).normalize().multiplyScalar(52);
    if (instant) {
      this.sun.position.copy(sunDir);
      this.sun.color.setHex(theme.sunColor);
      this.sun.intensity = theme.sunIntensity;
      this.ambient.color.setHex(theme.ambientSky);
      this.ambient.groundColor.setHex(theme.ambientGround);
      this.ambient.intensity = theme.ambientIntensity;
      this.rim.color.setHex(theme.rimColor);
      this.rim.intensity = theme.rimIntensity;
      (this.scene.fog as THREE.Fog).color.setHex(theme.fogColor);
      (this.scene.fog as THREE.Fog).near = theme.fogNear;
      (this.scene.fog as THREE.Fog).far = theme.fogFar;
      (this.scene.background as THREE.Color).setHex(theme.fogColor);
    }
    this.targetTheme = theme;
    this.baseBloom = theme.bloomStrength;
  }

  private targetTheme: AreaTheme | null = null;

  /** Eases lighting toward the current theme so area transitions crossfade. */
  private updateLighting(dt: number): void {
    const t = this.targetTheme;
    if (!t) return;
    const k = 1.6;
    const sunDir = _v1.set(...t.sunDir).normalize().multiplyScalar(52);
    this.sun.position.lerp(sunDir, 1 - Math.exp(-k * dt));
    this.sun.color.lerp(_c1.setHex(t.sunColor), 1 - Math.exp(-k * dt));
    this.sun.intensity = damp(this.sun.intensity, t.sunIntensity, k, dt);
    this.ambient.color.lerp(_c1.setHex(t.ambientSky), 1 - Math.exp(-k * dt));
    this.ambient.groundColor.lerp(_c1.setHex(t.ambientGround), 1 - Math.exp(-k * dt));
    this.ambient.intensity = damp(this.ambient.intensity, t.ambientIntensity, k, dt);
    this.rim.color.lerp(_c1.setHex(t.rimColor), 1 - Math.exp(-k * dt));
    this.rim.intensity = damp(this.rim.intensity, t.rimIntensity, k, dt);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.lerp(_c1.setHex(t.fogColor), 1 - Math.exp(-k * dt));
    fog.near = damp(fog.near, t.fogNear, k, dt);
    fog.far = damp(fog.far, t.fogFar, k, dt);
    (this.scene.background as THREE.Color).copy(fog.color);
  }

  /** Keeps the shadow frustum tight around the action for crisp shadows. */
  centreShadows(x: number, z: number): void {
    this.sun.target.position.set(x, 0, z);
    this.sun.target.updateMatrixWorld();
    const dir = _v1.copy(this.sun.position).normalize().multiplyScalar(52);
    this.sun.position.set(x + dir.x, dir.y, z + dir.z);
  }

  // --- per-frame grade controls used by the game for feedback ---------------

  setSpeedLines(amount: number): void {
    if (this.gradePass) this.gradePass.uniforms.uSpeed.value = clamp(amount, 0, 3);
  }

  setWash(color: number, amount: number): void {
    if (!this.gradePass) return;
    this.gradePass.uniforms.uWashColor.value.setHex(color);
    this.gradePass.uniforms.uWash.value = clamp01(amount);
  }

  setBloomBoost(extra: number): void {
    if (this.bloomPass) this.bloomPass.strength = this.baseBloom + extra;
  }

  setVignette(v: number): void {
    if (this.gradePass) this.gradePass.uniforms.uVignette.value = clamp(v, 0, 1);
  }

  render(dt: number): void {
    if (this.contextLost) return;
    this.updateLighting(dt);
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
    if (this.autoQuality) this.trackPerformance(dt);
  }

  /**
   * Steps quality down when the device can't hold ~50fps, and back up if it is
   * comfortably above 58. Hysteresis + a cooldown stop it oscillating.
   */
  private trackPerformance(dt: number): void {
    if (dt <= 0 || dt > 0.5) return;
    this.frameAccum += dt;
    this.frameCount++;
    if (this.qualityCooldown > 0) this.qualityCooldown -= dt;
    if (this.frameAccum < 1.2) return;
    this.avgFps = this.frameCount / this.frameAccum;
    this.frameAccum = 0;
    this.frameCount = 0;
    if (this.qualityCooldown > 0) return;
    if (this.avgFps < 46 && this.quality !== 'low') {
      this.applyQuality(this.quality === 'high' ? 'medium' : 'low');
      this.qualityCooldown = 6;
    } else if (this.avgFps > 58.5 && this.quality === 'low') {
      this.applyQuality('medium');
      this.qualityCooldown = 12;
    }
  }

  get fps(): number {
    return this.avgFps;
  }

  dispose(): void {
    this.composer?.dispose();
    this.renderTarget?.dispose();
    this.renderer.dispose();
  }
}

const _v1 = new THREE.Vector3();
const _c1 = new THREE.Color();
