import * as THREE from 'three';
import { PAL } from '../Palette';
import { toonMat, glowMat, roundedBoxGeometry, outlineGroup } from '../Materials';
import { getTextureTiled } from '../Textures';
import { clamp, clamp01, damp, lerp, easeOutCubic, easeOutBack, smoothstep } from '../../core/Util';

/**
 * THE GREAT SCRAPBOT — the finale.
 *
 * A lovable grumpy junk-golem that built itself out of the scrapyard: a boxy
 * riveted torso with a hinged chest hatch, two deliberately mismatched arms
 * (a magnet claw and an enormous crusher fist), stubby legs on a hover skirt,
 * exhaust funnels that puff smoke, and big cartoon eyes under angled eyebrow
 * plates that do most of the acting.
 *
 * Readability is the whole design brief. Every attack is announced by a pose
 * a child can read from across the room:
 *   slam   — the crusher fist rears way back and the whole body coils
 *   sweep  — the magnet arm charges a growing orb and the head tracks the line
 *   spawn  — the chest hatch cracks open with light spilling out
 * Phase changes are visible too: phase 2 sheds shoulder armour, phase 3 burns
 * its core magenta and starts venting sparks.
 */

export type BossPhase = 1 | 2 | 3;

export type BossAnimState =
  | 'dormant' | 'wake' | 'idle'
  | 'slamWindup' | 'slam'
  | 'sweepWindup' | 'sweep'
  | 'spawnWindup' | 'spawn'
  | 'vacuum' | 'stagger' | 'hurt' | 'defeated';

export interface BossModel {
  root: THREE.Group;
  lookAtTarget: THREE.Vector3;
  readonly corePosition: THREE.Vector3;
  readonly coreExposed: boolean;
  /** World position of the crusher fist, for slam impact effects. */
  readonly fistPosition: THREE.Vector3;
  /** World position of the magnet claw, for the sweep beam origin. */
  readonly clawPosition: THREE.Vector3;
  setPhase(phase: BossPhase): void;
  setState(state: BossAnimState): void;
  update(t: number, dt: number, progress: number): void;
  hit(): void;
  setHealth(frac: number): void;
  dispose(): void;
}

const TAU = Math.PI * 2;
const HALF_PI = Math.PI * 0.5;

export function createBoss(): BossModel {
  const root = new THREE.Group();
  root.name = 'greatScrapbot';

  // --- shared materials (unique where they're animated) --------------------
  const plate = toonMat(PAL.bossPlate, { map: getTextureTiled('metalPanel', 3, 3), unique: true });
  const plateDark = toonMat(PAL.bossPlateDark, { map: getTextureTiled('rustPanel', 2, 2), unique: true });
  const accent = toonMat(PAL.bossAccent, { ramp: 'hard3', unique: true });
  const rubber = toonMat(0x2a2f45, { ramp: 'hard3' });
  const coreMat = glowMat(PAL.bossCore, 0.95, true);
  const eyeWhite = glowMat(0xf7fbff, 1, false);
  const pupilMat = toonMat(0x1b2038, { ramp: 'hard3' });
  const hatchGlowMat = glowMat(PAL.bossCore, 0, true);
  const ventMat = glowMat(PAL.bossAccent, 0.6, true);

  const box = roundedBoxGeometry;

  // --- body pivots ---------------------------------------------------------
  const bodyPivot = new THREE.Group();       // global bob + lean
  root.add(bodyPivot);
  const skirt = new THREE.Group();
  bodyPivot.add(skirt);
  const torso = new THREE.Group();
  torso.position.y = 3.4;
  bodyPivot.add(torso);
  const head = new THREE.Group();
  head.position.y = 2.05;
  torso.add(head);

  // --- hover skirt / legs --------------------------------------------------
  {
    const base = new THREE.Mesh(box(4.6, 1.1, 3.8, 0.4, 3), plateDark);
    base.position.y = 0.85;
    skirt.add(base);
    const lip = new THREE.Mesh(box(5.0, 0.34, 4.2, 0.16, 2), accent);
    lip.position.y = 0.32;
    skirt.add(lip);
    // Three hover coils under the skirt.
    for (const x of [-1.5, 0, 1.5]) {
      const coil = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.14, 6, 14), rubber);
      coil.rotation.x = HALF_PI;
      coil.position.set(x, 0.28, 0);
      skirt.add(coil);
      const glow = new THREE.Mesh(new THREE.CircleGeometry(0.46, 14), glowMat(PAL.bossCore, 0.55, true));
      glow.rotation.x = -HALF_PI;
      glow.position.set(x, 0.16, 0);
      skirt.add(glow);
    }
    // Stubby legs.
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(box(1.1, 1.5, 1.2, 0.3, 3), plate);
      leg.position.set(sx * 1.5, 1.9, 0.1);
      skirt.add(leg);
      const knee = new THREE.Mesh(new THREE.SphereGeometry(0.52, 10, 8), rubber);
      knee.position.set(sx * 1.5, 2.55, 0.1);
      skirt.add(knee);
    }
  }

  // --- torso ---------------------------------------------------------------
  const hatch = new THREE.Group();
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.82, 1), coreMat);
  const shoulderArmour: THREE.Mesh[] = [];
  {
    const chest = new THREE.Mesh(box(4.4, 3.6, 2.9, 0.45, 4), plate);
    torso.add(chest);
    // Bolted brow band + belt: breaks up the big flat chest.
    const band = new THREE.Mesh(box(4.6, 0.5, 3.0, 0.2, 2), accent);
    band.position.y = 1.5;
    torso.add(band);
    const belt = new THREE.Mesh(box(4.6, 0.6, 3.05, 0.22, 2), plateDark);
    belt.position.y = -1.55;
    torso.add(belt);
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const rivet = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), accent);
        rivet.position.set(sx * 1.85, sy * 1.5, 1.5);
        torso.add(rivet);
      }
    }

    // Chest cavity + the vulnerable core inside it.
    const cavity = new THREE.Mesh(box(2.5, 2.2, 0.6, 0.2, 2), rubber);
    cavity.position.set(0, 0.1, 1.32);
    torso.add(cavity);
    core.position.set(0, 0.1, 1.5);
    torso.add(core);
    const coreRing = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.12, 6, 20), accent);
    coreRing.position.set(0, 0.1, 1.5);
    torso.add(coreRing);
    const coreGlow = new THREE.Mesh(new THREE.CircleGeometry(1.5, 20), hatchGlowMat);
    coreGlow.position.set(0, 0.1, 1.56);
    torso.add(coreGlow);

    // Two hatch doors that swing open on their own hinges.
    hatch.position.set(0, 0.1, 1.45);
    torso.add(hatch);
    for (const sx of [-1, 1]) {
      const hinge = new THREE.Group();
      hinge.position.set(sx * 1.4, 0, 0);
      hatch.add(hinge);
      const door = new THREE.Mesh(box(1.4, 2.4, 0.34, 0.14, 2), plate);
      door.position.set(-sx * 0.7, 0, 0);
      hinge.add(door);
      const clamp2 = new THREE.Mesh(box(0.4, 2.0, 0.44, 0.12, 2), accent);
      clamp2.position.set(-sx * 1.2, 0, 0.06);
      hinge.add(clamp2);
      hinge.userData.side = sx;
    }

    // Shoulder armour — shed at phase 2.
    for (const sx of [-1, 1]) {
      const pauldron = new THREE.Mesh(box(1.5, 1.2, 2.4, 0.35, 3), plateDark);
      pauldron.position.set(sx * 2.5, 1.35, 0);
      pauldron.rotation.z = sx * 0.18;
      torso.add(pauldron);
      shoulderArmour.push(pauldron);
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.9, 7), accent);
      spike.position.set(sx * 2.9, 2.0, 0);
      spike.rotation.z = sx * 0.35;
      torso.add(spike);
      shoulderArmour.push(spike);
    }

    // Exhaust funnels.
    for (const sx of [-1, 1]) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.38, 1.9, 9), plateDark);
      pipe.position.set(sx * 1.3, 2.4, -1.3);
      pipe.rotation.z = sx * 0.16;
      torso.add(pipe);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.32, 0.3, 9), accent);
      cap.position.set(sx * 1.45, 3.35, -1.3);
      torso.add(cap);
    }
  }

  // --- head ----------------------------------------------------------------
  const eyes = new THREE.Group();
  const pupils: THREE.Mesh[] = [];
  const eyeWhites: THREE.Mesh[] = [];
  const brows: THREE.Mesh[] = [];
  const funnel = new THREE.Group();
  {
    const skull = new THREE.Mesh(box(2.5, 1.9, 2.1, 0.5, 4), plate);
    head.add(skull);
    const jaw = new THREE.Mesh(box(2.0, 0.55, 1.7, 0.22, 3), plateDark);
    jaw.position.set(0, -0.95, 0.1);
    head.add(jaw);
    // A crooked grille "moustache" — pure personality.
    for (let i = 0; i < 4; i++) {
      const tooth = new THREE.Mesh(box(0.32, 0.4, 0.2, 0.08, 1), accent);
      tooth.position.set(-0.6 + i * 0.4, -0.9, 1.02);
      tooth.rotation.z = (i - 1.5) * 0.08;
      head.add(tooth);
    }

    head.add(eyes);
    for (const sx of [-1, 1]) {
      const socket = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.3, 14), plateDark);
      socket.rotation.x = HALF_PI;
      socket.position.set(sx * 0.62, 0.25, 1.02);
      eyes.add(socket);
      const white = new THREE.Mesh(new THREE.SphereGeometry(0.4, 14, 12), eyeWhite);
      white.position.set(sx * 0.62, 0.25, 1.12);
      white.scale.set(1, 1, 0.55);
      eyes.add(white);
      eyeWhites.push(white);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), pupilMat);
      pupil.position.set(sx * 0.62, 0.25, 1.36);
      pupil.scale.set(1, 1, 0.5);
      eyes.add(pupil);
      pupils.push(pupil);
      const brow = new THREE.Mesh(box(0.92, 0.24, 0.3, 0.1, 2), accent);
      brow.position.set(sx * 0.62, 0.86, 1.14);
      brow.rotation.z = sx * -0.12;
      eyes.add(brow);
      brows.push(brow);
    }

    // Crooked funnel hat + a bent antenna.
    funnel.position.set(0.18, 1.0, -0.1);
    funnel.rotation.z = -0.24;
    head.add(funnel);
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.6, 1.1, 10), plateDark);
    stack.position.y = 0.55;
    funnel.add(stack);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.16, 12), accent);
    brim.position.y = 0.1;
    funnel.add(brim);
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 1.0, 5), plateDark);
    antenna.position.set(-0.5, 1.4, 0);
    antenna.rotation.z = 0.5;
    head.add(antenna);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), glowMat(PAL.danger, 0.9, true));
    bulb.position.set(-0.74, 1.85, 0);
    head.add(bulb);
    head.userData.bulb = bulb;
  }

  // --- arms ----------------------------------------------------------------
  /** Builds a shoulder→upper→elbow→fore chain. Returns the pivots. */
  function buildArm(sx: number, hand: 'magnet' | 'crusher'): {
    shoulder: THREE.Group; fore: THREE.Group; tip: THREE.Object3D;
  } {
    const shoulder = new THREE.Group();
    shoulder.position.set(sx * 2.5, 1.1, 0);
    torso.add(shoulder);

    const upper = new THREE.Mesh(box(1.0, 2.0, 1.0, 0.3, 3), plate);
    upper.position.y = -0.9;
    shoulder.add(upper);
    // Piston detail along the upper arm.
    const piston = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.6, 8), accent);
    piston.position.set(sx * 0.5, -0.9, 0.35);
    shoulder.add(piston);

    const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.62, 12, 10), rubber);
    elbow.position.y = -1.9;
    shoulder.add(elbow);

    const fore = new THREE.Group();
    fore.position.y = -1.9;
    shoulder.add(fore);
    const forearm = new THREE.Mesh(box(1.2, 2.0, 1.2, 0.34, 3), plateDark);
    forearm.position.y = -1.0;
    fore.add(forearm);

    let tip: THREE.Object3D;
    if (hand === 'magnet') {
      // Horseshoe magnet claw: two poles and a charging orb between them.
      const claw = new THREE.Group();
      claw.position.y = -2.1;
      fore.add(claw);
      const yoke = new THREE.Mesh(box(1.6, 0.7, 1.2, 0.24, 2), plate);
      claw.add(yoke);
      for (const px of [-1, 1]) {
        const pole = new THREE.Mesh(box(0.55, 1.5, 1.0, 0.2, 2), px < 0 ? accent : toonMat(0xe05a5a, { ramp: 'hard3' }));
        pole.position.set(px * 0.52, -0.9, 0);
        claw.add(pole);
      }
      const orb = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 10), glowMat(PAL.bossCore, 0, true));
      orb.position.y = -1.3;
      claw.add(orb);
      claw.userData.orb = orb;
      tip = claw;
    } else {
      // Crusher fist: an oversized riveted block with knuckle spikes.
      const fist = new THREE.Group();
      fist.position.y = -2.4;
      fore.add(fist);
      const block = new THREE.Mesh(box(2.1, 1.9, 2.0, 0.42, 3), plate);
      fist.add(block);
      for (let i = 0; i < 3; i++) {
        const knuckle = new THREE.Mesh(new THREE.SphereGeometry(0.36, 10, 8), accent);
        knuckle.position.set(-0.6 + i * 0.6, 0.8, 0.75);
        fist.add(knuckle);
      }
      const pad = new THREE.Mesh(box(1.9, 0.4, 1.8, 0.16, 2), rubber);
      pad.position.y = -0.95;
      fist.add(pad);
      tip = fist;
    }
    return { shoulder, fore, tip };
  }

  const armMagnet = buildArm(-1, 'magnet');
  const armCrusher = buildArm(1, 'crusher');
  const magnetOrb = armMagnet.tip.userData.orb as THREE.Mesh;

  // --- damage dressing (revealed as health drops) --------------------------
  const damageBits: THREE.Object3D[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    const spark = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), glowMat(PAL.bossAccent, 0.9, true));
    spark.position.set(Math.cos(a) * 2.1, 0.4 + Math.sin(a * 2) * 1.2, Math.sin(a) * 1.4);
    spark.visible = false;
    torso.add(spark);
    damageBits.push(spark);
  }

  outlineGroup(root, 0.05);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = false;
    }
  });

  // --- animation state -----------------------------------------------------
  const lookAtTarget = new THREE.Vector3(0, 1, 12);
  const corePosition = new THREE.Vector3();
  const fistPosition = new THREE.Vector3();
  const clawPosition = new THREE.Vector3();
  const _v = new THREE.Vector3();

  let phase: BossPhase = 1;
  let state: BossAnimState = 'dormant';
  let stateBlend = 1;
  let health = 1;
  let flash = 0;
  let hatchOpen = 0;
  let coreScale = 1;
  let bodyLean = 0;
  let bodyTwist = 0;
  let armMagnetX = 0;
  let armMagnetZ = 0;
  let armCrusherX = 0;
  let armCrusherZ = 0;
  let foreMagnetX = 0;
  let foreCrusherX = 0;
  let orbGlow = 0;
  let browAngle = 0;
  let eyeSquint = 1;
  let dizzy = 0;
  let wakeBlend = 0;
  let defeatT = 0;

  const model: BossModel = {
    root,
    lookAtTarget,
    get corePosition() {
      return corePosition;
    },
    get coreExposed() {
      return hatchOpen > 0.6;
    },
    get fistPosition() {
      return fistPosition;
    },
    get clawPosition() {
      return clawPosition;
    },

    setPhase(p: BossPhase): void {
      if (p === phase) return;
      phase = p;
      // Phase 2 sheds the shoulder armour; phase 3 turns the core magenta.
      if (p >= 2) for (const bit of shoulderArmour) bit.visible = false;
      const hot = p >= 3 ? PAL.bossCoreAngry : PAL.bossCore;
      coreMat.color.setHex(hot);
      hatchGlowMat.color.setHex(hot);
      (magnetOrb.material as THREE.MeshBasicMaterial).color.setHex(hot);
    },

    setState(s: BossAnimState): void {
      if (s === state) return;
      state = s;
      stateBlend = 0;
      if (s === 'stagger') dizzy = 1;
    },

    setHealth(frac: number): void {
      health = clamp01(frac);
      const dmg = 1 - health;
      for (let i = 0; i < damageBits.length; i++) {
        damageBits[i]!.visible = dmg > (i + 1) / (damageBits.length + 1);
      }
      // Plates darken and dull as it takes a beating.
      plate.color.setHex(PAL.bossPlate).lerp(_c.setHex(0x6a6f8c), dmg * 0.55);
      ventMat.opacity = 0.35 + dmg * 0.5;
    },

    hit(): void {
      flash = 1;
    },

    update(t: number, dt: number, progress: number): void {
      stateBlend = Math.min(1, stateBlend + dt * 6);
      flash = Math.max(0, flash - dt * 4);
      dizzy = Math.max(0, dizzy - dt * 0.5);
      const p = clamp01(progress);

      // --- targets per state ---------------------------------------------
      let tHatch = 0;
      let tLean = 0;
      let tTwist = 0;
      let tMagX = 0.15;
      let tMagZ = 0.1;
      let tCruX = 0.15;
      let tCruZ = -0.1;
      let tForeMag = -0.2;
      let tForeCru = -0.2;
      let tOrb = 0;
      let tBrow = 0;
      let tSquint = 1;
      let bobAmp = 0.16;
      let bobFreq = 1.3;

      switch (state) {
        case 'dormant':
          tLean = 0.42;
          tMagX = 0.9;
          tCruX = 0.85;
          tForeMag = -1.2;
          tForeCru = -1.1;
          tSquint = 0.06;
          tBrow = 0.5;
          bobAmp = 0.02;
          bobFreq = 0.5;
          break;
        case 'wake':
          // Clanks upright, eyes flicker on, funnel puffs.
          tLean = lerp(0.42, -0.05, easeOutBack(p));
          tMagX = lerp(0.9, 0.15, easeOutCubic(p));
          tCruX = lerp(0.85, 0.15, easeOutCubic(p));
          tForeMag = lerp(-1.2, -0.2, easeOutCubic(p));
          tForeCru = lerp(-1.1, -0.2, easeOutCubic(p));
          tSquint = p > 0.45 ? 1 : 0.06;
          tBrow = lerp(0.5, -0.25, smoothstep((p - 0.4) / 0.6));
          bobAmp = 0.16 * p;
          break;
        case 'idle':
          tBrow = -0.12;
          bobAmp = 0.18;
          bobFreq = 1.25 + (phase - 1) * 0.35;
          break;
        case 'slamWindup': {
          // The whole machine coils back — impossible to miss.
          const e = easeOutCubic(p);
          tCruX = lerp(0.15, -2.5, e);
          tForeCru = lerp(-0.2, -0.5, e);
          tLean = lerp(0, -0.3, e);
          tTwist = lerp(0, 0.42, e);
          tBrow = -0.55;
          tSquint = 0.75;
          bobAmp = 0.05;
          break;
        }
        case 'slam': {
          // ...and drives down hard, then recovers.
          const e = p < 0.35 ? easeOutCubic(p / 0.35) : 1;
          tCruX = lerp(-2.5, 1.5, e);
          tForeCru = lerp(-0.5, 0.35, e);
          tLean = lerp(-0.3, 0.5, e);
          tTwist = lerp(0.42, -0.12, e);
          tBrow = -0.6;
          bobAmp = 0.06;
          break;
        }
        case 'sweepWindup': {
          const e = easeOutCubic(p);
          tMagX = lerp(0.15, -0.85, e);
          tMagZ = lerp(0.1, -0.7, e);
          tForeMag = lerp(-0.2, 0.15, e);
          tOrb = p;
          tLean = -0.12;
          tTwist = lerp(0, -0.35, e);
          tBrow = -0.45;
          tSquint = 0.7;
          break;
        }
        case 'sweep': {
          // The arm rotates through the sweep; the head follows the beam.
          tMagX = -0.85;
          tMagZ = -0.7;
          tForeMag = 0.15;
          tOrb = 1;
          tTwist = lerp(-0.7, 0.7, p);
          tLean = -0.16;
          tBrow = -0.5;
          bobAmp = 0.06;
          break;
        }
        case 'spawnWindup':
        case 'spawn': {
          const e = state === 'spawnWindup' ? easeOutCubic(p) : 1;
          tHatch = state === 'spawnWindup' ? e * 0.75 : 1;
          tLean = 0.18;
          tMagX = -0.5;
          tCruX = -0.45;
          tMagZ = 0.5;
          tCruZ = -0.5;
          tBrow = 0.35;
          tSquint = 1.15;
          bobAmp = 0.1;
          break;
        }
        case 'vacuum':
          // Leans in and inhales; arms spread wide like a hug.
          tLean = -0.3;
          tMagX = -0.7;
          tCruX = -0.7;
          tMagZ = 0.85;
          tCruZ = -0.85;
          tHatch = 0.9;
          tOrb = 0.65 + Math.sin(t * 18) * 0.25;
          tBrow = -0.6;
          tSquint = 0.6;
          bobFreq = 3.2;
          bobAmp = 0.1;
          break;
        case 'stagger':
          // Slumped, core wide open — the player's window.
          tHatch = 1;
          tLean = 0.5;
          tMagX = 0.75;
          tCruX = 0.7;
          tForeMag = -0.9;
          tForeCru = -0.85;
          tBrow = 0.6;
          tSquint = 0.35;
          bobAmp = 0.07;
          bobFreq = 4.5;
          break;
        case 'hurt':
          tLean = 0.3;
          tBrow = 0.55;
          tSquint = 0.45;
          bobAmp = 0.1;
          bobFreq = 8;
          break;
        case 'defeated': {
          defeatT = Math.min(1, defeatT + dt * 0.5);
          const e = easeOutCubic(defeatT);
          tHatch = 1;
          tLean = lerp(0, 0.75, e);
          tMagX = lerp(0.15, 1.25, e);
          tCruX = lerp(0.15, 1.2, e);
          tForeMag = lerp(-0.2, -1.5, e);
          tForeCru = lerp(-0.2, -1.4, e);
          tBrow = 0.7;
          tSquint = lerp(1, 0.12, e);
          bobAmp = 0.3 * (1 - e);
          bobFreq = 9;
          break;
        }
      }

      // Blend from the previous pose so state changes never snap.
      const k = state === 'slam' ? 26 : 9;
      bodyLean = damp(bodyLean, tLean, k, dt);
      bodyTwist = damp(bodyTwist, tTwist, k, dt);
      armMagnetX = damp(armMagnetX, tMagX, k, dt);
      armMagnetZ = damp(armMagnetZ, tMagZ, k, dt);
      armCrusherX = damp(armCrusherX, tCruX, k, dt);
      armCrusherZ = damp(armCrusherZ, tCruZ, k, dt);
      foreMagnetX = damp(foreMagnetX, tForeMag, k, dt);
      foreCrusherX = damp(foreCrusherX, tForeCru, k, dt);
      hatchOpen = damp(hatchOpen, tHatch, 7, dt);
      orbGlow = damp(orbGlow, tOrb, 10, dt);
      browAngle = damp(browAngle, tBrow, 9, dt);
      eyeSquint = damp(eyeSquint, tSquint, 10, dt);
      wakeBlend = damp(wakeBlend, state === 'dormant' ? 0 : 1, 3, dt);

      // --- apply ----------------------------------------------------------
      const speedUp = 1 + (phase - 1) * 0.22;
      const bob = Math.sin(t * bobFreq * speedUp) * bobAmp;
      bodyPivot.position.y = bob + (state === 'dormant' ? -0.4 : 0);
      bodyPivot.rotation.x = bodyLean;
      bodyPivot.rotation.y = bodyTwist;
      bodyPivot.rotation.z = Math.sin(t * bobFreq * 0.6) * 0.03 + dizzy * Math.sin(t * 9) * 0.06;
      skirt.rotation.y = -bodyTwist * 0.35;

      armMagnet.shoulder.rotation.set(armMagnetX, 0, armMagnetZ);
      armMagnet.fore.rotation.x = foreMagnetX;
      armCrusher.shoulder.rotation.set(armCrusherX, 0, armCrusherZ);
      armCrusher.fore.rotation.x = foreCrusherX;

      // Idle arm sway so it never looks frozen.
      if (state === 'idle' || state === 'dormant') {
        armMagnet.shoulder.rotation.z += Math.sin(t * 1.1) * 0.05;
        armCrusher.shoulder.rotation.z -= Math.sin(t * 1.1 + 1) * 0.05;
      }

      // Hatch doors swing outward.
      for (const hinge of hatch.children) {
        const side = hinge.userData.side as number;
        hinge.rotation.y = side * hatchOpen * 1.5;
      }
      const glowMatRef = hatchGlowMat;
      glowMatRef.opacity = hatchOpen * (0.55 + Math.sin(t * 6) * 0.15);

      // Core: pulses, and swells while exposed so it screams "hit me".
      const exposed = hatchOpen > 0.6;
      coreScale = damp(coreScale, exposed ? 1.25 : 0.9, 8, dt);
      const pulse = 1 + Math.sin(t * (exposed ? 9 : 3.5)) * (exposed ? 0.12 : 0.05);
      core.scale.setScalar(coreScale * pulse);
      core.rotation.y += dt * (exposed ? 2.2 : 0.6);
      core.rotation.x += dt * 0.4;
      coreMat.opacity = 0.55 + hatchOpen * 0.45 + flash * 0.4;

      // Magnet orb charge.
      (magnetOrb.material as THREE.MeshBasicMaterial).opacity = orbGlow * 0.95;
      magnetOrb.scale.setScalar(0.4 + orbGlow * 1.15 + Math.sin(t * 20) * orbGlow * 0.12);

      // --- head & face ------------------------------------------------------
      // The head tracks Rivet, clamped so it never twists off its shoulders.
      _v.copy(lookAtTarget);
      root.worldToLocal(_v);
      const yaw = clamp(Math.atan2(_v.x, _v.z) - bodyTwist, -0.85, 0.85);
      const pitch = clamp(-Math.atan2(_v.y - 5.4, Math.hypot(_v.x, _v.z)) * 0.5, -0.3, 0.45);
      head.rotation.y = damp(head.rotation.y, yaw * wakeBlend, 6, dt);
      head.rotation.x = damp(head.rotation.x, pitch * wakeBlend - bodyLean * 0.6, 6, dt);

      for (let i = 0; i < 2; i++) {
        const sx = i === 0 ? -1 : 1;
        eyeWhites[i]!.scale.set(1, clamp(eyeSquint, 0.05, 1.3), 0.55);
        pupils[i]!.scale.set(1, clamp(eyeSquint, 0.05, 1.3), 0.5);
        // Pupils drift toward the target, plus a dizzy spin when staggered.
        const px = clamp(yaw * 0.35, -0.16, 0.16) + (dizzy > 0 ? Math.cos(t * 7 + i) * 0.12 * dizzy : 0);
        const py = clamp(pitch * 0.3, -0.14, 0.14) + (dizzy > 0 ? Math.sin(t * 7 + i) * 0.12 * dizzy : 0);
        pupils[i]!.position.set(sx * 0.62 + px, 0.25 + py, 1.36);
        brows[i]!.rotation.z = sx * -0.12 + browAngle * sx * -1;
        brows[i]!.position.y = 0.86 + browAngle * 0.14;
      }
      const eyeColor = flash > 0.3 ? 0xffffff : phase >= 3 ? 0xffdce9 : 0xf7fbff;
      eyeWhite.color.setHex(eyeColor);

      funnel.rotation.z = -0.24 + Math.sin(t * 2.1) * 0.05;
      const bulb = head.userData.bulb as THREE.Mesh;
      (bulb.material as THREE.MeshBasicMaterial).opacity =
        wakeBlend * (0.4 + Math.sin(t * 4 * speedUp) * 0.4);

      // --- damage flash -----------------------------------------------------
      const em = flash * 0.9;
      plate.emissive.setHex(0xffffff);
      plate.emissiveIntensity = em;
      plateDark.emissive.setHex(0xffffff);
      plateDark.emissiveIntensity = em;
      for (const bit of damageBits) {
        if (!bit.visible) continue;
        const mat = (bit as THREE.Mesh).material as THREE.MeshBasicMaterial;
        mat.opacity = 0.4 + Math.sin(t * 14 + bit.position.x * 3) * 0.4;
      }

      // --- world anchors ----------------------------------------------------
      core.getWorldPosition(corePosition);
      armCrusher.tip.getWorldPosition(fistPosition);
      armMagnet.tip.getWorldPosition(clawPosition);
    },

    dispose(): void {
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry?.dispose?.();
      });
      plate.dispose();
      plateDark.dispose();
      accent.dispose();
      coreMat.dispose();
      hatchGlowMat.dispose();
      ventMat.dispose();
    },
  };

  model.setHealth(1);
  return model;
}

const _c = new THREE.Color();
