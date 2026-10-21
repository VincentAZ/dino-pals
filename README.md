# Dino Pals

A touch-first, open-world dinosaur sandbox for very young children (built for a 3-year-old on an iPad).
No rules, no score, no reading: tap the ground to walk, tap a dinosaur to hear it and learn its name.

- `web/` — Vite + TypeScript + three.js app (deployed as a static site on Vercel).
- `blender/` — headless Blender 5 pipeline that cleans, rigs, animates and exports the dinosaurs.
- `LOG.md` — build log with every decision.

## Run
```bash
cd web && npm install && npm run dev
```

## Rebuild dinosaurs
```bash
blender/run_all.sh <dir-with-source-glbs> --preview   # rig + animate + export + QA renders
blender/postprocess.sh                                # Draco/WebP → web/public/assets/dinos
python3 blender/manifest.py                           # manifest + attribution
```
Dinosaur models are CC-BY works by their Sketchfab authors (see the in-app credits and `manifest.json`);
environment assets are CC0 from Poly Haven.
