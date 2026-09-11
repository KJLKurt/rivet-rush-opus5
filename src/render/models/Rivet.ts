import * as THREE from 'three';
import { PAL } from '../Palette';
import { toonMat, glowMat, roundedBoxGeometry, outlineGroup } from '../Materials';
import { getTexture } from '../Textures';
import { clamp, clamp01, damp, lerp } from '../../core/Util';

/**
 * RIVET — a young raccoon inventor on a magnetic hoverboard.
 *
 * Built entirely from primitives, with chibi proportions (big head, small body,
 * chunky mitts) so he reads instantly at the game's camera distance. Design
 * cues that make him *him*: the dark bandit mask, the ringed tail, welding
 * goggles pushed up on his forehead, and a long orange scarf that streams
 * behind him — the scarf is doing most of the work of communicating speed.
 *
 * All animation is procedural. There is no skeleton and no keyframe data; every
 * pose is driven from the same handful of gameplay values (speed, turn rate,
 * dash timer, hurt timer), which is why the character never looks out of sync
 * with what the player is doing.
 */

export type RivetPose = 'ride' | 'dash' | 'hurt' | 'cheer' | 'idle' | 'tumble';

export interface RivetState {
  /** Horizontal speed in world units/sec. */
  speed: number;
  /** Normalised 0..1 against the character's top speed. */
  speed01: number;
  /** Signed turn rate, radians/sec — drives banking. */
  turn: number;
  /** 0..1 while a dash is active. */
  dash: number;
  /** 0..1 while hurt/invulnerable. */
  hurt: number;
  /** 0..1 overdrive blend. */
  overdrive: number;
  pose: RivetPose;
}

interface Chain {
  pivots: THREE.Object3D[];
  angles: Float32Array;
  vel: Float32Array;
}

const BOARD_SKINS: Record<string, { top: number; edge: number; under: number; glow: number }> = {
  classic: { top: PAL.boardTop, edge: PAL.boardEdge, under: PAL.boardUnder, glow: PAL.boardGlow },
  racer: { top: 0xf2f7ff, edge: 0x4fb2ff, under: 0x2a3350, glow: 0x8ad7ff },
  sprout: { top: 0x8ce06a, edge: 0x3f9c4f, under: 0x3a2e22, glow: 0x9dffd0 },
  storm: { top: 0x9a7dff, edge: 0x5a3fd0, under: 0x241d40, glow: 0xc7b3ff },
  sunburst: { top: 0xffd447, edge: 0xff7a2f, under: 0x3a2a1c, glow: 0xffe89a },
  scrapking: { top: 0xd6ddf2, edge: 0x98a2c4, under: 0x2c3350, glow: 0xff8a3d },
};

export class RivetModel {
  readonly root = new THREE.Group();

  // Pivot hierarchy — everything below is animated procedurally.
  private bankPivot = new THREE.Group();   // roll, for banking into turns
  private hoverPivot = new THREE.Group();  // vertical bob
  private bodyPivot = new THREE.Group();   // pitch lean
  private headPivot = new THREE.Group();
  private board = new THREE.Group();
  private boardGlowMesh!: THREE.Mesh;
  private coilRing!: THREE.Mesh;
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private earL = new THREE.Group();
  private earR = new THREE.Group();
  private eyeL!: THREE.Mesh;
  private eyeR!: THREE.Mesh;
  private pupilL!: THREE.Mesh;
  private pupilR!: THREE.Mesh;
  private browL!: THREE.Mesh;
  private browR!: THREE.Mesh;
  private goggles = new THREE.Group();
  private gauntletGlow!: THREE.Mesh;
  private groundShadow!: THREE.Mesh;

  private tail: Chain = { pivots: [], angles: new Float32Array(0), vel: new Float32Array(0) };
  private scarf: Chain = { pivots: [], angles: new Float32Array(0), vel: new Float32Array(0) };

  private furMat: THREE.MeshToonMaterial;
  private boardTopMat: THREE.MeshToonMaterial;
  private boardEdgeMat: THREE.MeshToonMaterial;
  private boardGlowMat: THREE.MeshBasicMaterial;
  private coilMat: THREE.MeshBasicMaterial;
  private outlines: THREE.Mesh[] = [];

  private t = 0;
  private blinkTimer = 2.4;
  private blink = 0;
  private bank = 0;
  private lean = 0;
  private bob = 0;
  private squash = 1;
  private flash = 0;
  private cheer = 0;
  private earTwitch = 0;
  private earTwitchTimer = 3;
  private lookX = 0;
  private lookY = 0;

  /** Where the zap tool fires from — refreshed every update. */
  readonly toolPosition = new THREE.Vector3();
  /** Where the trail should be anchored (under the board's rear). */
  readonly trailAnchor = new THREE.Vector3();

  constructor(boardSkin = 'classic') {
    this.furMat = toonMat(PAL.furMid, { ramp: 'soft', unique: true });
    const skin = BOARD_SKINS[boardSkin] ?? BOARD_SKINS.classic!;
    this.boardTopMat = toonMat(skin.top, { ramp: 'hard3', unique: true });
    this.boardEdgeMat = toonMat(skin.edge, { ramp: 'hard3', unique: true });
    this.boardGlowMat = glowMat(skin.glow, 0.85, true);
    this.coilMat = glowMat(skin.glow, 0.9, true);

    this.root.add(this.bankPivot);
    this.bankPivot.add(this.hoverPivot);
    this.hoverPivot.add(this.board);
    this.hoverPivot.add(this.bodyPivot);

    this.buildGroundShadow();
    this.buildBoard(skin);
    this.buildBody();
    this.buildHead();
    this.buildLimbs();
    this.buildTail();
    this.buildScarf();

    this.outlines = outlineGroup(this.root, 0.035);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !m.userData.noShadow) {
        m.castShadow = true;
        m.receiveShadow = false;
      }
    });
  }

  // --- construction --------------------------------------------------------

  /**
   * A soft blob shadow, drawn in addition to the real shadow map. Real shadows
   * get disabled on low-end devices and can wash out under a high sun, and
   * without *something* on the ground the board reads as floating in a void.
   * The blob lives on the root but cancels the root's yaw so it never spins.
   */
  private buildGroundShadow(): void {
    const mat = new THREE.MeshBasicMaterial({
      map: getTexture('shadowBlob'),
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      color: 0x0a1030,
      toneMapped: false,
      fog: false,
    });
    this.groundShadow = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 2.6), mat);
    this.groundShadow.rotation.x = -Math.PI / 2;
    this.groundShadow.position.y = 0.02;
    this.groundShadow.renderOrder = 2;
    this.groundShadow.userData.noShadow = true;
    this.groundShadow.userData.noOutline = true;
    this.groundShadow.matrixAutoUpdate = true;
    this.root.add(this.groundShadow);
  }

  private buildBoard(skin: { top: number; edge: number; under: number; glow: number }): void {
    const deck = new THREE.Mesh(roundedBoxGeometry(1.02, 0.12, 2.05, 0.055, 3), this.boardTopMat);
    deck.position.y = 0.08;
    this.board.add(deck);

    // Chamfered nose and tail so the silhouette is a board, not a slab.
    const nose = new THREE.Mesh(roundedBoxGeometry(0.72, 0.1, 0.42, 0.05, 2), this.boardEdgeMat);
    nose.position.set(0, 0.08, -1.14);
    nose.rotation.x = -0.18;
    this.board.add(nose);
    const tailTip = nose.clone();
    tailTip.position.z = 1.14;
    tailTip.rotation.x = 0.18;
    this.board.add(tailTip);

    // Underside chassis + the magnetic coil ring that makes it hover.
    const under = new THREE.Mesh(roundedBoxGeometry(0.82, 0.14, 1.6, 0.06, 2), toonMat(skin.under, { ramp: 'hard3' }));
    under.position.y = -0.02;
    this.board.add(under);

    const coilGeo = new THREE.TorusGeometry(0.3, 0.055, 6, 18);
    for (const z of [-0.62, 0.62]) {
      const coil = new THREE.Mesh(coilGeo, toonMat(PAL.metalMid, { ramp: 'hard3' }));
      coil.rotation.x = Math.PI / 2;
      coil.position.set(0, -0.06, z);
      this.board.add(coil);
    }
    this.coilRing = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.028, 6, 20), this.coilMat);
    this.coilRing.rotation.x = Math.PI / 2;
    this.coilRing.position.set(0, -0.08, 0);
    this.coilRing.userData.noShadow = true;
    this.board.add(this.coilRing);

    // Soft glow plate under the deck — this is what reads as "magnetic".
    const glowGeo = new THREE.PlaneGeometry(0.95, 1.9);
    this.boardGlowMesh = new THREE.Mesh(glowGeo, this.boardGlowMat);
    this.boardGlowMesh.rotation.x = -Math.PI / 2;
    this.boardGlowMesh.position.y = -0.14;
    this.boardGlowMesh.userData.noShadow = true;
    this.boardGlowMesh.userData.noOutline = true;
    this.boardGlowMesh.renderOrder = 4;
    this.board.add(this.boardGlowMesh);

    // Grip-tape stripes on top for readability from above.
    const stripeMat = toonMat(skin.under, { ramp: 'hard3' });
    for (const z of [-0.45, 0.45]) {
      const stripe = new THREE.Mesh(roundedBoxGeometry(0.78, 0.03, 0.2, 0.014, 2), stripeMat);
      stripe.position.set(0, 0.145, z);
      this.board.add(stripe);
    }
    this.board.position.y = 0.16;
  }

  private buildBody(): void {
    const torso = new THREE.Mesh(roundedBoxGeometry(0.62, 0.66, 0.5, 0.24, 4), this.furMat);
    torso.position.y = 0.62;
    torso.scale.set(1, 1, 0.95);
    this.bodyPivot.add(torso);

    const belly = new THREE.Mesh(roundedBoxGeometry(0.42, 0.46, 0.24, 0.16, 4), toonMat(PAL.belly));
    belly.position.set(0, 0.6, 0.19);
    this.bodyPivot.add(belly);

    // Scarf collar, hiding the head/body seam.
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.1, 7, 14), toonMat(PAL.scarf));
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 0.92;
    collar.scale.set(1, 1, 0.8);
    this.bodyPivot.add(collar);

    // Bright back plate: a little tool harness across his shoulders. Purely so
    // the rear three-quarter view has a strong warm accent to catch the eye.
    const harness = new THREE.Mesh(roundedBoxGeometry(0.5, 0.2, 0.12, 0.05, 2), toonMat(PAL.goggleRim));
    harness.position.set(0, 0.78, -0.24);
    this.bodyPivot.add(harness);
    const harnessStrap = new THREE.Mesh(roundedBoxGeometry(0.14, 0.42, 0.1, 0.04, 2), toonMat(PAL.scarfDark));
    harnessStrap.position.set(0, 0.6, -0.26);
    this.bodyPivot.add(harnessStrap);

    // Tool satchel on his hip — inventor detail.
    const satchel = new THREE.Mesh(roundedBoxGeometry(0.2, 0.22, 0.16, 0.06, 2), toonMat(PAL.woodDark));
    satchel.position.set(-0.34, 0.5, 0.02);
    satchel.rotation.z = 0.15;
    this.bodyPivot.add(satchel);
    const buckle = new THREE.Mesh(roundedBoxGeometry(0.1, 0.06, 0.03, 0.02, 1), toonMat(PAL.bolt));
    buckle.position.set(-0.36, 0.53, 0.1);
    this.bodyPivot.add(buckle);
  }

  private buildHead(): void {
    this.headPivot.position.set(0, 1.06, 0);
    this.bodyPivot.add(this.headPivot);

    const head = new THREE.Mesh(roundedBoxGeometry(0.72, 0.62, 0.62, 0.27, 5), this.furMat);
    head.scale.set(1, 0.96, 1);
    this.headPivot.add(head);

    // Bandit mask — the single most identifiable raccoon shape.
    const maskMat = toonMat(PAL.maskDark, { ramp: 'hard3' });
    const mask = new THREE.Mesh(roundedBoxGeometry(0.68, 0.24, 0.2, 0.09, 3), maskMat);
    mask.position.set(0, 0.03, 0.26);
    this.headPivot.add(mask);
    for (const sx of [-1, 1]) {
      const cheekBand = new THREE.Mesh(roundedBoxGeometry(0.14, 0.3, 0.34, 0.09, 3), maskMat);
      cheekBand.position.set(sx * 0.29, 0.0, 0.12);
      cheekBand.rotation.z = sx * 0.12;
      this.headPivot.add(cheekBand);
    }

    // Muzzle + nose.
    const muzzle = new THREE.Mesh(roundedBoxGeometry(0.34, 0.24, 0.24, 0.11, 4), toonMat(PAL.muzzle));
    muzzle.position.set(0, -0.16, 0.28);
    this.headPivot.add(muzzle);
    const nose = new THREE.Mesh(roundedBoxGeometry(0.13, 0.1, 0.09, 0.045, 3), toonMat(PAL.nose));
    nose.position.set(0, -0.13, 0.4);
    this.headPivot.add(nose);

    // Eyes: big cream ovals with dark pupils and a hard specular dot.
    const eyeGeo = new THREE.SphereGeometry(0.115, 12, 10);
    const pupilGeo = new THREE.SphereGeometry(0.068, 10, 8);
    const hiGeo = new THREE.SphereGeometry(0.03, 6, 6);
    const eyeMat = glowMat(0xf7fbff, 1, false);
    const pupilMat = toonMat(0x1c1f33, { ramp: 'hard3' });
    const hiMat = glowMat(0xffffff, 1, false);
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(sx * 0.18, 0.03, 0.33);
      eye.scale.set(1, 1.12, 0.6);
      eye.userData.noShadow = true;
      this.headPivot.add(eye);

      const pupil = new THREE.Mesh(pupilGeo, pupilMat);
      pupil.position.set(sx * 0.18, 0.02, 0.4);
      pupil.scale.set(1, 1.05, 0.5);
      pupil.userData.noShadow = true;
      this.headPivot.add(pupil);

      const hi = new THREE.Mesh(hiGeo, hiMat);
      hi.position.set(sx * 0.2, 0.08, 0.44);
      hi.userData.noShadow = true;
      this.headPivot.add(hi);

      const brow = new THREE.Mesh(roundedBoxGeometry(0.18, 0.042, 0.05, 0.02, 2), toonMat(PAL.furDark));
      brow.position.set(sx * 0.19, 0.19, 0.35);
      brow.rotation.z = sx * -0.1;
      this.headPivot.add(brow);

      if (sx < 0) {
        this.eyeL = eye;
        this.pupilL = pupil;
        this.browL = brow;
      } else {
        this.eyeR = eye;
        this.pupilR = pupil;
        this.browR = brow;
      }
    }

    // Ears, on their own pivots so they can twitch.
    for (const sx of [-1, 1]) {
      const pivot = sx < 0 ? this.earL : this.earR;
      pivot.position.set(sx * 0.29, 0.3, -0.02);
      pivot.rotation.z = sx * 0.25;
      this.headPivot.add(pivot);
      const ear = new THREE.Mesh(roundedBoxGeometry(0.22, 0.26, 0.11, 0.1, 4), this.furMat);
      ear.position.y = 0.12;
      pivot.add(ear);
      const inner = new THREE.Mesh(roundedBoxGeometry(0.12, 0.15, 0.06, 0.05, 3), toonMat(PAL.scarf));
      inner.position.set(0, 0.12, 0.05);
      pivot.add(inner);
    }

    // Welding goggles pushed up on his forehead — the inventor read.
    this.goggles.position.set(0, 0.27, 0.1);
    this.goggles.rotation.x = -0.5;
    this.headPivot.add(this.goggles);
    const strap = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.045, 6, 16), toonMat(PAL.maskDark));
    strap.rotation.x = Math.PI / 2;
    strap.scale.set(1, 1, 0.7);
    this.goggles.add(strap);
    for (const sx of [-1, 1]) {
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.045, 6, 14), toonMat(PAL.goggleRim));
      rim.position.set(sx * 0.16, 0.06, 0.2);
      this.goggles.add(rim);
      const glass = new THREE.Mesh(new THREE.CircleGeometry(0.1, 14), glowMat(PAL.goggleGlass, 0.85, false));
      glass.position.set(sx * 0.16, 0.06, 0.22);
      glass.userData.noShadow = true;
      glass.userData.noOutline = true;
      this.goggles.add(glass);
    }
    // A single antenna-ish tuft of head fur for personality.
    const tuft = new THREE.Mesh(roundedBoxGeometry(0.07, 0.2, 0.07, 0.03, 2), toonMat(PAL.furDark));
    tuft.position.set(0.06, 0.42, 0.02);
    tuft.rotation.z = -0.5;
    this.headPivot.add(tuft);
  }

  private buildLimbs(): void {
    const armGeo = roundedBoxGeometry(0.19, 0.44, 0.19, 0.09, 3);
    const mittGeo = roundedBoxGeometry(0.22, 0.2, 0.2, 0.09, 3);
    for (const sx of [-1, 1]) {
      const pivot = sx < 0 ? this.armL : this.armR;
      pivot.position.set(sx * 0.36, 0.86, 0);
      this.bodyPivot.add(pivot);
      const arm = new THREE.Mesh(armGeo, this.furMat);
      arm.position.y = -0.2;
      pivot.add(arm);
      const mitt = new THREE.Mesh(mittGeo, toonMat(PAL.furDark));
      mitt.position.y = -0.44;
      pivot.add(mitt);

      // Right arm carries the energy gauntlet — the auto-attack emitter.
      if (sx > 0) {
        const cuff = new THREE.Mesh(roundedBoxGeometry(0.26, 0.2, 0.26, 0.08, 3), toonMat(PAL.metalLight));
        cuff.position.y = -0.3;
        pivot.add(cuff);
        const emitter = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.035, 6, 12), toonMat(PAL.goggleRim));
        emitter.position.set(0, -0.5, 0.06);
        emitter.rotation.x = Math.PI / 2.3;
        pivot.add(emitter);
        this.gauntletGlow = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), glowMat(PAL.energy, 0.9, true));
        this.gauntletGlow.position.set(0, -0.52, 0.06);
        this.gauntletGlow.userData.noShadow = true;
        pivot.add(this.gauntletGlow);
      }
    }

    const legGeo = roundedBoxGeometry(0.21, 0.3, 0.22, 0.1, 3);
    const bootGeo = roundedBoxGeometry(0.26, 0.16, 0.34, 0.07, 3);
    for (const sx of [-1, 1]) {
      const pivot = sx < 0 ? this.legL : this.legR;
      // Feet are staggered along the board like a real board stance.
      pivot.position.set(sx * 0.17, 0.32, sx * 0.3);
      this.bodyPivot.add(pivot);
      const leg = new THREE.Mesh(legGeo, toonMat(PAL.furDark));
      leg.position.y = -0.1;
      pivot.add(leg);
      const boot = new THREE.Mesh(bootGeo, toonMat(PAL.goggleRim));
      boot.position.set(0, -0.26, 0.03);
      pivot.add(boot);
    }
  }

  private makeChain(
    parent: THREE.Object3D,
    count: number,
    origin: THREE.Vector3,
    build: (i: number) => THREE.Object3D,
  ): Chain {
    const pivots: THREE.Object3D[] = [];
    let cursor: THREE.Object3D = new THREE.Group();
    cursor.position.copy(origin);
    parent.add(cursor);
    pivots.push(cursor);
    cursor.add(build(0));
    for (let i = 1; i < count; i++) {
      const next = new THREE.Group();
      cursor.add(next);
      pivots.push(next);
      next.add(build(i));
      cursor = next;
    }
    return { pivots, angles: new Float32Array(count * 2), vel: new Float32Array(count * 2) };
  }

  private buildTail(): void {
    const segLen = 0.27;
    // High-contrast tail rings. The chase camera spends the whole game looking
    // at Rivet's back, and the tail is the largest thing on it.
    const darkMat = toonMat(0x424b6b);
    const lightMat = toonMat(0xf0f4ff);
    this.tail = this.makeChain(this.bodyPivot, 5, new THREE.Vector3(0, 0.5, -0.26), (i) => {
      const g = new THREE.Group();
      const r = 0.21 - i * 0.018;
      const seg = new THREE.Mesh(
        roundedBoxGeometry(r * 2, r * 2, segLen + 0.06, r * 0.85, 4),
        i % 2 === 0 ? darkMat : lightMat,
      );
      seg.position.z = -segLen * 0.5;
      g.add(seg);
      if (i > 0) g.position.z = -segLen;
      return g;
    });
    // Offset the child pivots so the segments chain properly.
    for (let i = 1; i < this.tail.pivots.length; i++) this.tail.pivots[i]!.position.z = -segLen;
  }

  private buildScarf(): void {
    const segLen = 0.3;
    const mats = [toonMat(PAL.scarf), toonMat(PAL.scarfDark)];
    this.scarf = this.makeChain(this.bodyPivot, 4, new THREE.Vector3(0.06, 0.88, -0.16), (i) => {
      const g = new THREE.Group();
      const w = 0.26 - i * 0.045;
      const seg = new THREE.Mesh(roundedBoxGeometry(w, 0.06, segLen + 0.04, 0.03, 2), mats[i % 2]!);
      seg.position.z = -segLen * 0.5;
      seg.userData.noShadow = true;
      g.add(seg);
      return g;
    });
    for (let i = 1; i < this.scarf.pivots.length; i++) this.scarf.pivots[i]!.position.z = -segLen;
  }

  // --- API -----------------------------------------------------------------

  setBoardSkin(id: string): void {
    const skin = BOARD_SKINS[id] ?? BOARD_SKINS.classic!;
    this.boardTopMat.color.setHex(skin.top);
    this.boardEdgeMat.color.setHex(skin.edge);
    this.boardGlowMat.color.setHex(skin.glow);
    this.coilMat.color.setHex(skin.glow);
  }

  static get boardSkins(): string[] {
    return Object.keys(BOARD_SKINS);
  }

  /** White flash used for damage and for landing an attack. */
  flashWhite(amount = 1): void {
    this.flash = Math.max(this.flash, amount);
  }

  /** Look toward a world point (the nearest enemy or collectible). */
  lookToward(dx: number, dz: number, facing: number): void {
    const localX = Math.cos(-facing) * dx - Math.sin(-facing) * dz;
    const localZ = Math.sin(-facing) * dx + Math.cos(-facing) * dz;
    const a = Math.atan2(localX, -localZ);
    this.lookX = clamp(a, -0.7, 0.7);
    this.lookY = clamp(-0.1, -0.4, 0.4);
  }

  /**
   * Fades the character out for first person. The board's underglow and the
   * ground shadow stay, so the player keeps a sense of where they physically
   * are even when the body is gone.
   */
  setAvatarOpacity(v: number): void {
    const visible = v > 0.02;
    if (this.bodyPivot.visible !== visible) {
      this.bodyPivot.visible = visible;
      this.board.visible = visible || v > 0;
      for (const o of this.outlines) o.visible = visible;
    }
    // Keep the board itself just visible in first person — a sliver of deck at
    // the bottom of the frame is a strong grounding cue.
    this.board.visible = true;
    this.groundShadow.visible = true;
  }

  setOutlinesVisible(on: boolean): void {
    for (const o of this.outlines) o.visible = on;
  }

  update(dt: number, s: RivetState): void {
    this.t += dt;
    const t = this.t;

    // --- banking & lean ----------------------------------------------------
    const bankTarget = clamp(-s.turn * 0.16, -0.44, 0.44) * (0.35 + s.speed01 * 0.75);
    this.bank = damp(this.bank, bankTarget, 11, dt);
    this.bankPivot.rotation.z = this.bank;

    const leanTarget = s.speed01 * 0.2 + s.dash * 0.34;
    this.lean = damp(this.lean, leanTarget, 10, dt);
    this.bodyPivot.rotation.x = this.lean - (s.pose === 'cheer' ? 0.25 : 0);
    // Counter-rotate the head so he keeps looking where he's going.
    this.headPivot.rotation.x = damp(this.headPivot.rotation.x, -this.lean * 0.7 + this.lookY, 12, dt);
    this.headPivot.rotation.y = damp(this.headPivot.rotation.y, this.lookX, 8, dt);
    this.lookX *= Math.exp(-2.5 * dt);

    // --- hover bob ---------------------------------------------------------
    const hoverFreq = 2.1 + s.speed01 * 1.8;
    this.bob = Math.sin(t * hoverFreq) * (0.055 + s.speed01 * 0.035);
    const dashCrouch = Math.sin(clamp01(s.dash) * Math.PI) * 0.11;
    this.hoverPivot.position.y = this.bob - dashCrouch;
    this.hoverPivot.rotation.z = Math.sin(t * 1.3) * 0.012;

    // Squash & stretch: stretched along travel while dashing, squashed on land.
    const targetSquash = 1 - s.dash * 0.16;
    this.squash = damp(this.squash, targetSquash, 14, dt);
    this.bodyPivot.scale.set(2 - this.squash, this.squash, 2 - this.squash);

    // --- board -------------------------------------------------------------
    this.board.rotation.x = -this.lean * 0.35;
    this.board.position.y = 0.16 - this.bob * 0.35;
    const glowPulse = 0.55 + Math.sin(t * 7) * 0.08 + s.speed01 * 0.3 + s.dash * 0.6 + s.overdrive * 0.4;
    this.boardGlowMat.opacity = clamp01(glowPulse);
    this.boardGlowMesh.scale.set(1 + s.dash * 0.35, 1 + s.dash * 0.5, 1);
    this.coilRing.rotation.z += dt * (5 + s.speed01 * 20 + s.dash * 40);
    this.coilRing.scale.setScalar(1 + Math.sin(t * 9) * 0.05 + s.dash * 0.3);

    // --- arms --------------------------------------------------------------
    let armLTarget: number;
    let armRTarget: number;
    let armSpread = 0.1;
    if (s.pose === 'cheer') {
      this.cheer = Math.min(1, this.cheer + dt * 4);
      armLTarget = -2.5 + Math.sin(t * 9) * 0.25;
      armRTarget = -2.5 + Math.sin(t * 9 + 1) * 0.25;
      armSpread = 0.5;
    } else if (s.pose === 'hurt' || s.pose === 'tumble') {
      armLTarget = -1.5 + Math.sin(t * 22) * 0.4;
      armRTarget = -1.2 + Math.sin(t * 20 + 2) * 0.4;
      armSpread = 0.7;
    } else if (s.dash > 0.01) {
      // Arms swept back like a speed skater.
      armLTarget = 1.15 * s.dash;
      armRTarget = 1.05 * s.dash;
      armSpread = 0.45 * s.dash;
    } else {
      const swing = Math.sin(t * (3 + s.speed01 * 3)) * (0.1 + s.speed01 * 0.16);
      armLTarget = swing - s.speed01 * 0.2;
      armRTarget = -swing - s.speed01 * 0.2;
      armSpread = 0.14 + s.speed01 * 0.16;
    }
    this.armL.rotation.x = damp(this.armL.rotation.x, armLTarget, 13, dt);
    this.armR.rotation.x = damp(this.armR.rotation.x, armRTarget, 13, dt);
    this.armL.rotation.z = damp(this.armL.rotation.z, armSpread, 10, dt);
    this.armR.rotation.z = damp(this.armR.rotation.z, -armSpread, 10, dt);
    if (s.pose !== 'cheer') this.cheer = Math.max(0, this.cheer - dt * 3);

    // --- legs: he crouches as he goes faster -------------------------------
    const crouch = s.speed01 * 0.28 + s.dash * 0.3;
    this.legL.rotation.x = damp(this.legL.rotation.x, -crouch * 0.5, 10, dt);
    this.legR.rotation.x = damp(this.legR.rotation.x, -crouch * 0.35, 10, dt);
    this.bodyPivot.position.y = -crouch * 0.09;

    // --- ears --------------------------------------------------------------
    this.earTwitchTimer -= dt;
    if (this.earTwitchTimer <= 0) {
      this.earTwitchTimer = 2.5 + Math.random() * 4;
      this.earTwitch = 1;
    }
    this.earTwitch = Math.max(0, this.earTwitch - dt * 4);
    const earFlap = s.speed01 * 0.4 + s.dash * 0.5;
    const twitch = Math.sin(this.earTwitch * Math.PI * 3) * 0.35 * this.earTwitch;
    this.earL.rotation.x = damp(this.earL.rotation.x, -earFlap * 0.6, 12, dt) + twitch;
    this.earR.rotation.x = damp(this.earR.rotation.x, -earFlap * 0.6, 12, dt) - twitch * 0.7;
    this.earL.rotation.z = 0.25 + earFlap * 0.25;
    this.earR.rotation.z = -0.25 - earFlap * 0.25;

    // --- blinking ----------------------------------------------------------
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blinkTimer = 2 + Math.random() * 3.6;
      this.blink = 1;
    }
    this.blink = Math.max(0, this.blink - dt * 8.5);
    const lidClose = s.pose === 'hurt' ? 0.75 : Math.sin(clamp01(this.blink) * Math.PI);
    const eyeScaleY = lerp(1.12, 0.1, lidClose);
    this.eyeL.scale.y = eyeScaleY;
    this.eyeR.scale.y = eyeScaleY;
    this.pupilL.scale.y = lerp(1.05, 0.08, lidClose);
    this.pupilR.scale.y = lerp(1.05, 0.08, lidClose);
    // Wide-eyed when dashing, determined squint at speed, worried when hurt.
    const pupilScale = 1 + s.dash * 0.35 - s.speed01 * 0.12 + this.cheer * 0.3;
    this.pupilL.scale.x = pupilScale;
    this.pupilR.scale.x = pupilScale;
    const browAngry = s.pose === 'hurt' ? -0.4 : s.speed01 * 0.22 + s.dash * 0.3;
    const browRaise = this.cheer * 0.09;
    this.browL.rotation.z = damp(this.browL.rotation.z, -0.1 - browAngry * 0.5, 12, dt);
    this.browR.rotation.z = damp(this.browR.rotation.z, 0.1 + browAngry * 0.5, 12, dt);
    this.browL.position.y = 0.19 + browRaise;
    this.browR.position.y = 0.19 + browRaise;

    // --- goggles bounce ----------------------------------------------------
    this.goggles.rotation.x = -0.5 + Math.sin(t * hoverFreq * 1.4) * 0.04 - s.dash * 0.12;

    // --- gauntlet glow -----------------------------------------------------
    const gaunt = 0.35 + Math.sin(t * 5) * 0.12 + s.overdrive * 0.5;
    this.gauntletGlow.scale.setScalar(0.8 + gaunt * 0.6);
    (this.gauntletGlow.material as THREE.MeshBasicMaterial).opacity = clamp01(0.5 + gaunt);

    // --- soft-body chains --------------------------------------------------
    // Tail and scarf are 2-DOF spring chains driven by the character's motion.
    // A little inertia here does more for "alive" than any amount of detail.
    const drive = s.speed01 * 0.9 + s.dash * 1.4;
    this.solveChain(this.tail, dt, {
      restX: -0.55 + drive * 0.75,
      restY: -this.bank * 1.1 + Math.sin(t * 3.4) * 0.12,
      stiffness: 90,
      damping: 12,
      wave: 0.22,
      waveSpeed: 6 + s.speed01 * 5,
      t,
    });
    this.solveChain(this.scarf, dt, {
      restX: 0.25 + drive * 0.95,
      restY: -this.bank * 1.8 + Math.sin(t * 5.1) * 0.28,
      stiffness: 120,
      damping: 10,
      wave: 0.34,
      waveSpeed: 9 + s.speed01 * 8,
      t,
    });

    // --- damage / overdrive tinting ---------------------------------------
    this.flash = Math.max(0, this.flash - dt * 5);
    const hurtPulse = s.hurt > 0 ? (Math.sin(t * 34) * 0.5 + 0.5) * 0.55 : 0;
    const em = Math.max(this.flash, hurtPulse, s.overdrive * 0.35);
    this.furMat.emissive.setHex(s.hurt > 0 ? PAL.danger : PAL.overdriveHot);
    this.furMat.emissiveIntensity = em;
    this.root.visible = !(s.hurt > 0 && Math.sin(t * 26) < -0.55);

    // Ground blob: stays flat on the world plane and shrinks slightly as he
    // hovers higher, which reads as vertical distance.
    const rootY = this.root.position.y;
    this.groundShadow.position.set(0, 0.02 - rootY / (this.root.scale.y || 1), 0);
    this.groundShadow.rotation.set(-Math.PI / 2, 0, -this.root.rotation.y);
    const lift = 1 - clamp01((rootY - 0.35) * 0.55);
    this.groundShadow.scale.setScalar(0.85 + lift * 0.2 + s.speed01 * 0.1);
    (this.groundShadow.material as THREE.MeshBasicMaterial).opacity = 0.22 * (0.7 + lift * 0.4);

    // --- exported anchors --------------------------------------------------
    this.gauntletGlow.getWorldPosition(this.toolPosition);
    _v.set(0, -0.1, 0.95);
    this.board.localToWorld(_v);
    this.trailAnchor.copy(_v);
  }

  private solveChain(
    chain: Chain,
    dt: number,
    o: { restX: number; restY: number; stiffness: number; damping: number; wave: number; waveSpeed: number; t: number },
  ): void {
    const n = chain.pivots.length;
    // Sub-step so a big frame spike can't make the springs explode.
    const steps = dt > 0.033 ? 2 : 1;
    const h = dt / steps;
    for (let step = 0; step < steps; step++) {
      for (let i = 0; i < n; i++) {
        const decay = 1 - i / (n + 1);
        const phase = o.t * o.waveSpeed - i * 0.9;
        const targetX = o.restX * decay + Math.sin(phase) * o.wave * (i / n);
        const targetY = o.restY * decay + Math.cos(phase * 0.8) * o.wave * 0.6 * (i / n);
        for (let axis = 0; axis < 2; axis++) {
          const k = i * 2 + axis;
          const target = axis === 0 ? targetX : targetY;
          const a = (target - chain.angles[k]!) * o.stiffness - chain.vel[k]! * o.damping;
          chain.vel[k] += a * h;
          chain.angles[k] += chain.vel[k] * h;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      chain.pivots[i]!.rotation.x = chain.angles[i * 2]!;
      chain.pivots[i]!.rotation.y = chain.angles[i * 2 + 1]!;
    }
  }

  dispose(): void {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry?.dispose();
    });
    this.furMat.dispose();
    this.boardTopMat.dispose();
    this.boardEdgeMat.dispose();
    this.boardGlowMat.dispose();
    this.coilMat.dispose();
  }
}

const _v = new THREE.Vector3();
