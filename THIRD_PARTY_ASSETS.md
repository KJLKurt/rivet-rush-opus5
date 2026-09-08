# Third-Party Assets

**No third-party assets are used in Rivet Rush: Sky Salvage.**

Every asset in this project was created from scratch during its development.
Nothing was downloaded, sampled, traced, or derived from an external source.

## What that means, concretely

| Asset class | Source |
| --- | --- |
| 3D models (Rivet, hoverboard, Sparkies, drones, the Great Scrapbot, props, collectibles) | Generated at runtime from Three.js primitives in `src/render/models/`. No `.glb`, `.fbx`, `.obj` or any other model file exists in the repository. |
| Textures and materials | Drawn procedurally into a `<canvas>` at runtime by `src/render/Textures.ts` and wrapped in `THREE.CanvasTexture`. No image files are shipped as textures. |
| Sound effects | Synthesized at runtime with the Web Audio API in `src/core/Audio.ts`. No audio files exist in the repository. |
| Music | Composed for this project as note data in `src/core/Audio.ts` and played back through synthesizer voices built from Web Audio nodes. No audio files, no samples, no loops. |
| App icons, favicon, maskable icons | Drawn programmatically with `@napi-rs/canvas` by `scripts/generate-icons.mjs`, and as hand-written SVG for the favicon. |
| Store screenshots (`public/icons/screenshot-*.png`) | Captured from the running game by `scripts/capture-screenshots.mjs`. |
| UI icons | Hand-authored inline SVG paths in `src/ui/Icons.ts`. |
| Fonts | None are bundled or downloaded. The interface uses a CSS system-font stack only, so the game renders identically offline and on first paint. |

## Software dependencies

The game depends on open-source **software libraries**, which are not assets and
are not redistributed as creative content:

| Package | Version | License |
| --- | --- | --- |
| [three](https://github.com/mrdoob/three.js) | 0.185.1 | MIT |
| [vite](https://github.com/vitejs/vite) | 8.2.2 | MIT |
| [vite-plugin-pwa](https://github.com/vite-pwa/vite-plugin-pwa) | 1.3.0 | MIT |
| [workbox-window](https://github.com/GoogleChrome/workbox) | 7.4.1 | MIT |
| [typescript](https://github.com/microsoft/TypeScript) | 7.0.2 | Apache-2.0 |
| [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas) | 1.0.8 | MIT — build-time only, used to generate icons |
| [playwright](https://github.com/microsoft/playwright) | 1.63.0 | Apache-2.0 — development only, used for the automated playtest |

`three` is the only library that ships in the production bundle.

## Attribution requirements

None. There are no attribution-licensed assets in this project, so there is
nothing to preserve, credit, or carry forward if you fork or modify it.

## Original characters and world

Rivet, the Sparkies, the rogue drones (Buzzbot, Sawdrone, Zapper, Bomblet,
Shieldbot), the Great Scrapbot, and the areas (Sunbeam Scrapyard, Cloudtop
Gardens, Stormworks) are original creations for this project. They are not based
on, and are not intended to resemble, any existing character, game, film, or
franchise.
