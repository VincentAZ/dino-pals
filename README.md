# Dino Pals

A touch-first, open-world dinosaur sandbox for very young children (built for a 3-year-old on an iPad).
No rules, no score, no reading: tap the ground to walk, tap a dinosaur to hear it and learn its name.

- `web/` — Vite + TypeScript + three.js app (deployed as a static site on Vercel).
- `blender/` — headless Blender 5 pipeline that cleans, rigs, animates and exports the dinosaurs.
- `LOG.md` — build log with every decision.

## For grown-ups (iPad)
- **Full screen:** open the site in Safari, tap Share, then *Add to Home Screen*, and launch Dino Pals from its icon.
- **Lock the iPad to the game:** Settings, Accessibility, *Guided Access* on; open Dino Pals and triple-click the top (or Home) button.
- **Grown-up panel** (credits, reset position, these tips): hold the small *i* in the top-left corner for two seconds.

## Run
```bash
cd web && npm install && npm run dev
```

## Tests (run from `web/` after `npm run build`)
Headless Chromium with the GPU (plus WebKit for Safari), iPad-sized touch viewport:
- `node tests/smoke.mjs`: every biome, both quality tiers, portrait, touch gestures, zero errors.
- `node tests/webkit_smoke.mjs`: the Safari engine.
- `node tests/gait.mjs`, `node tests/smooth.mjs`: foot slip and IK reach per species; per-frame jolts, hip dips and sideways sliding (`SCEN=free|food|taps`).
- `node tests/collide.mjs`, `node tests/eat.mjs`: no animal ever overlaps a tree or another animal; bites land in the mouth.
- `node tests/monkey.mjs`, `node tests/spam.mjs`: minutes of random toddler input; rapid taps.
- `node tests/lifecycle.mjs`, `node tests/governor.mjs`, `node tests/leak.mjs`, `node tests/texmem.mjs`: iPad lifecycle, adaptive resolution, long-session memory, GPU texture budget.
- `BASE=https://… node tests/prod.mjs`: post-deploy check against the live site.
- `node tests/reel.mjs`: renders a 30 fps demo video to `demo/dino-pals-reel.mp4`.

## Rebuild dinosaurs
```bash
blender/run_all.sh <dir-with-source-glbs> --preview   # rig + animate + export + QA renders
blender/postprocess.sh                                # Draco/WebP → web/public/assets/dinos
python3 blender/manifest.py                           # manifest + attribution
```
Dinosaur models are CC-BY works by their Sketchfab authors (see the in-app credits and `manifest.json`);
environment assets are CC0 from Poly Haven.
