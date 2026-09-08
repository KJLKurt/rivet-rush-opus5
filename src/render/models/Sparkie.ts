import * as THREE from 'three';
import { PAL } from '../Palette';
import { toonMat, glowMat, roundedBoxGeometry, outlineGroup } from '../Materials';
import { clamp01, damp } from '../../core/Util';

/**
 * SPARKIE — the little maintenance robots Rivet is out here rescuing.
 *
 * Deliberately tiny and round: one big friendly eye under a glass dome, a
 * bobbing antenna, stubby hover fins and a warm thruster glow. They have three
 * moods that the player reads instantly — dim and slumped while trapped, wildly
 * excited the moment they're freed, then happily trailing along behind Rivet.
 *
 * Geometry is shared across every instance (they're built from the same cached
 * primitives), so a screen full of Sparkies costs almost nothing.
 */

export type SparkieMood = 'trapped' | 'freed' | 'follow' | 'cheer';

export class SparkieModel {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private dome: THREE.Mesh;
  private eye: THREE.Mesh;
  private pupil: THREE.Mesh;
  private antenna: THREE.Group;
  private antennaBulb: THREE.Mesh;
  private finL: THREE.Mesh;
  private finR: THREE.Mesh;
  private thruster: THREE.Mesh;
  private bodyMat: THREE.MeshToonMaterial;
  private domeMat: THREE.MeshBasicMaterial;
  private bulbMat: THREE.MeshBasicMaterial;
  private thrusterMat: THREE.MeshBasicMaterial;

  private t: number;
  private mood: SparkieMood = 'trapped';
  private moodTime = 0;
  private blink = 0;
  private blinkTimer: number;
  private spin = 0;
  private lookX = 0;

  /** Per-instance phase so a crowd never moves in lockstep. */
  constructor(phase = Math.random() * 6.28) {
    this.t = phase;
    this.blinkTimer = 1 + Math.random() * 3;

    this.root.add(this.body);
    this.bodyMat = toonMat(PAL.sparkieBody, { ramp: 'soft', unique: true });

    const shell = new THREE.Mesh(roundedBoxGeometry(0.36, 0.32, 0.32, 0.14, 4), this.bodyMat);
    this.body.add(shell);

    // Belly plate + a couple of rivets: reads as "little machine", not "egg".
    const plate = new THREE.Mesh(roundedBoxGeometry(0.22, 0.14, 0.06, 0.05, 3), toonMat(PAL.metalMid));
    plate.position.set(0, -0.07, 0.16);
    this.body.add(plate);

    this.domeMat = glowMat(PAL.sparkieShell, 0.55, false);
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), this.domeMat);
    this.dome.position.y = 0.09;
    this.dome.userData.noShadow = true;
    this.body.add(this.dome);

    this.eye = new THREE.Mesh(new THREE.SphereGeometry(0.115, 12, 10), glowMat(0xffffff, 1, false));
    this.eye.position.set(0, 0.05, 0.13);
    this.eye.scale.set(1, 1, 0.55);
    this.body.add(this.eye);
    this.pupil = new THREE.Mesh(new THREE.SphereGeometry(0.062, 10, 8), toonMat(0x1c2340, { ramp: 'hard3' }));
    this.pupil.position.set(0, 0.05, 0.2);
    this.pupil.scale.set(1, 1, 0.5);
    this.body.add(this.pupil);
    const hi = new THREE.Mesh(new THREE.SphereGeometry(0.026, 6, 6), glowMat(0xffffff, 1, false));
    hi.position.set(0.035, 0.085, 0.235);
    this.body.add(hi);

    this.antenna = new THREE.Group();
    this.antenna.position.set(0, 0.2, -0.02);
    this.body.add(this.antenna);
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.022, 0.18, 6), toonMat(PAL.metalMid));
    stalk.position.y = 0.09;
    this.antenna.add(stalk);
    this.bulbMat = glowMat(PAL.sparkieGlow, 1, true);
    this.antennaBulb = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), this.bulbMat);
    this.antennaBulb.position.y = 0.2;
    this.antennaBulb.userData.noShadow = true;
    this.antenna.add(this.antennaBulb);

    const finGeo = roundedBoxGeometry(0.14, 0.05, 0.18, 0.024, 2);
    const finMat = toonMat(PAL.sparkieShell);
    this.finL = new THREE.Mesh(finGeo, finMat);
    this.finL.position.set(-0.21, -0.01, 0);
    this.body.add(this.finL);
    this.finR = new THREE.Mesh(finGeo, finMat);
    this.finR.position.set(0.21, -0.01, 0);
    this.body.add(this.finR);

    this.thrusterMat = glowMat(PAL.energyWarm, 0.8, true);
    this.thruster = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.2, 8, 1, true), this.thrusterMat);
    this.thruster.position.y = -0.22;
    this.thruster.rotation.x = Math.PI;
    this.thruster.userData.noShadow = true;
    this.body.add(this.thruster);

    outlineGroup(this.root, 0.026);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !m.userData.noShadow) m.castShadow = true;
    });
  }

  setMood(mood: SparkieMood): void {
    if (this.mood === mood) return;
    this.mood = mood;
    this.moodTime = 0;
    if (mood === 'freed') this.spin = Math.PI * 4;
  }

  get currentMood(): SparkieMood {
    return this.mood;
  }

  /** Point the eye toward something (Rivet, usually). */
  lookAt(dx: number, dz: number): void {
    this.lookX = Math.atan2(dx, dz);
  }

  update(dt: number, velocity = 0): void {
    this.t += dt;
    this.moodTime += dt;
    const t = this.t;

    const trapped = this.mood === 'trapped';
    const cheering = this.mood === 'cheer' || (this.mood === 'freed' && this.moodTime < 0.9);

    // Bob + tilt.
    const bobAmp = trapped ? 0.02 : cheering ? 0.13 : 0.06;
    const bobFreq = trapped ? 1.4 : cheering ? 11 : 3.2 + velocity * 0.5;
    this.body.position.y = Math.sin(t * bobFreq) * bobAmp + (trapped ? -0.05 : 0);
    this.body.rotation.z = Math.sin(t * bobFreq * 0.7) * (trapped ? 0.03 : 0.12);
    this.body.rotation.x = damp(this.body.rotation.x, trapped ? 0.35 : -velocity * 0.06, 8, dt);

    // Excited spin on rescue.
    if (this.spin > 0) {
      const step = Math.min(this.spin, dt * 22);
      this.body.rotation.y += step;
      this.spin -= step;
    } else {
      this.body.rotation.y = damp(this.body.rotation.y, this.lookX * 0.6, 6, dt);
    }

    // Fins flutter faster the happier they are.
    const flap = Math.sin(t * (trapped ? 3 : cheering ? 26 : 12)) * (trapped ? 0.1 : 0.5);
    this.finL.rotation.z = flap;
    this.finR.rotation.z = -flap;

    // Antenna is a little pendulum.
    this.antenna.rotation.z = Math.sin(t * (cheering ? 14 : 4)) * (cheering ? 0.4 : 0.16);

    // Brightness carries the whole mood read.
    const lit = trapped ? 0.25 : 1;
    const pulse = trapped
      ? 0.2 + Math.sin(t * 1.6) * 0.12
      : 0.8 + Math.sin(t * (cheering ? 16 : 5)) * 0.2;
    this.bulbMat.opacity = clamp01(pulse * lit + (cheering ? 0.4 : 0));
    this.antennaBulb.scale.setScalar(0.7 + pulse * 0.5);
    this.domeMat.opacity = 0.35 + lit * 0.3;
    this.thrusterMat.opacity = trapped ? 0.1 : clamp01(0.35 + velocity * 0.05 + Math.sin(t * 18) * 0.12);
    this.thruster.scale.set(1, trapped ? 0.4 : 0.8 + Math.sin(t * 20) * 0.25 + velocity * 0.03, 1);
    this.bodyMat.emissive.setHex(PAL.sparkieGlow);
    this.bodyMat.emissiveIntensity = trapped ? 0 : cheering ? 0.5 : 0.14;

    // Eyes: droopy squint while trapped, wide and blinking once free.
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blinkTimer = 1.6 + Math.random() * 3.4;
      this.blink = 1;
    }
    this.blink = Math.max(0, this.blink - dt * 9);
    const lid = trapped ? 0.55 : Math.sin(clamp01(this.blink) * Math.PI);
    this.eye.scale.y = 1 - lid * 0.9;
    this.pupil.scale.y = 1 - lid * 0.92;
    const wide = cheering ? 1.25 : 1;
    this.eye.scale.x = wide;
    this.pupil.scale.x = wide;
  }

  dispose(): void {
    this.bodyMat.dispose();
    this.domeMat.dispose();
    this.bulbMat.dispose();
    this.thrusterMat.dispose();
  }
}
