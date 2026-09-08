# Game Design — Rivet Rush: Sky Salvage

**Player:** children roughly 7–12, with parents and casual adults as a secondary
audience. **Run length:** 6–9 minutes. **Session goal:** finish a run and
immediately want another one.

---

## 1. The pitch

Rivet, a young raccoon inventor, rides a magnetic hoverboard across floating
mechanical islands. A mysterious machine has scattered the islands' energy and
trapped the little maintenance robots — the Sparkies. Free them all, then deal
with the machine responsible.

Everything the player does is expressed through **movement**. There is no aiming,
no inventory, no menus mid-stage. The skill ceiling comes from routing, timing,
and knowing when to spend a dash.

## 2. Core mechanics

### Move
A floating virtual stick on the left half of the screen, keyboard, or gamepad.
The stick appears wherever the thumb lands and its base slides if the thumb
travels past the ring, so it can never "run out" during a long swipe.

Three numbers define how the board feels:

- **Acceleration 62 u/s²** — roughly 0.25 s to top speed (12.6 u/s). Instant
  velocity feels robotic; a long ramp feels like driving a bus. This sits in the
  narrow window that reads as *eager*.
- **Turn assist 46** — extra acceleration applied specifically against the
  component of velocity that opposes the stick. Without it, reversing at speed
  feels like ice. With it, the board bites and pivots while still carving an arc.
- **Brake 34** — releasing the stick stops you crisply but leaves a little glide.

Rivet banks into turns, leans with speed, crouches as he accelerates, and his
scarf and ringed tail are two-degree-of-freedom spring chains driven by his own
motion. None of this is keyframed; every pose is derived from the same handful of
gameplay values, which is why the character never looks out of sync with the
player's hands.

### Dash — the verb the game is built on
Two charges by default, 1.45 s to refill one. A dash is a **0.19 s** burst at
30 u/s, and it leaves you with 52% of that speed, so *chaining dashes* is the
fast way to cross an island. It also:

- Smashes crates (which burst into bolts)
- Stuns drones for 1.5 s and deals 2 damage
- Breaks a Shieldbot's shield — the only thing that does
- Pops open Sparkie rescue pods
- Damages the Great Scrapbot's exposed core
- Grants 0.34 s of invulnerability, so dashing *out* of danger always works

One button solves every problem in the game. That is deliberate: a seven-year-old
should never have to work out *which* thing to press.

Feedback on a dash: a 55 ms hitstop, a camera dolly punch and FOV kick, a radial
speed blur, an expanding ground shockwave, a trail that swells to three times its
width, a layered whoosh + sub-thump + electric zip, and a haptic tick.

### Auto-attack
Rivet's gauntlet fires at the nearest drone within 7.2 m every 0.5 s. The player
never aims. Chain Zap upgrades make it jump to additional targets. This exists so
that combat rewards *positioning* rather than dexterity.

### Magnet
Bolts within 2.9 m accelerate toward Rivet, growing a sparkling comet tail as
they come. Upgrades widen the radius; Overdrive triples it. This is the most
purely satisfying thing in the game, which is why an entire upgrade family feeds it.

### Health
Three hearts. Shields (from upgrades) absorb a hit first and refresh each stage.
1.5 s of invulnerability after a hit. The Guardian Sparkie upgrade revives you
once per run. Damage sounds are a soft bonk, never harsh — failure should feel
gentle in a game for this age.

## 3. Scoring and combos

| Pickup | Base |
| --- | --- |
| Bolt | 25 |
| Energy cell | 250 |
| Sparkie rescue | 400 |
| Drone defeated | 150 |
| Crate smashed | 40 |

Anything collected within the combo window (2.6 s, extendable) increments the
combo. Multiplier tiers at 4 / 9 / 16 / 25 / 36 / 50 / 70 pickups give
×1.25 → ×5.

Escalation is deliberately multi-sensory, because the combo *is* the game's
tension curve: the pickup sound climbs a major pentatonic scale, the HUD chip
punches and re-colours, particles thicken, the camera adds a small kick at high
tiers, and Overdrive fills faster the higher your tier.

**Stage bonuses:** 500 for clearing, up to 30/second of remaining par time, and
750 for a stage with no damage taken. Beating the boss is worth 5,000, and
finishing the whole run without a scratch adds 8,000.

## 4. Overdrive

A meter fed by everything good you do, scaled by your current combo tier. When it
fills, a gold button appears — **the player chooses when to spend it**, which is
the difference between a power-up and a light show.

For 8 seconds (extendable): +32% speed, unlimited dashes, 3× magnet radius,
zap fires twice as fast for double damage, all score doubled, a gold trail, a
warm screen wash, and an extra music layer over the top of whatever track is
playing.

It is intentionally simple. There is one button, it appears only when usable, and
what it does is visible without reading anything.

## 5. Level structure

Three areas of two stages each, then the finale. Every stage introduces exactly
one new idea and then gives the player a whole stage to enjoy being good at it.

| # | Area | Stage | Introduces |
| --- | --- | --- | --- |
| 1 | Sunbeam Scrapyard | Warm-Up Run | Moving, collecting, rescuing. **No enemies for the first 18 seconds.** |
| 2 | Sunbeam Scrapyard | Bolt Yard | Dashing through crates; more drones. |
| 3 | Cloudtop Gardens | Windmill Way | Moving hazards (blades, steam vents); charging Sawdrones. |
| 4 | Cloudtop Gardens | Greenhouse Rush | Zapper turrets that telegraph a beam; boost pads. |
| 5 | Stormworks | Live Wires | Sliding energy walls; Bomblets that chase and detonate. |
| 6 | Stormworks | Storm Core | Shieldbots — dash-only targets. Everything at once. |
| 7 | Finale | The Great Scrapbot | The boss. |

**Arena shape.** Each stage is a floating disc with a magnetic fence at the rim
that pushes you back with a hum and a glow. Nobody ever falls off. For this age
group, "you died because you fell" is the least fun failure there is.

**Bolt routing.** Bolts are laid down in *routes* — long arcs, figure-eights,
inward spirals, and risky sprays around hazards — not sprinkled at random.
Following a route naturally carves a turn, and carving a turn at speed is the
thing that feels best in this game, so the level design is constantly nudging the
player into the fun. A guaranteed trail of bolts leads away from the spawn point,
so the first thing a new player ever sees is a line of shiny things.

**Goal.** Free every Sparkie, then ride into the exit gate. An off-screen arrow
points at the nearest objective, and only when it is genuinely off-screen.

## 6. Enemies

Every one telegraphs, and every one is a wind-up toy rather than a threat.

| Enemy | Behaviour | The answer |
| --- | --- | --- |
| **Buzzbot** | Drifts toward you with a lazy wobble. | Anything. It's the tutorial. |
| **Sawdrone** | Circles, then commits to a fast, perfectly straight charge after a 0.6 s wind-up. | Move sideways. |
| **Zapper** | Stationary turret. Charges a visible orb for 1.1 s while slowly tracking you, then fires a beam down a marked line. | Keep moving. |
| **Bomblet** | Chases fast, then flashes and detonates in a marked radius after 0.95 s. | Dash away, or kill it first. |
| **Shieldbot** | Advances behind a hex shield that bounces zaps off. | **Dash it** to shatter the shield. |

Defeated drones pop into harmless bouncing scrap and drop bolts, so every kill
feeds the combo. There is no gore, no death animation, nothing frightening.

## 7. The Great Scrapbot

A lovable grumpy junk-golem that built itself out of the scrapyard: a boxy
riveted torso with a hinged chest hatch, two mismatched arms (a magnet claw and a
giant crusher fist), stubby legs on a hover skirt, exhaust funnels that puff
smoke, and expressive eyes under angled eyebrow plates.

**The loop the fight teaches in about fifteen seconds:**

> it winds up → you dodge → it's stuck → you dash the core

Every attack is announced by a pose *and* a ground marker, and every attack except
the sweep leaves the machine staggered with its core exposed. Contact damage is
switched **off** while it's staggered — that window is the player's reward, and
charging in to use it must not cost a heart.

| Attack | Telegraph | Dodge |
| --- | --- | --- |
| **Slam** | The crusher fist rears back, the body coils, and a red ring shrinks onto the target spot. | Leave the circle; dash over the outgoing shockwave. |
| **Sweep** | The magnet arm charges a growing orb and the head tracks the beam line. | Walk around it, or dash through. |
| **Spawn** | The chest hatch cracks open with light spilling out. | Deal with the Buzzbots, or ignore them and hit the core. |
| **Vacuum** (phase 3) | Leans in, arms wide, pulling you toward it while scrap rains into marked circles. | Dash — it beats the pull. |

The expanding shockwave's damage band is derived from the drawn ring, so what you
see is exactly what hits you.

**Phases** at 66% and 33% health: it sheds shoulder armour, the core burns
magenta, it vents sparks and smoke, and everything speeds up by about a quarter —
but nothing becomes less readable. **A repair heart drops at each phase change.**
Losing a seven-minute run to attrition three seconds from the end is miserable.

Victory: the machine sputters, sags, the hatch bursts open and light pours out.

## 8. Upgrades

After every stage the player picks one of three cards. Rules:

- One sentence with a concrete verb per card. No percentages to do arithmetic on.
- Every upgrade changes something **visible** in the very next stage — a wider
  magnet ring, another dash pip, a Sparkie that helps you collect.
- **Nothing is a trap.** The worst pick is still a real improvement, so a bad
  choice never ruins a run.
- Picks stack, so a run can commit to a build.

Eighteen upgrades across seven families — collect, dash, attack, defence,
Overdrive, movement and score. The draft is weighted by rarity, excludes anything
already maxed, and avoids offering two cards from the same family when it can, so
the choice always means something.

Six picks per run out of eighteen options, stacking, means the "all-magnet",
"all-dash", "Sparkie swarm" and "glass cannon" runs all feel materially different.

## 9. Difficulty

The curve is built from four independent dials, so it can be tuned without any
one of them spiking:

1. **Enemy mix** — one new type per area, always introduced alone first.
2. **Enemy density** — waves arrive on a timer, so a slow player faces fewer.
3. **Hazard density** — blades, vents and walls scale up per area.
4. **Arena size** — 24 m to 30 m, giving later stages more room to route.

Fairness rails: no falling, no off-screen damage, generous i-frames, 1.5 s of
invulnerability after a hit, telegraphs on everything, repair hearts in the back
half of the run, and shields that refresh each stage.

## 10. Replayability

- **Score chase.** Best score, best combo and a local top-eight table.
- **Sixteen achievements**, all skill-shaped ("clear a stage without a scratch",
  "reach a 60 combo") rather than time-served.
- **Eleven cosmetics** — six trails and five hoverboard skins — earned from
  achievements, purely visual, no grind.
- **Upgrade builds** — the main source of run-to-run variety.
- **Seeded arenas.** Every stage's layout is generated from a seed, so no two
  runs put the bolts and hazards in the same places.
- **Daily Challenge.** A deterministic seed from the local date plus two
  modifiers (Turbo Day, Magnet Day, Careful Day, Bolt Rain…). Entirely offline,
  identical on the same device all day, and there is **no streak** and nothing to
  lose by skipping a day.

## 11. What we deliberately left out

No ads, no purchases, no login, no chat, no social features, no daily-login
rewards, no energy timers, no loot boxes, no personal data collection. A child can
play this alone with the network switched off and nothing about it is trying to
get anything from them.
