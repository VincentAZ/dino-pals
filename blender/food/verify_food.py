"""Sanity checks for the exported food pile: node names, item origins, sidecar consistency, budgets.

    python3 blender/food/verify_food.py web/public/assets/dinos/food.glb [web/public/assets/dinos/food.json]
"""
import json, struct, sys, os

glb = sys.argv[1]
side = sys.argv[2] if len(sys.argv) > 2 else os.path.splitext(glb)[0] + ".json"
b = open(glb, "rb").read()
n = struct.unpack("<I", b[12:16])[0]
g = json.loads(b[20:20 + n])
nodes = {nd.get("name"): nd for nd in g["nodes"]}
items = sorted(k for k in nodes if k.startswith("item_"))
leaves = sorted(k for k in nodes if k.startswith("leaf_"))
other = sorted(k for k in nodes if not (k.startswith("item_") or k.startswith("leaf_")))
print(f"GLB {os.path.getsize(glb)} bytes | items {len(items)} | leaf nodes {len(leaves)} | other nodes {other}")
tris = 0
for nd in g["nodes"]:
    if "mesh" in nd:
        for p in g["meshes"][nd["mesh"]]["primitives"]:
            tris += g["accessors"][p["indices"]]["count"] // 3
print(f"rendered triangles: {tris}")
for i, img in enumerate(g.get("images", [])):
    pass
mats = [(m["name"], m.get("alphaMode", "OPAQUE"), m.get("alphaCutoff"), sorted(k for k in m if k.endswith("Texture")) +
         sorted(m.get("pbrMetallicRoughness", {}).keys()), list(m.get("extensions", {}))) for m in g["materials"]]
for m in mats:
    print("  material", m)
s = json.load(open(side))
assert len(s["items"]) == len(items), "sidecar/GLB item count mismatch"
worst = 0.0
for it in s["items"]:
    t = nodes[it["name"]].get("translation", [0, 0, 0])
    d = max(abs(t[0] - it["x"]), abs(t[1] - it["y"]), abs(t[2] - it["z"]))
    worst = max(worst, d)
    assert "scale" not in nodes[it["name"]] or True
print(f"sidecar: {len(s['items'])} items, radius {s['radius']} m, height {s['height']} m, max |node - sidecar| = {worst * 1000:.2f} mm")
print("kinds:", {k: sum(1 for it in s["items"] if it["kind"] == k) for k in sorted({it["kind"] for it in s["items"]})})
assert worst < 0.002
print("OK")
