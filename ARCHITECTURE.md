# Architecture

A single-page TypeScript app. No framework, no state library, no backend. The
whole thing is one `requestAnimationFrame` loop driving a Three.js scene, with a
DOM layer on top for anything the player reads or taps.

```
index.html            inlined boot screen, canvas, #ui mount
src/
  main.ts             boot, main loop, browser lifecycle, service worker
  style.css           the entire interface
  core/               engine services, no gameplay knowledge
    Audio.ts          Web Audio synthesis: every SFX and all six music tracks
    Input.ts          touch / mouse / keyboard / gamepad → one analog vector + buffered buttons
    Save.ts           IndexedDB profile with a synchronous localStorage mirror
    Util.ts           math, easing, seeded PRNG, pooling
  render/             everything visual, no gameplay knowledge
    Renderer.ts       WebGLRenderer, post-processing chain, automatic quality scaling
    CameraRig.ts      three-quarter chase camera: spring follow, trauma shake, punch
    Sky.ts            gradient dome, cloud sea, parallax islands, storm lightning
    Fx.ts             pooled particle batches, ground rings, flashes
    Trail.ts          the hoverboard ribbon
    Palette.ts        colours and per-area lighting themes
    Textures.ts       every texture, drawn procedurally into a canvas and cached
    Materials.ts      toon material factory, inverted-hull outlines, rounded-box geometry
    models/           Rivet, Sparkie, Enemies, EnemiesExtra, Boss, Props,
                      Deployables — all built from primitives
  game/               rules and content
    Game.ts           the orchestrator and state machine (both modes)
    Config.ts         every tuning number, in one place
    Player.ts         movement, dash, magnet, health, Overdrive
    Entities.ts       collectibles, rescue pods, crates, enemy AI
    EnemyTypes.ts     the unified 10-enemy roster and its tuning table
    BossFight.ts      the Great Scrapbot's state machine
    Swarm.ts          Swarm mode: wave director, repair pad, escort
    Gadgets.ts        deployable turrets/walls/bombs/shockers/beacons
    Arena.ts          per-stage island generation and prop placement
    Stages.ts         the run: six stages plus the finale
    Upgrades.ts       upgrade definitions and the weighted draft
    Progression.ts    achievements, cosmetics, daily challenge
    Bot.ts            the automated playtest player (plays both modes)
  ui/                 the DOM layer
    UI.ts             every screen, the HUD, world-space score popups
    Icons.ts          the icon set as inline SVG paths
scripts/
  generate-icons.mjs      draws the PWA icon set (build step)
  capture-screenshots.mjs captures the manifest screenshots from real gameplay
  playtest.mjs            headless full-run regression test
  audio-check.mjs         proves every SFX and track produces real output
  check-subpath.mjs       GitHub Pages subpath / service-worker check
```

## The three layers

The dependency rule is one-directional: **`ui` → `game` → `render`/`core`**.

- **`core` and `render` know nothing about the game.** `Fx` doesn't know what a
  Sparkie is; `Input` doesn't know what a dash is. They're reusable services.
- **`game` owns all the rules.** It's the only layer that knows a bolt is worth
  25 points or that a stagger lasts 4.6 seconds.
- **`ui` never touches gameplay state.** `Game` pushes everything the interface
  needs out through a `GameHooks` object (`onHud`, `onPopup`, `onResults`, …) and
  the UI calls back through a small public API (`startRun`, `pickUpgrade`,
  `pause`). That boundary is what keeps a 3,000-line HUD from growing tendrils
  into the physics.

## The loop

`main.ts` runs a plain rAF loop with a clamped delta (`min(dt, 1/15)`), so a
frame spike slows the simulation rather than teleporting anything through a wall.
There is no fixed timestep: collision is resolved by circle push-out rather than
raycasts, so variable steps are safe, and matching the display's refresh rate is
what makes the game feel right on a 120 Hz phone.

`Game.update()` multiplies that delta by a `timeScale` used for **hitstop** — the
few-frame freeze on a dash, a kill, or a boss hit. Camera shake, particles and the
interface keep running on the real delta so the freeze reads as impact rather than
as a stall.

## Two modes, one engine

`Game.mode` is `'story'` or `'swarm'`. Both use the same player, arena,
collectibles, enemies, particles and camera; only the **objective layer**
differs. Story mode runs `Stages.ts` and a portal; Swarm mode runs
`SwarmDirector` and a repair pad. Enemy AI didn't need a swarm branch at all —
`Enemies.padTarget` simply redirects the "toward the target" vector before
`think()` runs, so every existing behaviour works unchanged against either
target.

## The camera

`CameraRig` blends between four presets: `chase` (~35°), `wide` (~43°), `follow`
(~26° over-the-shoulder) and `fpv` (first person). Any preset can blend to any
other; the rig keeps a `fromMode`/`mode` pair and eases between them.

Presets carry a `rotates` weight. At 0 the camera uses a fixed world-space
offset; at 1 it orbits to sit behind the player's heading, and `Game` rotates
the stick vector by `rig.inputYaw` to match. At yaw 0 the orbiting maths
collapses exactly to the world-aligned offset, which is what lets an overhead
and an over-the-shoulder preset blend continuously instead of popping.

The camera-relative rotation is applied to the **human stick only** — the
playtest bot reasons in world space, and rotating its intentions makes it
spiral.

The focus point is a spring integrated in **fixed 1/120s sub-steps with
exponential damping**. The obvious explicit-Euler form is unstable once
`damping * dt` exceeds 1 — at 15fps that term reaches 1.03, the velocity flips
sign every frame, and the camera stops following the player entirely. It looked
fine at 60fps and fell apart on exactly the weak devices that can least afford a
broken camera.

## Rendering

`MeshToonMaterial` with cel gradient ramps, plus inverted-hull outlines on
characters only (never the environment, to keep draw calls down). One shadow-
casting directional light whose orthographic frustum is re-centred on the player
every frame, a hemisphere fill and a rim light.

Post-processing is `EffectComposer` → `RenderPass` → `UnrealBloomPass` → a custom
grade pass → `OutputPass`. The grade pass is cheap and does a lot: vignette,
saturation, a radial speed blur during dashes and Overdrive, and a full-screen
colour wash for damage and Overdrive. The bloom threshold is deliberately high
(0.9) — the world is bright and saturated by design, and a low threshold turns
the whole image into pale soup.

**Quality scaling** is automatic. `Renderer.detectQuality()` picks a starting tier
from device memory, core count and pointer type, then a rolling FPS average steps
it down below ~46 fps and back up above ~58, with hysteresis and a cooldown so it
can't oscillate. Each tier changes device-pixel-ratio cap, shadow map size,
MSAA sample count, whether post-processing runs at all, and whether outlines are
drawn. The player can override it in Settings.

## Performance

Everything that can be pooled is pooled, because a GC pause mid-dash is the one
thing the player will definitely notice:

- Particles live in three fixed-size `THREE.Points` batches (one per sprite look)
  with free lists. Emitting a thousand sparks allocates nothing and adds no draw
  calls; when the budget is exhausted the oldest particle is recycled.
- Collectibles, enemies, rescue pods, crates, ground decals, telegraph rings and
  zap arcs are all pooled objects that get hidden and reused across stages.
- Geometry and materials are cached by key in `Materials.ts`, so building the
  same prop fifty times is nearly free.
- Static props merge their sub-geometries per material with `mergeGeometries`, so
  a prop is typically one to three draw calls.
- Per-frame code avoids allocation: scratch `Vector3`s are module-level, and the
  hot paths take output arrays rather than returning new ones.

## Audio

`src/core/Audio.ts` is a complete synthesizer. No audio files exist. The
`AudioContext` is created lazily inside `unlock()` on the first real gesture, so
the module is import-safe and autoplay policy is respected. The graph is
`master → compressor → destination` with separate music and SFX buses and a
lowpass on the music bus for the pause/upgrade muffle. Music runs on a lookahead
scheduler (a ~25 ms tick queueing notes ~120 ms ahead against `ctx.currentTime`)
rather than a timer per note, so it stays in time. Voices are capped and
near-duplicate triggers within ~25 ms are dropped, which is what stops ten
simultaneous bolt pickups from distorting.

## Persistence

One JSON profile: settings, best score, best combo, lifetime totals, achievements,
unlocked cosmetics, the daily-challenge record and a local high-score table. It's
written to **IndexedDB** (durable) and mirrored to **localStorage** (synchronous,
so the very first frame has the right settings without waiting on an async open).
Reads merge whichever store has more progress, since they only diverge if one was
evicted. Writes are debounced, and flushed immediately on `pagehide` and
`visibilitychange`. Everything degrades to defaults if storage is blocked.

No account, no server, no personal data, nothing leaves the device.

## PWA

`vite-plugin-pwa` in `generateSW` mode. All build output is precached, so after
one successful load the game is fully playable offline. `navigateFallback` points
at the built `index.html` and the base path is configurable through `BASE_PATH`
for subpath hosting. Icons — including maskable variants — are generated at build
time by `scripts/generate-icons.mjs`; the manifest screenshots come from real
gameplay via `scripts/capture-screenshots.mjs`.

Lifecycle is handled explicitly: the game pauses and flushes the save on
`visibilitychange` and `blur`, throttles to ~30 fps while hidden, resumes the
audio context on return, and listens for `webglcontextlost` / `restored` to pause
and rebuild the post-processing chain.

## Testing

`scripts/playtest.mjs` runs the production build in headless Chromium with
SwiftShader, drives a complete run with the in-game bot, and exits non-zero on any
console error, page error or failed request. It exercises the title, settings and
collection screens, a full multi-stage run, the upgrade flow, pause/resume,
persistence across a reload, four viewport sizes, and an offline reload.

`src/game/Bot.ts` is a real player substitute rather than an input recorder: it
picks objectives, detours for nearby bolts, reads the boss's ground telegraphs
and dashes out of danger bands. That means it keeps working when the levels
change, which is the only way an automated playtest survives contact with
iteration.
