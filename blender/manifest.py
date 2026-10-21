"""Writes web/public/assets/dinos/manifest.json (species table + CC-BY attribution)."""
import json, os, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SK = "https://sketchfab.com/3d-models/"
species = [
 dict(id="trex", name="Tyrannosaurus rex", sayName="T. Rex", kind="land", diet="carnivore", lengthM=12, speed=1.4, voice="bigTheropod", biomes=["meadow","canyon"], count=2,
      attribution=dict(title="Tyrannosaurus Rex", author="Arion Digital", license="CC-BY-4.0", url=SK+"a3384b114989470fb60f0500aeaae903")),
 dict(id="triceratops", name="Triceratops", sayName="Triceratops", kind="land", diet="herbivore", lengthM=8.5, speed=1.1, voice="ceratopsian", biomes=["meadow"], count=3,
      attribution=dict(title="Triceratops Horridus", author="IagoMendez", license="CC-BY-4.0", url=SK+"cb7bad2c70dc4748a9c58ef9db5fce5e")),
 dict(id="stegosaurus", name="Stegosaurus", sayName="Stegosaurus", kind="land", diet="herbivore", lengthM=8, speed=0.9, voice="ceratopsian", biomes=["meadow","jungle"], count=2,
      attribution=dict(title="Stegosaurus", author="PAndras", license="CC-BY-4.0", url=SK+"b2545ed6031e49939b823b1c8435989e")),
 dict(id="paluxysaurus", name="Paluxysaurus", sayName="Long neck", kind="land", diet="herbivore", lengthM=20, speed=0.8, voice="sauropod", biomes=["meadow","jungle","lake"], count=3,
      attribution=dict(title="Paluxysaurus", author="Julian Johnson-Mortimer", license="CC-BY-4.0", url=SK+"afb6b5c7221b4f43a40762cdd9cdf90c")),
 dict(id="velociraptor", name="Velociraptor", sayName="Velociraptor", kind="land", diet="carnivore", lengthM=2.6, speed=2.4, voice="raptor", biomes=["canyon","meadow"], count=4,
      attribution=dict(title="Velociraptor", author="Tomas Ibar", license="CC-BY-4.0", url=SK+"b227da6c817043ab9a249dbbd127db67")),
 dict(id="sauropelta", name="Sauropelta", sayName="Sauropelta", kind="land", diet="herbivore", lengthM=5.5, speed=0.8, voice="ceratopsian", biomes=["jungle","swamp"], count=2,
      attribution=dict(title="Sauropelta", author="Julian Johnson-Mortimer", license="CC-BY-4.0", url=SK+"da2bc6ed57404f9f8ed56a975d674b2a")),
 dict(id="ankylosaurus", name="Ankylosaurus", sayName="Ankylosaurus", kind="land", diet="herbivore", lengthM=7, speed=0.8, voice="ceratopsian", biomes=["canyon","meadow"], count=2,
      attribution=dict(title="Ankylosaurus", author="InaLaAtzu", license="CC-BY-4.0", url=SK+"163daf7cc0664671b017ea874766e809")),
 dict(id="iguanodon", name="Iguanodon", sayName="Iguanodon", kind="land", diet="herbivore", lengthM=9, speed=1.2, voice="ceratopsian", biomes=["meadow","jungle","swamp"], count=3,
      attribution=dict(title="Iguanodon", author="Digital3dWorld", license="CC-BY-4.0", url=SK+"2dae61d169e346829b85998526091107")),
 dict(id="ornithocheirus", name="Ornithocheirus", sayName="Flying dinosaur", kind="air", diet="piscivore", lengthM=5, speed=6, voice="pterosaur", biomes=["beach","meadow","volcano"], count=4,
      attribution=dict(title="Ornithocheirus", author="Digital3dWorld", license="CC-BY-4.0", url=SK+"02d6ca0e98db474fa307b877ad2db90b")),
 dict(id="spinosaurus", name="Spinosaurus", sayName="Spinosaurus", kind="land", diet="piscivore", lengthM=14, speed=1.0, voice="bigTheropod", biomes=["swamp","beach"], count=2,
      attribution=dict(title="Spinosaurus", author="Julian Johnson-Mortimer", license="CC-BY-4.0", url=SK+"4f2332ee93874d59a55fb60ed2873ec2")),
 dict(id="carnotaurus", name="Carnotaurus", sayName="Carnotaurus", kind="land", diet="carnivore", lengthM=8, speed=1.8, voice="bigTheropod", biomes=["volcano","canyon"], count=2,
      attribution=dict(title="CARNOTAURUS DINOSAUR", author="Cenker Turhan", license="CC-BY-4.0", url=SK+"548c9a0575b14deaae1f12ca9a6c31ca")),
 dict(id="allosaurus", name="Allosaurus", sayName="Allosaurus", kind="land", diet="carnivore", lengthM=9, speed=1.7, voice="bigTheropod", biomes=["jungle","volcano"], count=2,
      attribution=dict(title="Allosaurus", author="PAndras", license="CC-BY-4.0", url=SK+"6c5142e093a147bdb86e0eeb837b476c")),
 dict(id="pachycephalosaurus", name="Pachycephalosaurus", sayName="Pachycephalosaurus", kind="land", diet="herbivore", lengthM=4.5, speed=1.6, voice="chirp", biomes=["meadow","snow"], count=3,
      attribution=dict(title="Pachycephalosaurus_animation", author="seirogan", license="CC-BY-4.0", url=SK+"740349873ae244ef8a19155b525d9193")),
 dict(id="pistosaurus", name="Pistosaurus", sayName="Sea dinosaur", kind="water", diet="piscivore", lengthM=3.5, speed=1.5, voice="marine", biomes=["lake","beach"], count=3,
      attribution=dict(title="Pistosaur Animated", author="ricksticky", license="CC-BY-4.0", url=SK+"773667575a264c7baa4ec404115a044b")),
 dict(id="mosasaurus", name="Mosasaurus", sayName="Mosasaurus", kind="water", diet="carnivore", lengthM=13, speed=1.8, voice="marine", biomes=["beach"], count=2,
      attribution=dict(title="mosasaurus", author="Epic_devolepment", license="CC-BY-4.0", url=SK+"6c343575d0df414aba162c69ac1f0105")),
]
outdir = os.path.join(root, "web", "public", "assets", "dinos")
for s in species:
    s["file"] = f"{s['id']}.glb"
    clips = {"idle": "idle", "roar": "roar"}
    if s["kind"] == "land": clips.update(walk="walk", eat="eat")
    elif s["kind"] == "air": clips.update(fly="fly")
    else: clips.update(swim="swim")
    s["clips"] = clips
    meta = os.path.join(root, "blender", "out", f"{s['id']}.json")
    if os.path.exists(meta):
        sz = json.load(open(meta))["size"]; s["heightM"] = round(sz[2], 2); s["widthM"] = round(sz[0], 2)
json.dump(dict(version=1, species=species, note="All dinosaur models are third-party CC-BY works, processed (cleaned, rigged, animated, optimized) in Blender for Dino Pals. See attribution per species."),
          open(os.path.join(outdir, "manifest.json"), "w"), indent=1)
print("manifest written", len(species))
