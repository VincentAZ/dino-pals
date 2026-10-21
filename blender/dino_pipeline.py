"""Dino Pals — Blender asset pipeline (headless).

Usage:
  blender -b --python blender/dino_pipeline.py -- <species_id> <source.glb> <out_dir> [--preview]

Steps: import → clean junk → strip foreign rigs → join → normalize orientation/scale/origin
→ decimate → build procedural armature fitted to the mesh → skin weights (heat, fallback distance)
→ procedural animation clips (idle/walk/roar/eat | idle/fly/roar | idle/swim/roar) → export GLB
→ optional preview renders of every clip.
"""
import bpy, bmesh, sys, os, math, json, time
import numpy as np
from mathutils import Vector, Matrix, Quaternion, Euler

argv = sys.argv[sys.argv.index("--") + 1:]
SPECIES_ID, SRC, OUT_DIR = argv[0], argv[1], argv[2]
PREVIEW = "--preview" in argv
FPS = 30

# ---------------------------------------------------------------- species table
# length = nose-to-tail length in metres (for flyers: wingspan). flip = force head direction override.
SPECIES = {
    "trex":              dict(head=0.12, neck=0.07, length=12.0, walk_speed=1.3, kind="land", gait="biped",  tris=48000, remove=[]),
    "triceratops":       dict(head=0.26, neck=0.03, jaw=0.5, length=8.5, walk_speed=1.2,  kind="land", gait="quad",   tris=45000, remove=["Object_14", "Object_8", "Cube"], fix_normals=True, clear_normals=True),
    "stegosaurus":       dict(head=0.06, neck=0.08, jaw=0.85, length=8.0, walk_speed=0.9,  kind="land", gait="quad",   tris=40000, remove=[]),
    "paluxysaurus":      dict(head=0.04, neck=0.28, jaw=0.8, length=20.0, walk_speed=1.0, amp=0.4, kind="land", gait="quad",   tris=50000, remove=[]),
    "velociraptor":      dict(head=0.10, neck=0.09, length=2.6, walk_speed=1.2, amp=1.3,  kind="land", gait="biped",  tris=30000, remove=[]),
    "sauropelta":        dict(head=0.08, neck=0.07, jaw=0.8, length=5.5, walk_speed=0.8,  kind="land", gait="quad",   tris=40000, remove=[]),
    "ankylosaurus":      dict(head=0.08, neck=0.05, jaw=0.8, length=7.0, walk_speed=0.8, amp=0.6,  kind="land", gait="quad",   tris=40000, remove=[], no_smooth=True),
    "iguanodon":         dict(head=0.09, neck=0.08, jaw=0.85, length=9.0, walk_speed=1.0,  kind="land", gait="quad",   tris=40000, remove=["Object_4"]),
    "ornithocheirus":    dict(head=0.30, neck=0.12, length=5.0,  kind="air",  gait="wing",   tris=30000, remove=[]),
    "spinosaurus":       dict(head=0.12, neck=0.09, length=14.0, walk_speed=1.1, kind="land", gait="biped",  tris=50000, remove=[]),
    "carnotaurus":       dict(head=0.09, neck=0.08, length=8.0, walk_speed=1.4,  kind="land", gait="biped",  tris=40000, remove=["BODY_BODY_0.001"]),
    "allosaurus":        dict(head=0.11, neck=0.08, length=9.0, walk_speed=1.3,  kind="land", gait="biped",  tris=40000, remove=["Object_6", "Object_8"]),
    "pachycephalosaurus":dict(head=0.10, neck=0.08, length=4.5, walk_speed=1.2, amp=1.15,  kind="land", gait="biped",  tris=35000, remove=[]),
    "pistosaurus":       dict(head=0.07, neck=0.26, hip=0.62, length=3.5,  kind="water",gait="swim",   tris=20000, remove=[]),
    "mosasaurus":        dict(head=0.12, neck=0.05, hip=0.55, length=13.0, kind="water",gait="swim",   tris=35000, remove=[]),
}
CFG = SPECIES[SPECIES_ID]
KIND, GAIT = CFG["kind"], CFG["gait"]
LOG = []
def log(*a):
    s = " ".join(str(x) for x in a); LOG.append(s); print("[dino]", s, flush=True)

# ---------------------------------------------------------------- import + clean
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.fps = FPS
bpy.ops.import_scene.gltf(filepath=SRC)
t0 = time.time()

def all_meshes(): return [o for o in bpy.data.objects if o.type == 'MESH']

# junk: Sketchfab icospheres, named removals, degenerate meshes
for o in list(bpy.data.objects):
    if o.type == 'MESH':
        junk = (o.name in CFG["remove"]) or (o.name.startswith("Icosphere") and len(o.data.materials) == 0) or len(o.data.polygons) < 40
        if junk:
            log("remove", o.name); bpy.data.objects.remove(o)

# strip foreign rigs: apply armature deformation at rest pose (bind pose) and drop armature
# bake the imported pose (first animation frame — the importer places the mesh correctly for it)
if bpy.data.actions:
    sc.frame_set(int(min(a.frame_range[0] for a in bpy.data.actions)) + 1)
bpy.context.view_layer.update()
for o in all_meshes():
    if o.data.users > 1: o.data = o.data.copy()
    for m in list(o.modifiers):
        if m.type == 'ARMATURE':
            bpy.context.view_layer.objects.active = o
            try: bpy.ops.object.modifier_apply(modifier=m.name); log("applied armature on", o.name)
            except Exception as e: log("modifier_apply failed", o.name, e); o.modifiers.remove(m)
        elif m.type != 'ARMATURE':
            try: bpy.ops.object.modifier_apply(modifier=m.name)
            except Exception: o.modifiers.remove(m)
    o.vertex_groups.clear()
for o in list(bpy.data.objects):
    if o.type == 'ARMATURE': bpy.data.objects.remove(o)
for a in list(bpy.data.actions): bpy.data.actions.remove(a)

# flatten parents (keep world transform), join
for o in all_meshes():
    mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
for o in list(bpy.data.objects):
    if o.type not in ('MESH',): bpy.data.objects.remove(o)
meshes = all_meshes()
bpy.ops.object.select_all(action='DESELECT')
for o in meshes: o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1: bpy.ops.object.join()
body = bpy.context.view_layer.objects.active
body.name = SPECIES_ID
body.rotation_mode = 'XYZ'
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
log("joined tris", len(body.data.polygons), "mats", len(body.data.materials))
if CFG.get("clear_normals"):
    try: bpy.ops.mesh.customdata_custom_splitnormals_clear(); log("custom normals cleared")
    except Exception as e: log("clear normals failed", e)
    bpy.ops.object.shade_smooth()
if CFG.get("fix_normals"):
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False); bpy.ops.object.mode_set(mode='OBJECT'); log("normals recalculated")

def verts_np(obj):
    me = obj.data; n = len(me.vertices)
    co = np.empty(n * 3, dtype=np.float32); me.vertices.foreach_get("co", co)
    return co.reshape(n, 3)

# ---------------------------------------------------------------- normalize orientation
V = verts_np(body)
mn, mx = V.min(0), V.max(0); size = mx - mn
log("raw size", size.round(2))
if KIND == "air":
    # wingspan along X; head/tail along Y. Long axis should already be X; if not rotate.
    if size[1] > size[0]:
        body.rotation_euler = (0, 0, math.radians(90)); bpy.ops.object.transform_apply(rotation=True)
else:
    if size[0] > size[1]:
        body.rotation_euler = (0, 0, math.radians(90)); bpy.ops.object.transform_apply(rotation=True)
V = verts_np(body); mn, mx = V.min(0), V.max(0); size = mx - mn

def tri_density_ends(obj):
    """triangle count in the first vs last 22% of the Y range (heads are denser: eyes, teeth, mouth)"""
    me = obj.data; me.calc_loop_triangles()
    Vc = verts_np(obj)
    idx = np.empty(len(me.loop_triangles) * 3, dtype=np.int32); me.loop_triangles.foreach_get("vertices", idx)
    cy = Vc[idx.reshape(-1, 3)][:, :, 1].mean(1)
    y0, y1 = Vc[:, 1].min(), Vc[:, 1].max(); L = y1 - y0
    return int((cy < y0 + 0.22 * L).sum()), int((cy > y1 - 0.22 * L).sum())
neg, pos = tri_density_ends(body)
head_neg = neg >= pos
if CFG.get("flip"): head_neg = not head_neg
log("density -Y:", neg, "+Y:", pos, "→ head at", "-Y" if head_neg else "+Y", "(flip)" if CFG.get("flip") else "")
if not head_neg:
    body.rotation_euler = (0, 0, math.radians(180)); bpy.ops.object.transform_apply(rotation=True)
    V = verts_np(body); mn, mx = V.min(0), V.max(0); size = mx - mn

# scale to real length
L_axis = 0 if KIND == "air" else 1
s = CFG["length"] / size[L_axis]
body.scale = (s, s, s); bpy.ops.object.transform_apply(scale=True)
V = verts_np(body); mn, mx = V.min(0), V.max(0); size = mx - mn
# origin: ground at z=0; XY origin = centre of the lowest 6% of vertices (feet) for land; body centre otherwise
H = size[2]
if KIND == "land":
    low = V[V[:, 2] < mn[2] + 0.06 * H]
    cx, cy = low[:, 0].mean(), low[:, 1].mean()
    off = Vector((-cx, -cy, -mn[2]))
elif KIND == "air":
    off = Vector((-(mn[0] + mx[0]) / 2, -(mn[1] + mx[1]) / 2, -mn[2]))
else:
    off = Vector((-(mn[0] + mx[0]) / 2, -(mn[1] + mx[1]) / 2, -(mn[2] + mx[2]) / 2))
body.data.transform(Matrix.Translation(off))
V = verts_np(body); mn, mx = V.min(0), V.max(0); size = mx - mn; H = size[2]; L = size[1]
log("normalized size", size.round(2), "origin offset", [round(x, 2) for x in off])

# ---------------------------------------------------------------- decimate
ntris = len(body.data.polygons)
if ntris > CFG["tris"]:
    mod = body.modifiers.new("dec", 'DECIMATE'); mod.ratio = CFG["tris"] / ntris; mod.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=mod.name)
body.data.calc_loop_triangles()
log("tris after decimate", len(body.data.loop_triangles))
V = verts_np(body)

# ---------------------------------------------------------------- volumetric analysis (rig v2)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rig_v2 as R2
me = body.data; me.calc_loop_triangles()
TRI = np.empty(len(me.loop_triangles) * 3, np.int32); me.loop_triangles.foreach_get("vertices", TRI); TRI = TRI.reshape(-1, 3)
V = verts_np(body)
VOX = max(L, size[0]) / CFG.get("vox_div", 170)
G, SOLID, SURF = R2.voxelize(V, TRI, VOX)
if SOLID.sum() < 1.6 * SURF.sum():
    log("hollow voxelisation → closing harder")
    G, SOLID, SURF = R2.voxelize(V, TRI, VOX, close=2)
log("voxels", G.shape, "vox", round(VOX, 4), "solid", int(SOLID.sum()), "fill", round(SOLID.sum() / max(1, SURF.sum()), 2))
DT = R2.slice_dt(SOLID)
CURVE, RAD = R2.spine_curve(G, SOLID, DT)
log("spine curve samples", len(CURVE), "y range", round(CURVE[0, 1], 2), round(CURVE[-1, 1], 2))
def rad_at(y): return float(np.interp(y, CURVE[:, 1], RAD))
def sp_at(y): return R2.curve_at(CURVE, y)

y_snout, y_tail = float(mn[1]), float(mx[1])
HEAD_F = CFG.get("head", 0.11); NECK_F = CFG.get("neck", 0.09)
y_hb = y_snout + HEAD_F * L          # head base (skull/neck junction)
y_nb = y_hb + NECK_F * L             # neck base (neck/chest junction)

# ---------------------------------------------------------------- legs (traced through the solid)
leg_defs = []      # dicts: tag, hip, knee, ankle, toe, front
if GAIT in ("biped", "quad"):
    want = 4 if GAIT == "quad" else 2
    kg, feet = R2.find_feet(G, SOLID, mn[2], H)
    feet.sort(key=lambda c: -len(c))
    # merged blobs (two feet touching) → split by x about the blob's median
    cand = []
    for c in feet:
        xs = c[:, 0]
        if len(feet) < want and (xs.max() - xs.min()) * VOX > 0.35 * size[0] and abs(G.pos(np.array([np.median(xs), 0, 0]))[0]) < 0.12 * size[0]:
            med = np.median(xs); cand += [c[xs < med], c[xs >= med]]; log("  split merged foot blob")
        else:
            cand.append(c)
    cand.sort(key=lambda c: -len(c))
    # blobs of the same foot (separate toes) → merge when close together
    merged = []
    for c in cand:
        cpos = c.mean(0)
        for m in merged:
            same_side = np.sign(G.pos(np.array([m["c"].mean(0)[0], 0, 0]))[0] - float(np.median(CURVE[:, 0]))) == np.sign(G.pos(np.array([cpos[0], 0, 0]))[0] - float(np.median(CURVE[:, 0])))
            if same_side and np.linalg.norm(m["c"].mean(0) - cpos) * VOX < 0.09 * L:
                m["c"] = np.vstack([m["c"], c]); break
        else:
            merged.append({"c": c, "k": kg})
    merged.sort(key=lambda m: -len(m["c"])); merged = merged[:want]
    xc_body = float(np.median(CURVE[:, 0]))
    if GAIT == "biped":
        sides = {int(np.sign(G.pos(np.array([m["c"].mean(0)[0], 0, 0]))[0] - xc_body)) for m in merged}
        for side in (-1, 1):
            if side in sides or len(merged) >= 2 and len(sides) == 2: continue
            ref_y = float(G.pos(np.array([0, merged[0]["c"].mean(0)[1], 0]))[1]) if merged else y_snout + 0.55 * L
            k2, c2 = R2.find_raised_foot(G, SOLID, side, xc_body, ref_y - 0.2 * L, ref_y + 0.2 * L, mn[2] + 0.55 * H)
            if c2 is not None:
                merged.append({"c": c2, "k": k2, "raised": True}); log(f"  raised foot found on side {side} at z={G.pos(np.array([0,0,k2]))[2]:.2f}")
        merged = merged[:want]
    log("feet found", len(feet), "→ using", len(merged), [(len(m["c"]), m["k"]) for m in merged])
    k_top = int(G.idx(np.array([0, 0, mn[2] + 0.95 * H]))[2])
    traced = []
    for m in merged:
        P, areas = R2.trace_leg(G, SOLID, m["k"], m["c"], k_top)
        traced.append((m["c"], P, m["k"], m.get("raised", False)))
    ys_tops = [P[-1][1] for _, P, _, _ in traced]
    order = np.argsort(ys_tops)
    front_ids = set(order[:2].tolist()) if (GAIT == "quad" and len(traced) == 4) else set()
    for i, (c, P, kfoot, raised) in enumerate(traced):
        front = i in front_ids
        foot_z = float(G.pos(np.array([0, 0, kfoot]))[2]) - (0 if kfoot == kg else 0.0)
        ground = mn[2] if kfoot == kg else foot_z - 1.5 * VOX
        top = P[-1]
        y_leg = float(np.mean(P[-max(2, len(P) // 4):, 1]))
        spz = sp_at(y_leg)[2]; rr = rad_at(y_leg)
        hip = np.array([top[0] * 0.8, y_leg, max(top[2] + 0.03 * H, spz - 0.38 * rr)])
        ankle, knee = R2.fit_leg(P, hip, ground)
        # anatomical sanity: hind knees point forward (−Y), front elbows backward (+Y)
        AB = ankle - hip; t = np.clip(((knee - hip) @ AB) / (AB @ AB), 0, 1); off = knee - (hip + t * AB)
        legH = hip[2] - ground
        if not front and off[1] > 0.01 * legH: knee = hip + t * AB + np.array([0, -0.05 * legH, 0]); log("  knee flipped forward")
        if front and off[1] < -0.01 * legH: knee = hip + t * AB + np.array([0, 0.04 * legH, 0]); log("  elbow flipped backward")
        ball, toe = R2.toe_tip(G, SOLID, kfoot, c, ankle, hip[2] - ground, ground)
        if toe is None or toe[1] > ankle[1] - 0.02 * legH:
            toe = np.array([ankle[0], ankle[1] - 0.12 * legH, ground + 0.4 * VOX])
            ball = np.array([ankle[0], ankle[1] - 0.05 * legH, ground + 0.4 * VOX])
        side = "L" if top[0] < 0 else "R"
        tag = (("F" if front else "B") + side) if GAIT == "quad" else side
        leg_defs.append(dict(tag=tag, hip=hip, knee=knee, ankle=ankle, ball=ball, toe=toe, front=front, P=P, raised=raised))
        log(f"  leg {tag}: hip {np.round(hip,2)} knee {np.round(knee,2)} ankle {np.round(ankle,2)} ball {np.round(ball,2)} toe {np.round(toe,2)} traced {len(P)} slices")
    # one pelvis / one shoulder girdle: hips of a girdle share y and z, and sit symmetric in x
    for grp in ([d for d in leg_defs if d["front"]], [d for d in leg_defs if not d["front"]]):
        if len(grp) < 2: continue
        yh = float(np.mean([d["hip"][1] for d in grp])); zh = float(np.mean([d["hip"][2] for d in grp]))
        xh = max(float(np.mean([abs(d["hip"][0]) for d in grp])), 0.12 * size[0])
        xc = float(sp_at(yh)[0])
        for d in grp:
            old_hip = d["hip"].copy()
            d["hip"] = np.array([xc + (xh if d["hip"][0] > xc else -xh), yh, zh])
            # keep the fitted knee/ankle; re-check the knee sits between hip and ankle in height
            if d["knee"][2] > d["hip"][2] - 0.05 * (d["hip"][2] - mn[2]):
                d["knee"] = d["hip"] + (d["ankle"] - d["hip"]) * 0.5 + np.array([0, -0.04 * (d["hip"][2] - mn[2]), 0])
    tags = [d["tag"] for d in leg_defs]
    if len(set(tags)) != len(tags):   # duplicate sides (asymmetric pose) → re-tag by x order
        for grp in ([d for d in leg_defs if d["front"]], [d for d in leg_defs if not d["front"]]):
            grp.sort(key=lambda d: d["hip"][0])
            for k, d in enumerate(grp): d["tag"] = (("F" if d["front"] else "B") if GAIT == "quad" else "") + ("L" if k == 0 else "R")
y_hip = float(np.mean([d["hip"][1] for d in leg_defs if not d["front"]])) if leg_defs else y_snout + CFG.get("hip", 0.6) * L
y_sh = float(np.mean([d["hip"][1] for d in leg_defs if d["front"]])) if any(d["front"] for d in leg_defs) else None
y_nb = min(y_nb, y_hip - 0.12 * L)
if y_sh is not None: y_nb = min(y_nb, y_sh - 0.02 * L)
log("landmarks y: snout", round(y_snout, 2), "head base", round(y_hb, 2), "neck base", round(y_nb, 2), "hip", round(y_hip, 2), "tail", round(y_tail, 2))

# ---------------------------------------------------------------- armature
arm_data = bpy.data.armatures.new("Armature"); arm = bpy.data.objects.new("Armature", arm_data)
sc.collection.objects.link(arm); bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
EB = arm_data.edit_bones
def add_bone(name, head, tail, parent=None, connect=False, deform=True):
    b = EB.new(name); b.head = Vector(tuple(head)); b.tail = Vector(tuple(tail)); b.roll = 0.0; b.use_deform = deform
    if parent is not None: b.parent = parent; b.use_connect = connect
    return b
n_torso = 3
n_neck = int(np.clip(round(NECK_F / 0.06), 2, 6))
n_tail = CFG.get("tail_bones", 7)
p_root = sp_at(y_hip)
root = add_bone("root", p_root, sp_at(y_hip - 0.05 * L))
SP = R2.curve_between(CURVE, y_hip - 0.05 * L, y_nb, n_torso)
tor = []; prev = root
for i in range(n_torso):
    bn = add_bone(f"spine{i+1}", SP[i], SP[i + 1], prev, connect=True); tor.append(bn); prev = bn
NK = R2.curve_between(CURVE, y_nb, y_hb, n_neck)
neck = []
for i in range(n_neck):
    bn = add_bone(f"neck{i+1}", NK[i], NK[i + 1], prev, connect=True); neck.append(bn); prev = bn
snout_tip = sp_at(max(y_snout + 0.01 * L, CURVE[0, 1])); snout_tip[1] = y_snout
head_b = add_bone("head", NK[-1], snout_tip, prev, connect=True)
add_bone("snout", snout_tip, snout_tip + np.array([0, -0.02 * L, 0]), head_b, connect=True, deform=False)
headL = y_hb - y_snout
y_hinge = y_snout + CFG.get("jaw", 0.8) * headL
MY, MZ, gapfrac = R2.mouth_line(G, SOLID, CURVE, y_hinge, y_snout + 0.02 * headL, CFG.get("jaw_h", 0.4))
log("mouth line samples", len(MY), "open-mouth fraction", round(float(gapfrac), 2))
def mouth_z(y): return float(np.interp(y, MY[::-1] if MY[0] > MY[-1] else MY, MZ[::-1] if MY[0] > MY[-1] else MZ)) if len(MY) else sp_at(y)[2] - 0.2 * rad_at(y)
jaw_hinge = np.array([sp_at(y_hinge)[0], y_hinge, mouth_z(y_hinge)])
jaw_tip = np.array([snout_tip[0], y_snout + 0.05 * headL, mouth_z(y_snout + 0.05 * headL) - 0.04 * headL])
jaw = add_bone("jaw", jaw_hinge, jaw_tip, head_b)
TL = R2.curve_between(CURVE, y_hip, y_tail, n_tail)
tail = []; prev = root
for i in range(n_tail):
    bn = add_bone(f"tail{i+1}", TL[i], TL[i + 1], prev, connect=False if i == 0 else True); tail.append(bn); prev = bn
leg_bones = []
for d in leg_defs:
    par = tor[-1] if d["front"] else root
    tg = d["tag"]
    u = add_bone(f"thigh.{tg}", d["hip"], d["knee"], par)
    lo = add_bone(f"shin.{tg}", d["knee"], d["ankle"], u, connect=True)
    ft = add_bone(f"foot.{tg}", d["ankle"], d["ball"], lo, connect=True)
    tz = add_bone(f"toes.{tg}", d["ball"], d["toe"], ft, connect=True)
    add_bone(f"toe.{tg}", d["toe"], d["toe"] + np.array([0, -0.04 * (d["hip"][2] - mn[2]), 0]), tz, connect=True, deform=False)
    leg_bones.append((tg, u.name, lo.name, ft.name, d))
wing_bones = []
if KIND == "air":
    span = SOLID.any(axis=2).sum(axis=0)          # x-extent per y slice
    j_sh = int(np.argmax(span)); y_w = float(G.pos(np.array([0, j_sh, 0]))[1])
    c = sp_at(y_w)
    for side, sgn in (("L", -1), ("R", 1)):
        sh = np.array([sgn * 0.06 * size[0], y_w, c[2]])
        mid = np.array([sgn * 0.42 * size[0], y_w + 0.03 * size[1], c[2]])
        tip = np.array([sgn * 0.5 * size[0], y_w + 0.06 * size[1], c[2]])
        w1 = add_bone(f"wing1.{side}", sh, mid, tor[-1]); w2 = add_bone(f"wing2.{side}", mid, tip, w1, connect=True)
        wing_bones.append((side, w1.name, w2.name))
flip_bones = []
if KIND == "water":
    width = SOLID.any(axis=2).sum(axis=0) * VOX
    for name, yy in (("F", y_nb + 0.06 * L), ("B", y_hip + 0.02 * L)):
        j = int(G.idx(np.array([0, yy, 0]))[1]); lo_j, hi_j = max(0, j - int(0.08 * L / VOX)), j + int(0.08 * L / VOX)
        jj = lo_j + int(np.argmax(width[lo_j:hi_j])); yy = float(G.pos(np.array([0, jj, 0]))[1])
        sl = V[(V[:, 1] > yy - 0.05 * L) & (V[:, 1] < yy + 0.05 * L)]
        for side, sgn in (("L", -1), ("R", 1)):
            xr = sl[:, 0].min() if sgn < 0 else sl[:, 0].max()
            if abs(xr) < 0.12 * L: continue
            base = np.array([sgn * 0.25 * abs(xr), yy, sp_at(yy)[2] - 0.3 * rad_at(yy)])
            tip = np.array([xr, yy + 0.06 * L, sp_at(yy)[2] - 0.5 * rad_at(yy)])
            fb = add_bone(f"flip{name}.{side}", base, tip, tor[-1] if name == "F" else tor[0]); flip_bones.append((name, side, fb.name))
bpy.ops.object.mode_set(mode='OBJECT')
log("bones", len(arm_data.bones), "neck", n_neck, "tail", n_tail, "legs", [d["tag"] for d in leg_defs])

# ---------------------------------------------------------------- skin weights (geodesic through the solid)
# leg bones are seeded only from the part of the limb that sticks out of the body (below where the
# traced leg merged into the torso), so the torso around buried hips/shoulders stays on the spine
leg_top = {d["tag"]: float(d["P"][-1][2]) for d in leg_defs}
def seed_zmax(name):
    if "." not in name: return None
    kind, tag = name.split(".", 1)
    if kind in ("thigh", "shin") and tag in leg_top: return leg_top[tag] + 0.5 * VOX
    return None
def blend_mul(name):
    return 2.0 if name.startswith("thigh.") else 1.3 if name.startswith("shin.") else 1.0
SKIN = [(b.name, np.array(b.head_local), np.array(b.tail_local), seed_zmax(b.name), blend_mul(b.name)) for b in arm_data.bones if b.use_deform and b.name != "jaw"]
t_w = time.time()
names, Wt = R2.skin_weights(G, SOLID, V, SKIN, blend_vox=CFG.get("blend", 0.028) * L / VOX, max_steps=int(0.7 * max(G.shape)))
log("geodesic weights", round(time.time() - t_w, 1), "s")
# jaw: everything below the mouth line, in front of the hinge, belongs to the jaw
hi_idx = names.index("head")
yv, zv = V[:, 1], V[:, 2]
mz = np.array([mouth_z(y) for y in np.clip(yv, y_snout, y_hinge)])
below = np.clip((mz - zv) / (1.2 * VOX) + 0.5, 0, 1)
front = np.clip((y_hinge - yv) / (0.12 * headL), 0, 1)
s_jaw = below * front * (yv < y_hinge + 0.02 * headL)
jaw_w = Wt[:, hi_idx] * s_jaw
Wt[:, hi_idx] -= jaw_w
names.append("jaw"); Wt = np.hstack([Wt, jaw_w[:, None]])
log("jaw vertices", int((jaw_w > 0.5).sum()))
for nm in names: body.vertex_groups.new(name=nm)
vg = [body.vertex_groups[nm] for nm in names]
for bi in range(len(names)):
    nz = np.nonzero(Wt[:, bi] > 0.003)[0]
    g_ = vg[bi]
    for i in nz: g_.add([int(i)], float(Wt[i, bi]), 'REPLACE')
body.parent = arm
mod = body.modifiers.new("Armature", 'ARMATURE'); mod.object = arm
bpy.context.view_layer.objects.active = body
bpy.ops.object.select_all(action='DESELECT'); body.select_set(True)
try:
    bpy.ops.object.mode_set(mode='WEIGHT_PAINT')
    bpy.ops.object.vertex_group_smooth(group_select_mode='ALL', factor=0.5, repeat=2, expand=0.0)
    bpy.ops.object.mode_set(mode='OBJECT')
except Exception as e:
    bpy.ops.object.mode_set(mode='OBJECT'); log("smooth failed", e)
bpy.ops.object.vertex_group_normalize_all(lock_active=False)
bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
bpy.ops.object.vertex_group_normalize_all(lock_active=False)
H_ = H

# ---------------------------------------------------------------- re-pose a lifted leg (posed models)
# A leg that was lifted in the source pose (e.g. a foot up on a rock) is rotated, joint by joint, into
# the mirror image of its standing partner, and that pose is baked into mesh + skeleton as the new rest.
raised_legs = [d for d in leg_defs if d.get("raised")]
if raised_legs:
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.select_all(action='DESELECT'); arm.select_set(True)
    bpy.ops.object.mode_set(mode='POSE')
    for r in raised_legs:
        mates = [g for g in leg_defs if not g.get("raised") and g["front"] == r["front"]]
        if not mates: continue
        g = mates[0]
        xm = (r["hip"][0] + g["hip"][0]) / 2
        mirror = lambda p: Vector((2 * xm - p[0], p[1], p[2]))
        for bn, tgt in ((f"thigh.{r['tag']}", g["knee"]), (f"shin.{r['tag']}", g["ankle"]), (f"foot.{r['tag']}", g["ball"]), (f"toes.{r['tag']}", g["toe"])):
            bpy.context.view_layer.update()
            pb = arm.pose.bones[bn]
            head, tail = pb.head.copy(), pb.tail.copy()
            q = (tail - head).rotation_difference(mirror(tgt) - head)
            pb.matrix = Matrix.Translation(head) @ q.to_matrix().to_4x4() @ Matrix.Translation(-head) @ pb.matrix
        log(f"  re-posed lifted leg {r['tag']} to mirror {g['tag']}")
    bpy.context.view_layer.update()
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.select_all(action='DESELECT'); body.select_set(True)
    bpy.ops.object.modifier_apply(modifier="Armature")
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.select_all(action='DESELECT'); arm.select_set(True)
    bpy.ops.object.mode_set(mode='POSE'); bpy.ops.pose.select_all(action='SELECT'); bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    mod = body.modifiers.new("Armature", 'ARMATURE'); mod.object = arm
    V = verts_np(body); mn, mx = V.min(0), V.max(0)

# ---------------------------------------------------------------- animation
bpy.context.view_layer.objects.active = arm
bpy.ops.object.select_all(action='DESELECT'); arm.select_set(True)
bpy.ops.object.mode_set(mode='POSE')
PB = arm.pose.bones
for pb in PB: pb.rotation_mode = 'XYZ'
arm.animation_data_create()

def rot_world(pb, axis, deg):
    """set pose rotation so the bone rotates `deg` degrees about a WORLD axis ('X','Y','Z')."""
    ax = {'X': Vector((1, 0, 0)), 'Y': Vector((0, 1, 0)), 'Z': Vector((0, 0, 1))}[axis]
    q_world = Quaternion(ax, math.radians(deg))
    # bone rest matrix (armature space)
    Mb = pb.bone.matrix_local.to_3x3()
    q_local = (Mb.inverted() @ q_world.to_matrix() @ Mb).to_quaternion()
    pb.rotation_mode = 'QUATERNION'
    pb.rotation_quaternion = (pb.rotation_quaternion.to_matrix() @ q_local.to_matrix()).to_quaternion()

def reset_pose():
    for pb in PB:
        pb.rotation_mode = 'QUATERNION'; pb.rotation_quaternion = (1, 0, 0, 0); pb.location = (0, 0, 0); pb.scale = (1, 1, 1)

def key_all(frame):
    for pb in PB:
        pb.keyframe_insert("rotation_quaternion", frame=frame)
        if pb.name == "root": pb.keyframe_insert("location", frame=frame)

CLIPS = {}
def make_clip(name, seconds, fn, loop=True):
    act = bpy.data.actions.new(name)
    arm.animation_data.action = act
    try:
        if hasattr(act, "slots"):
            slot = act.slots.new('OBJECT', arm.name) if len(act.slots) == 0 else act.slots[0]
            arm.animation_data.action_slot = slot
    except Exception as e: log("slot", e)
    nfr = int(round(seconds * FPS))
    step = 2
    for f in range(0, nfr + 1, step):
        t = f / nfr  # 0..1
        reset_pose(); fn(t, f / FPS); key_all(f + 1)
    if loop:
        reset_pose(); fn(0.0, 0.0); key_all(nfr + 1)
    def _fcurves(a):
        if hasattr(a, "fcurves"): return list(a.fcurves)
        out = []
        for layer in a.layers:
            for strip in layer.strips:
                for cb in strip.channelbags: out.extend(cb.fcurves)
        return out
    for fc in _fcurves(act):
        for kp in fc.keyframe_points: kp.interpolation = 'BEZIER'; kp.easing = 'AUTO'
    CLIPS[name] = (act, nfr + 1)
    arm.animation_data.action = None
    return act

def S(t, ph=0.0): return math.sin(2 * math.pi * (t + ph))
def ease(x): x = min(max(x, 0), 1); return x * x * (3 - 2 * x)
def pulse(t, a, b):  # 0→1→0 between a..b
    if t < a or t > b: return 0.0
    u = (t - a) / (b - a); return math.sin(math.pi * u)

tails = [PB[f"tail{i+1}"] for i in range(n_tail)]
necks = [PB[f"neck{i+1}"] for i in range(n_neck)]
spines = [PB[f"spine{i+1}"] for i in range(n_torso)]
head = PB["head"]; jawb = PB["jaw"]; rootb = PB["root"]
legsP = {tag: (PB[u], PB[lo], PB[ft]) for tag, u, lo, ft, _ in leg_bones}
big = CFG["length"] > 7.0
amp = CFG.get("amp", 0.75 if big else 1.0)

def tail_sway(t, deg, ph=0.0, freq=1.0):
    for i, tb in enumerate(tails):
        rot_world(tb, 'Z', deg * S(freq * t, ph - 0.12 * i) * (0.5 + 0.5 * i / max(1, n_tail - 1)))

def breathe(t, k=1.0):
    for sb in spines: rot_world(sb, 'X', 0.8 * k * S(t))
    for nb in necks: rot_world(nb, 'X', -1.2 * k * S(t, 0.1))
    rot_world(head, 'X', 2.0 * k * S(t, 0.2))

def idle(t, s):
    breathe(t); tail_sway(t, 5 * amp, 0.0, 1.0)
    rot_world(head, 'Z', 4 * S(t * 0.5 + 0.25))
    rootb.location.z = 0.004 * H * S(t)

def walk(t, s):
    # stride: 1 cycle per clip
    bob = (0.007 if big else 0.012) * H * (0.5 - 0.5 * math.cos(4 * math.pi * t))
    rootb.location.z = bob
    tail_sway(t, 9 * amp, 0.25, 1.0)
    for sb in spines: rot_world(sb, 'Z', 1.5 * S(t))
    rot_world(head, 'X', 3 * S(2 * t)); rot_world(head, 'Z', -2 * S(t))
    for nb in necks: rot_world(nb, 'Z', -1.5 * S(t))
    for tag, (u, lo, ft) in legsP.items():
        if GAIT == "quad":
            ph = 0.0 if tag[:2] in ("FL", "BR") else 0.5
        else:
            ph = 0.0 if tag[0] == "L" else 0.5
        sw = S(t, ph)                      # +: leg forward (toward -Y) → rotate about world X negative
        rot_world(u, 'X', -30 * amp * sw)
        lift = max(0.0, S(t, ph + 0.25))   # swing phase: knee folds, foot lifts
        rot_world(lo, 'X', 30 * amp * lift ** 1.5 + 3 * amp * sw)
        rot_world(ft, 'X', -14 * amp * lift + 6 * amp * max(0.0, -S(t, ph + 0.25)))
    rot_world(rootb, 'Z', 1.2 * S(t))     # hip yaw
    for sb in spines: rot_world(sb, 'X', 0.6)   # slight forward lean while walking

def roar(t, s):
    k = ease(t / 0.25) * (1 - ease((t - 0.75) / 0.25))
    for nb in necks: rot_world(nb, 'X', -8 * k)
    rot_world(head, 'X', -16 * k + 2.5 * k * S(6 * t))
    rot_world(jawb, 'X', 24 * k + 2 * k * S(8 * t))
    for sb in spines: rot_world(sb, 'X', -3 * k)
    tail_sway(t, 7 * amp, 0.0, 2.0)
    rootb.location.z = -0.01 * H * k

EAT_REACH = None
EAT_K = 1.0   # pitch multiplier solved below so the snout reaches the food
def eat_pose(k):
    for nb in necks: rot_world(nb, 'X', EAT_K * 22 * k)
    rot_world(head, 'X', EAT_K * 12 * k)
    for sb in spines: rot_world(sb, 'X', EAT_K * 6 * k)
def eat(t, s):
    k = ease(t / 0.3) * (1 - ease((t - 0.7) / 0.3))
    eat_pose(k)
    chew = max(0.0, S(4 * t)) * (1 if 0.3 < t < 0.7 else 0)
    rot_world(jawb, 'X', 10 * chew)
    tail_sway(t, 4 * amp, 0.0, 1.0)
def solve_eat_reach(target_z):
    """scan the pitch multiplier upward until the snout reaches the target height (monotonic region only)"""
    global EAT_K
    best = None
    k = 0.2
    while k <= 3.0:
        EAT_K = k; reset_pose(); eat_pose(1.0); bpy.context.view_layer.update()
        z = (arm.matrix_world @ PB["snout"].head).z
        if best is None or z < best[1]: best = (k, z)
        if z <= target_z: best = (k, z); break
        k += 0.1
    EAT_K = best[0]
    global EAT_REACH
    reset_pose(); eat_pose(1.0); bpy.context.view_layer.update()
    sn = arm.matrix_world @ PB["snout"].head; EAT_REACH = (float(-sn.y), float(sn.z))
    reset_pose(); bpy.context.view_layer.update()
    log("eat reach: EAT_K", round(EAT_K, 2), "snout z at full pose", round(best[1], 2))
if KIND == "land": solve_eat_reach(0.35 + 0.02 * H)

def fly(t, s):
    for side, w1, w2 in wing_bones:
        sgn = -1 if side == "L" else 1
        flap = 22 * S(t)
        rot_world(PB[w1], 'Y', sgn * flap)
        rot_world(PB[w2], 'Y', sgn * 12 * S(t, -0.12))
    rootb.location.z = 0.03 * H * S(t, -0.2)
    rot_world(head, 'X', 3 * S(t)); tail_sway(t, 3, 0, 1.0)

def glide(t, s):
    for side, w1, w2 in wing_bones:
        sgn = -1 if side == "L" else 1
        rot_world(PB[w1], 'Y', sgn * 4 * S(t)); rot_world(PB[w2], 'Y', sgn * 5 * S(t, -0.1))
    rootb.location.z = 0.01 * H * S(t)

def swim(t, s):
    for i, sb in enumerate(spines): rot_world(sb, 'Z', 3 * S(t, -0.08 * i))
    for i, tb in enumerate(tails): rot_world(tb, 'Z', 7 * S(t, -0.12 * (i + 3)) * (0.4 + 0.6 * i / max(1, n_tail - 1)))
    for i, nb in enumerate(necks): rot_world(nb, 'Z', 2 * S(t, 0.1 * i))
    rot_world(head, 'Z', 3 * S(t, 0.2))
    for name, side, fb in flip_bones:
        sgn = -1 if side == "L" else 1
        rot_world(PB[fb], 'Y', sgn * 16 * S(t, 0.0 if name == "F" else 0.5))
    rootb.location.z = 0.01 * H * S(t)

def swim_idle(t, s):
    for i, tb in enumerate(tails): rot_world(tb, 'Z', 3 * S(0.5 * t, -0.12 * i))
    for name, side, fb in flip_bones:
        sgn = -1 if side == "L" else 1
        rot_world(PB[fb], 'Y', sgn * 6 * S(0.5 * t, 0.0 if name == "F" else 0.5))
    rootb.location.z = 0.01 * H * S(0.5 * t)

if KIND == "land":
    make_clip("idle", 3.0, idle); make_clip("walk", 0.9 if CFG["length"] < 4 else (1.3 if not big else 1.8), walk)
    make_clip("roar", 2.2, roar, loop=False); make_clip("eat", 3.2, eat, loop=False)
elif KIND == "air":
    make_clip("idle", 2.4, glide); make_clip("fly", 1.0, fly); make_clip("roar", 2.0, roar, loop=False)
else:
    make_clip("idle", 4.0, swim_idle); make_clip("swim", 2.0, swim); make_clip("roar", 2.0, roar, loop=False)
# measure the walk clip: foot excursion along Y → stride per cycle; then re-time the clip so that
# stride / duration equals the species' intended walking speed (no foot sliding at timeScale 1)
STRIDE = None
def measure_stride():
    act, nfr = CLIPS["walk"]
    arm.animation_data.action = act
    try: arm.animation_data.action_slot = act.slots[0]
    except Exception: pass
    ys = {ft: [] for _, _, _, ft, _ in leg_bones}
    for f in range(1, nfr + 1):
        sc.frame_set(f)
        for _, _, _, ft, _ in leg_bones:
            ys[ft].append((arm.matrix_world @ PB[ft].tail).y)
    arm.animation_data.action = None
    return 2.0 * max(max(v) - min(v) for v in ys.values())   # two stance phases per cycle
if "walk" in CLIPS and leg_bones:
    STRIDE = measure_stride()
    T = min(3.2, max(0.5, STRIDE / CFG.get("walk_speed", 1.0)))
    act, nfr = CLIPS.pop("walk"); bpy.data.actions.remove(act)
    make_clip("walk", T, walk)
    STRIDE = measure_stride()
    log("walk stride/cycle", round(STRIDE, 3), "m, clip", round(T, 2), "s → speed", round(STRIDE / T, 3), "m/s")
bpy.ops.object.mode_set(mode='OBJECT')

# push every clip into the NLA so the glTF exporter picks them all up
ad = arm.animation_data
for name, (act, nfr) in CLIPS.items():
    tr = ad.nla_tracks.new(); tr.name = name
    strip = tr.strips.new(name, 1, act)
    try:
        if hasattr(strip, "action_slot") and len(act.slots): strip.action_slot = act.slots[0]
    except Exception as e: log("strip slot", e)
    tr.mute = True
ad.action = None
log("clips", {k: v[1] for k, v in CLIPS.items()})

# ---------------------------------------------------------------- materials sanity (make sure alpha-less, double-sided off)
for m in bpy.data.materials:
    if m.use_nodes:
        # scanned/sculpted Sketchfab meshes often carry flipped faces: render both sides
        m.use_backface_culling = False
        transparent = any(k in m.name.lower() for k in ("cornea", "transparent"))
        for n in m.node_tree.nodes:
            if n.type == 'BSDF_PRINCIPLED' and not transparent:
                al = n.inputs['Alpha']
                for l in list(al.links): m.node_tree.links.remove(l)
                al.default_value = 1.0
        if not transparent:
            m.surface_render_method = 'DITHERED'
            try: m.blend_method = 'OPAQUE'
            except Exception: pass
        # no dinosaur is metallic; broken metallic maps render as black patches without an environment
        for n in m.node_tree.nodes:
            if n.type == 'BSDF_PRINCIPLED':
                mi = n.inputs['Metallic']
                for l in list(mi.links): m.node_tree.links.remove(l)
                mi.default_value = 0.0
        if getattr(m, "surface_render_method", None) == 'BLENDED' and m.name not in ("eyeTransparentColor", "cornea"):
            m.surface_render_method = 'DITHERED'

# ---------------------------------------------------------------- export
os.makedirs(OUT_DIR, exist_ok=True)
out = os.path.join(OUT_DIR, f"{SPECIES_ID}.glb")
bpy.ops.object.select_all(action='DESELECT'); body.select_set(True); arm.select_set(True)
kw = dict(filepath=out, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
          export_animations=True, export_skins=True, export_texcoords=True, export_normals=True,
          export_materials='EXPORT', export_image_format='WEBP', export_image_quality=85,
          export_draco_mesh_compression_enable=False, export_optimize_animation_size=True,
          export_force_sampling=True, export_frame_range=False, export_nla_strips=True,
          export_animation_mode='NLA_TRACKS', export_rest_position_armature=True, export_morph=False)
try:
    bpy.ops.export_scene.gltf(**kw)
except TypeError as e:
    log("export kw fallback", e)
    for k in ("export_animation_mode", "export_image_quality", "export_rest_position_armature", "export_nla_strips", "export_optimize_animation_size"):
        kw.pop(k, None)
    bpy.ops.export_scene.gltf(**kw)
log("exported", out, round(os.path.getsize(out) / 1e6, 2), "MB")

# save .blend for inspection
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT_DIR, f"{SPECIES_ID}.blend"))

# ---------------------------------------------------------------- preview renders
if PREVIEW:
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'GPU'; sc.cycles.samples = 24; sc.cycles.use_denoising = True
    prefs = bpy.context.preferences.addons['cycles'].preferences; prefs.compute_device_type = 'OPTIX'; prefs.refresh_devices()
    for d in prefs.devices: d.use = (d.type == 'OPTIX')
    sc.render.resolution_x = 480; sc.render.resolution_y = 360
    w = bpy.data.worlds.new("W"); sc.world = w; w.use_nodes = True
    bg = w.node_tree.nodes["Background"]; bg.inputs[0].default_value = (0.6, 0.7, 0.85, 1); bg.inputs[1].default_value = 0.7
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", 'SUN')); sc.collection.objects.link(sun)
    sun.data.energy = 4; sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(35))
    cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam")); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.lens = 40
    center = Vector(((mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2)); R = Vector(size).length / 2
    D = R * 2.4; a = math.radians(-120); e = math.radians(15)
    pos = center + Vector((math.cos(a) * math.cos(e) * D, math.sin(a) * math.cos(e) * D, math.sin(e) * D))
    cam.location = pos; cam.rotation_euler = (center - pos).to_track_quat('-Z', 'Y').to_euler()
    cam.data.clip_end = D * 10
    # ground plane
    bpy.ops.mesh.primitive_plane_add(size=CFG["length"] * 6, location=(0, 0, 0 if KIND != "water" else mn[2]))
    pl = bpy.context.active_object; pm = bpy.data.materials.new("ground"); pm.use_nodes = True
    pm.node_tree.nodes["Principled BSDF"].inputs[0].default_value = (0.25, 0.3, 0.15, 1); pl.data.materials.append(pm)
    def place(az_deg, el_deg):
        a = math.radians(az_deg); e = math.radians(el_deg)
        p = center + Vector((math.cos(a) * math.cos(e) * D, math.sin(a) * math.cos(e) * D, math.sin(e) * D))
        cam.location = p; cam.rotation_euler = (center - p).to_track_quat('-Z', 'Y').to_euler()
    for tr in ad.nla_tracks: tr.mute = (tr.name != "idle")
    sc.frame_set(1); place(-80, 8); cam.location = center + (cam.location - center) * 0.55
    sc.render.filepath = os.path.join(OUT_DIR, f"{SPECIES_ID}_front_0.png"); bpy.ops.render.render(write_still=True)
    for name, (act, nfr) in CLIPS.items():
        for tr in ad.nla_tracks: tr.mute = (tr.name != name)
        views = [(-120, 15)] + ([(180, 5)] if name in ("walk", "fly", "swim") else [])
        for vi, (az, el) in enumerate(views):
            place(az, el)
            for k in range(4):
                sc.frame_set(1 + int((nfr - 1) * k / 4))
                sc.render.filepath = os.path.join(OUT_DIR, f"{SPECIES_ID}_{name}{'_side' if vi else ''}_{k}.png"); bpy.ops.render.render(write_still=True)
    # bone overlay view: render with wireframe-ish? just dump bone positions
    log("preview done")

json.dump(dict(species=SPECIES_ID, log=LOG, size=[float(x) for x in size], clips={k: v[1] for k, v in CLIPS.items()},
               snout=float(-mn[1]), headZ=float(arm_data.bones["head"].tail_local.z) if "head" in arm_data.bones else None,
               eatReach=EAT_REACH,
               stride=STRIDE, walkSeconds=((CLIPS["walk"][1] - 1) / FPS) if "walk" in CLIPS else None,
               bones=[b.name for b in arm_data.bones]), open(os.path.join(OUT_DIR, f"{SPECIES_ID}.json"), "w"), indent=1)
log("total", round(time.time() - t0, 1), "s")
