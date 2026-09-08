import { clamp, clamp01 } from './Util';

/**
 * Unified input for touch, mouse, keyboard and gamepad.
 *
 * Design notes (this file matters more for "feel" than almost any other):
 *  - The left half of the screen is a *dynamic* joystick: the stick appears
 *    wherever the thumb lands, and if the thumb travels past the ring the base
 *    slides after it. Fixed-position sticks feel awful on phones of different
 *    sizes; this one is always exactly where the player's thumb already is.
 *  - The right half is one enormous dash target. There is a drawn button for
 *    discoverability, but tapping *anywhere* on that half dashes, so a child
 *    never misses. Overdrive gets its own button that only exists when it is
 *    usable, so there is never a dead control on screen.
 *  - Every control is tracked by pointerId, so steering and dashing at the same
 *    time works on multi-touch.
 *  - Buttons are edge-triggered and buffered: a press registers for a few
 *    frames, so an input made a hair early still counts. Forgiving input reads
 *    as "responsive" far more than raw latency does.
 */

export type ButtonName = 'dash' | 'overdrive' | 'pause' | 'any';

const BUFFER_SECONDS = 0.14;

interface Button {
  down: boolean;
  /** Seconds since the last press; < BUFFER_SECONDS counts as "just pressed". */
  age: number;
  consumed: boolean;
}

const makeButton = (): Button => ({ down: false, age: 999, consumed: true });

export interface JoystickView {
  active: boolean;
  /** CSS pixels, relative to the viewport. */
  baseX: number;
  baseY: number;
  knobX: number;
  knobY: number;
  radius: number;
}

export class Input {
  /** Analog move vector in screen space. x: right, y: down. |v| <= 1. */
  moveX = 0;
  moveY = 0;
  /** Raw magnitude before deadzone shaping — handy for animation. */
  moveMag = 0;

  /** True when the player has touched the screen at least once. */
  usingTouch = false;
  /** True when a gamepad has reported input this session. */
  usingGamepad = false;
  /** Set while a pointer is held on the dash half — used for the button visual. */
  dashHeld = false;

  readonly joystick: JoystickView = {
    active: false,
    baseX: 0,
    baseY: 0,
    knobX: 0,
    knobY: 0,
    radius: 74,
  };

  /** When true, gameplay input is ignored (menus/pause own the screen). */
  gameplayEnabled = false;

  private readonly buttons: Record<ButtonName, Button> = {
    dash: makeButton(),
    overdrive: makeButton(),
    pause: makeButton(),
    any: makeButton(),
  };

  private readonly keys = new Set<string>();
  private stickPointer = -1;
  private stickStartX = 0;
  private stickStartY = 0;
  private element: HTMLElement | null = null;
  /** Rects for the on-screen buttons, in CSS pixels; set by the HUD each layout. */
  private overdriveRect: DOMRect | null = null;
  private overdriveVisible = false;
  private padIndex = -1;
  private prevPadButtons: boolean[] = [];
  private disposers: Array<() => void> = [];

  attach(element: HTMLElement): void {
    this.element = element;
    const opts = { passive: false } as const;

    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window,
      type: K | string,
      fn: (ev: never) => void,
      options?: AddEventListenerOptions,
    ): void => {
      target.addEventListener(type, fn as EventListener, options);
      this.disposers.push(() => target.removeEventListener(type, fn as EventListener, options));
    };

    on(element, 'pointerdown', (e: PointerEvent) => this.onPointerDown(e), opts);
    on(element, 'pointermove', (e: PointerEvent) => this.onPointerMove(e), opts);
    on(element, 'pointerup', (e: PointerEvent) => this.onPointerUp(e), opts);
    on(element, 'pointercancel', (e: PointerEvent) => this.onPointerUp(e), opts);
    on(element, 'lostpointercapture', (e: PointerEvent) => this.onPointerUp(e));

    // Stop the browser from scrolling, zooming or showing the magnifier while
    // the player is steering.
    on(element, 'touchstart', (e: TouchEvent) => e.preventDefault(), opts);
    on(element, 'touchmove', (e: TouchEvent) => e.preventDefault(), opts);
    on(element, 'contextmenu', (e: Event) => e.preventDefault());
    on(window, 'gesturestart', (e: Event) => e.preventDefault(), opts as AddEventListenerOptions);

    on(window, 'keydown', (e: KeyboardEvent) => this.onKeyDown(e));
    on(window, 'keyup', (e: KeyboardEvent) => this.onKeyUp(e));
    on(window, 'blur', () => this.releaseAll());

    on(window, 'gamepadconnected', (e: GamepadEvent) => {
      this.padIndex = e.gamepad.index;
    });
    on(window, 'gamepaddisconnected', () => {
      this.padIndex = -1;
      this.usingGamepad = false;
    });
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.element = null;
  }

  /** The HUD reports where the Overdrive button is so touches there don't dash. */
  setOverdriveButton(rect: DOMRect | null, visible: boolean): void {
    this.overdriveRect = rect;
    this.overdriveVisible = visible;
  }

  // --- pointer -------------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'touch') this.usingTouch = true;
    this.press('any');
    if (!this.gameplayEnabled) return;

    this.element?.setPointerCapture?.(e.pointerId);

    if (this.overdriveVisible && this.overdriveRect && this.hitsOverdrive(e.clientX, e.clientY)) {
      this.press('overdrive');
      return;
    }

    const half = window.innerWidth * 0.5;
    // Mouse always steers with keys; a mouse press anywhere means dash.
    const steering = e.pointerType !== 'mouse' && e.clientX < half;

    if (steering && this.stickPointer === -1) {
      this.stickPointer = e.pointerId;
      this.stickStartX = e.clientX;
      this.stickStartY = e.clientY;
      const j = this.joystick;
      j.active = true;
      j.baseX = e.clientX;
      j.baseY = e.clientY;
      j.knobX = e.clientX;
      j.knobY = e.clientY;
    } else {
      this.dashHeld = true;
      this.press('dash');
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (e.pointerId !== this.stickPointer) return;
    const j = this.joystick;
    let dx = e.clientX - this.stickStartX;
    let dy = e.clientY - this.stickStartY;
    const dist = Math.hypot(dx, dy);
    const r = j.radius;

    // Sliding base: past the ring, drag the origin along so the stick can never
    // "run out" during a long swipe.
    if (dist > r) {
      const over = dist - r;
      const nx = dx / dist;
      const ny = dy / dist;
      this.stickStartX += nx * over;
      this.stickStartY += ny * over;
      dx = nx * r;
      dy = ny * r;
    }

    j.baseX = this.stickStartX;
    j.baseY = this.stickStartY;
    j.knobX = this.stickStartX + dx;
    j.knobY = this.stickStartY + dy;
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.pointerId === this.stickPointer) {
      this.stickPointer = -1;
      this.joystick.active = false;
    } else {
      this.dashHeld = false;
    }
  }

  private hitsOverdrive(x: number, y: number): boolean {
    const r = this.overdriveRect;
    if (!r) return false;
    const pad = 14; // generous touch slop — kids' thumbs are imprecise
    return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
  }

  // --- keyboard ------------------------------------------------------------

  private onKeyDown(e: KeyboardEvent): void {
    const code = e.code;
    if (e.repeat) return;
    this.press('any');

    if (
      code === 'Space' ||
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight' ||
      code === 'Tab'
    ) {
      // Don't let the page scroll or move focus mid-run.
      if (this.gameplayEnabled || code === 'Space') e.preventDefault();
    }

    this.keys.add(code);
    if (!this.gameplayEnabled) return;

    if (code === 'Space' || code === 'ShiftLeft' || code === 'ShiftRight' || code === 'KeyJ') {
      this.dashHeld = true;
      this.press('dash');
    }
    if (code === 'KeyE' || code === 'KeyK' || code === 'Enter') this.press('overdrive');
    if (code === 'Escape' || code === 'KeyP') this.press('pause');
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.keys.delete(e.code);
    if (
      e.code === 'Space' ||
      e.code === 'ShiftLeft' ||
      e.code === 'ShiftRight' ||
      e.code === 'KeyJ'
    ) {
      this.dashHeld = false;
    }
  }

  private releaseAll(): void {
    this.keys.clear();
    this.stickPointer = -1;
    this.joystick.active = false;
    this.dashHeld = false;
    this.moveX = 0;
    this.moveY = 0;
    this.moveMag = 0;
  }

  // --- per-frame -----------------------------------------------------------

  update(dt: number): void {
    for (const key of Object.keys(this.buttons) as ButtonName[]) {
      this.buttons[key].age += dt;
    }

    let x = 0;
    let y = 0;

    if (this.joystick.active) {
      const j = this.joystick;
      x = (j.knobX - j.baseX) / j.radius;
      y = (j.knobY - j.baseY) / j.radius;
    } else if (this.gameplayEnabled) {
      const k = this.keys;
      if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
      if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
      if (k.has('KeyW') || k.has('ArrowUp')) y -= 1;
      if (k.has('KeyS') || k.has('ArrowDown')) y += 1;
    }

    if (this.gameplayEnabled) this.pollGamepad(x === 0 && y === 0);
    if (this.padStickX !== 0 || this.padStickY !== 0) {
      x = this.padStickX;
      y = this.padStickY;
    }

    let mag = Math.hypot(x, y);
    if (mag > 1) {
      x /= mag;
      y /= mag;
      mag = 1;
    }

    // Deadzone with re-normalisation, so the first millimetre of thumb travel
    // still produces smooth low speeds instead of snapping to a minimum.
    const DEAD = 0.16;
    if (mag < DEAD) {
      this.moveX = 0;
      this.moveY = 0;
      this.moveMag = 0;
    } else {
      const shaped = clamp01((mag - DEAD) / (1 - DEAD));
      // Slight curve: precise at low tilt, full speed reached before the rim.
      const curved = clamp01(shaped * 1.08);
      this.moveX = (x / mag) * curved;
      this.moveY = (y / mag) * curved;
      this.moveMag = curved;
    }
  }

  private padStickX = 0;
  private padStickY = 0;

  private pollGamepad(stickIsFree: boolean): void {
    this.padStickX = 0;
    this.padStickY = 0;
    const pads = navigator.getGamepads?.();
    if (!pads) return;
    let pad: Gamepad | null = null;
    if (this.padIndex >= 0) pad = pads[this.padIndex] ?? null;
    if (!pad) {
      for (const p of pads) {
        if (p) {
          pad = p;
          this.padIndex = p.index;
          break;
        }
      }
    }
    if (!pad) return;

    if (stickIsFree) {
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      if (Math.hypot(ax, ay) > 0.2) {
        this.padStickX = clamp(ax, -1, 1);
        this.padStickY = clamp(ay, -1, 1);
        this.usingGamepad = true;
      }
      // D-pad fallback (buttons 12–15).
      const dUp = pad.buttons[12]?.pressed;
      const dDown = pad.buttons[13]?.pressed;
      const dLeft = pad.buttons[14]?.pressed;
      const dRight = pad.buttons[15]?.pressed;
      if (dUp || dDown || dLeft || dRight) {
        this.padStickX = (dRight ? 1 : 0) - (dLeft ? 1 : 0);
        this.padStickY = (dDown ? 1 : 0) - (dUp ? 1 : 0);
        this.usingGamepad = true;
      }
    }

    const pressedNow = (i: number): boolean => pad!.buttons[i]?.pressed ?? false;
    const edge = (i: number): boolean => {
      const now = pressedNow(i);
      const was = this.prevPadButtons[i] ?? false;
      this.prevPadButtons[i] = now;
      return now && !was;
    };
    // A / RB / RT → dash. X / LB → overdrive. Start → pause.
    const dash = edge(0) || edge(5) || edge(7);
    const od = edge(2) || edge(4) || edge(6);
    const pause = edge(9);
    // Keep the rest of the table in sync so edges stay correct next frame.
    for (let i = 0; i < pad.buttons.length; i++) this.prevPadButtons[i] = pressedNow(i);

    this.dashHeld = pressedNow(0) || pressedNow(5) || pressedNow(7);
    if (dash) {
      this.press('dash');
      this.usingGamepad = true;
    }
    if (od) {
      this.press('overdrive');
      this.usingGamepad = true;
    }
    if (pause) {
      this.press('pause');
      this.usingGamepad = true;
    }
  }

  // --- buttons -------------------------------------------------------------

  private press(name: ButtonName): void {
    const b = this.buttons[name];
    b.down = true;
    b.age = 0;
    b.consumed = false;
  }

  /**
   * Lets the on-screen HUD buttons feed the same buffered edge-trigger path as
   * physical input, so a tapped Dash behaves identically to a Space press.
   */
  injectPress(name: ButtonName): void {
    if (!this.gameplayEnabled && name !== 'any') return;
    this.press(name);
  }

  /** Edge-triggered read with a short input buffer. Consumes the press. */
  consume(name: ButtonName): boolean {
    const b = this.buttons[name];
    if (!b.consumed && b.age <= BUFFER_SECONDS) {
      b.consumed = true;
      return true;
    }
    return false;
  }

  /** Peek without consuming. */
  pressed(name: ButtonName): boolean {
    const b = this.buttons[name];
    return !b.consumed && b.age <= BUFFER_SECONDS;
  }

  clearBuffers(): void {
    for (const key of Object.keys(this.buttons) as ButtonName[]) {
      this.buttons[key].consumed = true;
      this.buttons[key].age = 999;
    }
  }
}

export const input = new Input();
