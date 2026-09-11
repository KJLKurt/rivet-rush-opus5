# Rivet Rush: Sky Salvage

An original, family-friendly 3D arcade game and installable Progressive Web App.

You are **Rivet**, a young raccoon inventor on a magnetic hoverboard. A mysterious
machine has scattered the little maintenance robots — the **Sparkies** — across a
chain of floating sky islands. Carve through the islands, magnet up every bolt you
can reach, free the Sparkies, dodge the rogue drones, and go and have a word with
the Great Scrapbot.

- Two modes: **Adventure** (three areas, six stages, one boss — about 6–9
  minutes) and **Swarm** (endless waves; rescue Sparkies to a repair pad and
  defend it with turrets, walls, bombs, shockers and beacons).
- One-thumb controls: a floating virtual stick and one enormous **DASH** button.
  Gadgets build where you're standing, so there's nothing to aim.
- Works completely offline after the first load. No account, no ads, no purchases,
  no chat, no tracking, and nothing that leaves your device.

---

## Quick start

Requires **Node 24** (an `.nvmrc` is included).

```bash
nvm use            # or: nvm install 24
npm install
npm run dev        # http://localhost:5173
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with hot reload, bound to your LAN so you can open it on a real phone. |
| `npm run build` | Regenerates the app icons, type-checks, and produces the production build in `dist/`. |
| `npm run preview` | Serves `dist/` locally at `http://localhost:4173`. Use this to test the service worker — it does not run in dev. |
| `npm run typecheck` | `tsc --noEmit` only. |
| `npm run icons` | Regenerates the PWA icon set from `scripts/generate-icons.mjs`. |
| `npm run playtest` | Runs the full automated playtest in headless Chromium (see below). |
| `npm run check:audio` | Proves every sound effect and music track produces real audio output. |
| `npm run check:pages` | Serves `dist/` under a subpath and verifies the PWA still installs and works offline. |
| `npm run build:gh` | Production build with the base path set for a GitHub Pages project site. |

## Testing it for real

The game ships with an automated playtest that boots the production build in a
real browser, plays a complete run with the in-game bot, and fails on any console
error:

```bash
npm run build
npm run playtest -- --shots --seconds=420
```

It checks the title screen, settings, collection, a full multi-stage run, the
upgrade flow, pause/resume, local persistence across a reload, four viewport
sizes, and that the game still loads with the network switched off. Screenshots
land in `playtest-shots/`, and a machine-readable summary in
`playtest-report.json`.

You can also drive the game by hand from the browser console:

```js
__rivet.play()          // start a run
__rivet.autoplay(true)  // hand over to the bot
__rivet.skipTo(6)       // jump straight to the boss
__rivet.game.startSwarm()  // start Swarm mode
__rivet.state()         // current game state
```

These hooks are intentionally not reachable from the interface, so a player can
never stumble into them.

---

## Deploying

The build output in `dist/` is a plain static site. It needs **HTTPS** for the
service worker (and therefore for installability); every host below provides it.

### Cloudflare Pages

**From the dashboard:** create a Pages project, connect the repository, and set

- Build command: `npm run build`
- Build output directory: `dist`
- Node version: `24` (add an environment variable `NODE_VERSION = 24`)

**From the CLI:**

```bash
npm run build
npx wrangler pages deploy dist --project-name rivet-rush
```

Nothing else is required — there is no backend, no environment secret, and no
API key.

### Netlify / Vercel / any static host

Build command `npm run build`, publish directory `dist`. Ensure the host serves
`sw.js` from the site root with `Cache-Control: no-cache` (both Netlify and
Vercel do this for service workers by default).

### GitHub Pages

GitHub Pages serves project sites from a subpath, so the build needs to know it:

```bash
BASE_PATH=/<your-repo-name>/ npm run build
```

or use `npm run build:gh` after editing the path in `package.json`. Then publish
`dist/` to the `gh-pages` branch (for example with `npx gh-pages -d dist`) and
enable Pages for that branch.

> **Note on GitHub Pages:** a project site works fine, including the service
> worker and offline play, as long as you build with the matching `BASE_PATH`.
> If you ever host it at a path the build wasn't configured for, the service
> worker scope won't match and the app will still run but won't install. Building
> for the root of a custom domain avoids the issue entirely.

---

## Installing the app

The game is a real PWA: a manifest, a maskable icon set, a service worker and an
offline cache. After you load it once over HTTPS it is fully playable with no
network.

**iPhone / iPad (Safari)**
1. Open the site in **Safari** (installation is not available in Chrome on iOS).
2. Tap the **Share** button.
3. Scroll down and tap **Add to Home Screen**, then **Add**.
4. Launch it from the home screen — it opens fullscreen with no browser chrome.

**Android (Chrome / Edge)**
1. Open the site.
2. Tap the **Install** button on the title screen, or open the browser menu and
   choose **Install app** / **Add to Home screen**.
3. Confirm. It installs as a standalone app and appears in your launcher.

**Desktop (Chrome / Edge)**
Click the install icon in the address bar, or use the **Install** button on the
title screen.

The game is designed for a **phone held in landscape**. It plays perfectly well
in portrait and on desktop, and it will suggest rotating on a small portrait
screen without forcing you to.

## Controls

| | Touch | Keyboard | Gamepad |
| --- | --- | --- | --- |
| Move | Slide anywhere on the left half | `WASD` / arrows | Left stick / D-pad |
| Dash | The big **DASH** button, or tap anywhere on the right half | `Space` / `Shift` / `J` | `A` / `RB` / `RT` |
| Overdrive | The gold button (only appears when it's ready) | `E` / `K` / `Enter` | `X` / `LB` |
| Pause | The pause button | `Esc` / `P` | `Start` |
| Build a gadget (Swarm) | The item bar along the bottom | `1`–`5` | — |

## Accessibility

In **Settings**: a **difficulty** toggle (Relaxed gives more hearts and a gentler
boss), four **camera** modes (Close, Wide, Behind, Goggles — the last two steer
where you look), master / music / effects volume, screen-shake intensity, a
**Calm mode** that cuts flashes and heavy effects, vibration toggle, a
left-handed layout that mirrors the touch controls, bigger buttons, an FPS
readout, and a graphics-quality override. Nothing important in the game is
signalled by colour alone. The system `prefers-reduced-motion` setting is
respected for interface animation.

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the code is organised and why.
- [`GAME_DESIGN.md`](GAME_DESIGN.md) — mechanics, scoring, difficulty, upgrades, replayability.
- [`ASSET_MANIFEST.md`](ASSET_MANIFEST.md) — every asset and how it was produced.
- [`THIRD_PARTY_ASSETS.md`](THIRD_PARTY_ASSETS.md) — licensing and provenance (short version: there aren't any).

## License

MIT for the code. All original art, audio and characters are part of this project.
