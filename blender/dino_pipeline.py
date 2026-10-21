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
    "trex":              dict(length=12.0, walk_speed=1.3, kind="land", gait="biped",  tris=48000, remove=[]),
    "triceratops":       dict(length=8.5, walk_speed=1.2,  kind="land", gait="quad",   tris=45000, remove=["Object_14"], fix_normals=True, clear_normals=True),
    "stegosaurus":       dict(length=8.0, walk_speed=0.9,  kind="land", gait="quad",   tris=40000, remove=[]),
    "paluxysaurus":      dict(length=20.0, walk_speed=1.0, amp=0.4, kind="land", gait="quad",   tris=50000, remove=[]),
    "velociraptor":      dict(length=2.6, walk_speed=1.2, amp=1.3,  kind="land", gait="biped",  tris=30000, remove=[]),
    "sauropelta":        dict(length=5.5, walk_speed=0.8,  kind="land", gait="quad",   tris=40000, remove=[]),
    "ankylosaurus":      dict(length=7.0, walk_speed=0.8, amp=0.6,  kind="land", gait="quad",   tris=40000, remove=[], no_smooth=True),
    "iguanodon":         dict(length=9.0, walk_speed=1.0,  kind="land", gait="quad",   tris=40000, remove=["Object_4"]),
    "ornithocheirus":    dict(length=5.0,  kind="air",  gait="wing",   tris=30000, remove=[]),
    "spinosaurus":       dict(length=14.0, walk_speed=1.1, kind="land", gait="biped",  tris=50000, remove=[]),
    "carnotaurus":       dict(length=8.0, walk_speed=1.4,  kind="land", gait="biped",  tris=40000, remove=["Object_11", "Object_4"]),
    "allosaurus":        dict(length=9.0, walk_speed=1.3,  kind="land", gait="biped",  tris=40000, remove=["Object_6", "Object_8"]),
    "pachycephalosaurus":dict(length=4.5, walk_speed=1.2, amp=1.15,  kind="land", gait="biped",  tris=35000, remove=[]),
    "pistosaurus":       dict(length=3.5,  kind="water",gait="swim",   tris=20000, remove=[]),
    "mosasaurus":        dict(length=13.0, kind="water",gait="swim",   tris=35000, remove=[]),
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
        junk = (o.name in CFG["remove"]) or (o.name.startswith("Icosphere") and len(o.data.materials) == 0) or len(o.data.polygons) < 3
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

# ---------------------------------------------------------------- analyse body: spine curve
NS = 40
ys = np.linspace(mn[1], mx[1], NS + 1)
spine = []  # (y, x, z) along +Y from head(-Y) to tail(+Y)
for i in range(NS):
    m = (V[:, 1] >= ys[i]) & (V[:, 1] < ys[i + 1] + (1e-6 if i == NS - 1 else 0))
    if m.sum() < 5:
        spine.append(None); continue
    sl = V[m]
    # vertical centre of the slice: midpoint between the 15th and 85th percentile of z — robust to legs
    z = 0.5 * (np.percentile(sl[:, 2], 20) + np.percentile(sl[:, 2], 90))
    x = np.median(sl[:, 0])
    spine.append((0.5 * (ys[i] + ys[i + 1]), x, z))
# fill gaps + smooth
last = None
for i in range(NS):
    if spine[i] is None: spine[i] = last if last else (0.5 * (ys[i] + ys[i + 1]), 0.0, H * 0.5)
    last = spine[i]
sp = np.array(spine)
for _ in range(2):
    sp[1:-1, 1:] = 0.25 * sp[:-2, 1:] + 0.5 * sp[1:-1, 1:] + 0.25 * sp[2:, 1:]

# ---------------------------------------------------------------- analyse legs (clusters of low vertices)
def find_legs_at(frac):
    zcut = mn[2] + frac * H
    low = V[V[:, 2] < zcut]
    if len(low) < 50: return []
    cell = max(L, size[0]) / 70.0
    gx = np.floor((low[:, 0] - mn[0]) / cell).astype(int); gy = np.floor((low[:, 1] - mn[1]) / cell).astype(int)
    W_, Hh = gx.max() + 1, gy.max() + 1
    occ = np.zeros((W_ + 2, Hh + 2), dtype=np.int32); np.add.at(occ, (gx + 1, gy + 1), 1)
    occ = occ > 0
    d = occ.copy()
    d[1:, :] |= occ[:-1, :]; d[:-1, :] |= occ[1:, :]; d[:, 1:] |= occ[:, :-1]; d[:, :-1] |= occ[:, 1:]
    lab = np.zeros_like(d, dtype=np.int32); nl = 0; stack = []
    for i in range(d.shape[0]):
        for j in range(d.shape[1]):
            if d[i, j] and lab[i, j] == 0:
                nl += 1; lab[i, j] = nl; stack.append((i, j))
                while stack:
                    a, b = stack.pop()
                    for da, db in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        na, nb = a + da, b + db
                        if 0 <= na < d.shape[0] and 0 <= nb < d.shape[1] and d[na, nb] and lab[na, nb] == 0:
                            lab[na, nb] = nl; stack.append((na, nb))
    vl = lab[gx + 1, gy + 1]
    legs = []
    for k in range(1, nl + 1):
        pts = low[vl == k]
        if len(pts) < 30: continue
        zext = pts[:, 2].max() - pts[:, 2].min()
        if zext < 0.5 * (zcut - mn[2]): continue
        if pts[:, 2].min() > mn[2] + 0.3 * (zcut - mn[2]): continue
        legs.append(leg_from_pts(pts, zcut))
    legs.sort(key=lambda l: -l["n"])
    return legs

def leg_from_pts(pts, zcut):
    foot = pts[pts[:, 2] < pts[:, 2].min() + 0.12 * (zcut - mn[2])]
    return dict(x=float(foot[:, 0].mean()), y=float(foot[:, 1].mean()), n=len(pts), pts=pts, zcut=zcut,
                xmin=float(pts[:, 0].min()), xmax=float(pts[:, 0].max()), ymin=float(pts[:, 1].min()), ymax=float(pts[:, 1].max()))

def split_bimodal(l):
    xs = l["pts"][:, 0]; cx = 0.5 * (xs.min() + xs.max()); w = xs.max() - xs.min()
    if w < 0.04 * L: return [l]
    mid = np.abs(xs - cx) < 0.10 * w
    if mid.mean() < 0.10:
        a, b = l["pts"][xs < cx], l["pts"][xs >= cx]
        if len(a) > 30 and len(b) > 30: return [leg_from_pts(a, l["zcut"]), leg_from_pts(b, l["zcut"])]
    return [l]

def find_legs():
    if GAIT in ("wing", "swim"): return []
    want = 4 if GAIT == "quad" else 2
    fracs = [0.30, 0.24, 0.18, 0.13, 0.09] if GAIT == "quad" else [0.42, 0.34, 0.26, 0.18, 0.12]
    best = []
    for fr in fracs:
        legs = find_legs_at(fr)
        log("  leg scan", fr, len(legs))
        if len(legs) >= want: best = legs; break
        if len(legs) > len(best): best = legs
    # post-pass: split blobs that are clearly two legs side by side
    out = []
    for l in best: out.extend(split_bimodal(l))
    if len(out) < want and out:
        # force-split the widest blob down the middle (legs side by side)
        out.sort(key=lambda l: -(l["xmax"] - l["xmin"]))
        l = out.pop(0); xs = l["pts"][:, 0]; cx = np.median(xs)
        a, b = l["pts"][xs < cx], l["pts"][xs >= cx]
        if len(a) > 30 and len(b) > 30: out += [leg_from_pts(a, l["zcut"]), leg_from_pts(b, l["zcut"])]; log("  forced split")
        else: out.append(l)
    out.sort(key=lambda l: -l["n"]); out = out[:want]
    out.sort(key=lambda l: (l["y"], l["x"]))
    return out
legs = find_legs()
log("legs", [(round(l["x"], 2), round(l["y"], 2), l["n"]) for l in legs])

# ---------------------------------------------------------------- build armature
arm_data = bpy.data.armatures.new("Armature"); arm = bpy.data.objects.new("Armature", arm_data)
sc.collection.objects.link(arm); bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
EB = arm_data.edit_bones
def spine_at(y):
    return np.array([np.interp(y, sp[:, 0], sp[:, 1]), y, np.interp(y, sp[:, 0], sp[:, 2])])
def add_bone(name, head, tail, parent=None, connect=False, roll=0.0):
    b = EB.new(name); b.head = Vector(head); b.tail = Vector(tail); b.roll = roll
    if parent: b.parent = parent; b.use_connect = connect
    return b

y_head, y_tail = mn[1], mx[1]
# segmentation along Y (head at -Y): head | neck | torso | tail
if KIND == "air":
    f_head, f_neck, f_hip = 0.10, 0.24, 0.62
elif GAIT == "swim":
    f_head, f_neck, f_hip = 0.14, 0.30, 0.62
elif SPECIES_ID == "paluxysaurus":
    f_head, f_neck, f_hip = 0.06, 0.40, 0.66
else:
    f_head, f_neck, f_hip = 0.14, 0.30, 0.60
if legs and GAIT == "quad":
    f_hip = (max(l["y"] for l in legs) - y_head) / L + 0.03
elif legs and GAIT == "biped":
    f_hip = (np.mean([l["y"] for l in legs]) - y_head) / L + 0.02
yH, yN, yP = y_head + f_head * L, y_head + f_neck * L, y_head + f_hip * L
root_pos = spine_at(yP)
root = add_bone("root", root_pos, root_pos + np.array([0, -0.25 * L * 0.3, 0]))
# torso chain from hips forward to neck base
n_torso = 3
tor = []; prev = root
for i in range(n_torso):
    a = yP - (yP - yN) * i / n_torso; b = yP - (yP - yN) * (i + 1) / n_torso
    bn = add_bone(f"spine{i+1}", spine_at(a), spine_at(b), prev, connect=(i > 0)); tor.append(bn); prev = bn
n_neck = 4 if SPECIES_ID == "paluxysaurus" else 2
neck = []
for i in range(n_neck):
    a = yN - (yN - yH) * i / n_neck; b = yN - (yN - yH) * (i + 1) / n_neck
    bn = add_bone(f"neck{i+1}", spine_at(a), spine_at(b), prev, connect=True); neck.append(bn); prev = bn
head_b = add_bone("head", spine_at(yH), spine_at(y_head) + np.array([0, 0.0, 0]), prev, connect=True)
# jaw: from head-base low point to snout low point
head_pts = V[V[:, 1] < yH]
jaw_z = np.percentile(head_pts[:, 2], 35)
jaw = add_bone("jaw", np.array([spine_at(yH)[0], yH, jaw_z]), np.array([spine_at(y_head)[0], y_head + 0.02 * L, jaw_z - 0.02 * H]), head_b)
# tail chain
n_tail = 5
tail = []; prev = root
for i in range(n_tail):
    a = yP + (y_tail - yP) * i / n_tail; b = yP + (y_tail - yP) * (i + 1) / n_tail
    bn = add_bone(f"tail{i+1}", spine_at(a), spine_at(b), prev, connect=(i > 0)); tail.append(bn); prev = bn
# legs
leg_bones = []
# tags: quadrupeds → the two legs nearest the head are front; sides by x. bipeds → L/R.
if GAIT == "quad" and len(legs) == 4:
    by_y = sorted(legs, key=lambda l: l["y"]); front_set = {id(l) for l in by_y[:2]}
else:
    front_set = {id(l) for l in legs if l["y"] < yP - 0.05 * L} if GAIT == "quad" else set()
used = set()
for li, l in enumerate(legs):
    side = "L" if l["x"] < 0 else "R"
    front = id(l) in front_set
    tag = ("F" if front else "B") + side if GAIT == "quad" else side
    if tag in used: tag = tag + str(li)
    used.add(tag)
    spz = spine_at(l["y"])[2]
    hip = np.array([l["x"] * 0.6, l["y"], spz * 0.9])
    foot = np.array([l["x"], l["y"], mn[2] + 0.04 * H])
    knee = np.array([l["x"] * 0.8, l["y"] + (-0.06 if front or GAIT == "biped" else 0.04) * L * 0.5, 0.5 * (hip[2] + foot[2]) + 0.02 * H])
    ankle = np.array([l["x"], l["y"] + 0.03 * L * 0.5, foot[2] + 0.12 * (hip[2] - foot[2])])
    toe = foot + np.array([0, -0.06 * L * 0.5, 0])
    par = tor[0] if not front else tor[-1]
    u = add_bone(f"thigh.{tag}", hip, knee, par)
    lo = add_bone(f"shin.{tag}", knee, ankle, u, connect=True)
    ft = add_bone(f"foot.{tag}", ankle, toe, lo, connect=True)
    leg_bones.append((tag, u.name, lo.name, ft.name, l))
# wings
wing_bones = []
if KIND == "air":
    shoulder_y = yN + 0.1 * L
    for side, sgn in (("L", -1), ("R", 1)):
        sh = np.array([sgn * 0.08 * size[0], spine_at(shoulder_y)[1], spine_at(shoulder_y)[2]])
        mid = np.array([sgn * 0.45 * size[0], sh[1] + 0.03 * size[1], sh[2]])
        tip = np.array([sgn * 0.5 * size[0], sh[1] + 0.05 * size[1], sh[2]])
        w1 = add_bone(f"wing1.{side}", sh, mid, tor[-1]); w2 = add_bone(f"wing2.{side}", mid, tip, w1, connect=True)
        wing_bones.append((side, w1.name, w2.name))
# flippers for swimmers: four paddles if the mesh is wide at the shoulders/hips
flip_bones = []
if KIND == "water":
    for name, yy in (("F", yN + 0.08 * L), ("B", yP + 0.02 * L)):
        for side, sgn in (("L", -1), ("R", 1)):
            sl = V[(V[:, 1] > yy - 0.08 * L) & (V[:, 1] < yy + 0.08 * L)]
            xr = sl[:, 0].min() if sgn < 0 else sl[:, 0].max()
            base = np.array([sgn * 0.25 * abs(xr), yy, spine_at(yy)[2] - 0.1 * H])
            tip = np.array([xr, yy + 0.06 * L, spine_at(yy)[2] - 0.2 * H])
            if abs(xr) < 0.12 * L: continue
            fb = add_bone(f"flip{name}.{side}", base, tip, tor[-1] if name == "F" else tor[0]); flip_bones.append((name, side, fb.name))
bpy.ops.object.mode_set(mode='OBJECT')
log("bones", len(arm_data.bones))

# ---------------------------------------------------------------- skinning
def bone_segments():
    segs = {}
    for b in arm_data.bones:
        segs[b.name] = (np.array(b.head_local), np.array(b.tail_local))
    return segs

def distance_weights():
    segs = bone_segments(); names = list(segs.keys())
    n = len(V); D = np.full((n, len(names)), 1e9, dtype=np.float32)
    for j, nm in enumerate(names):
        a, b = segs[nm]; ab = b - a; l2 = float(ab @ ab) + 1e-9
        t = np.clip(((V - a) @ ab) / l2, 0, 1)
        p = a + t[:, None] * ab
        d = np.linalg.norm(V - p, axis=1)
        # eligibility masks
        if nm.startswith(("thigh", "shin", "foot")):
            tag = nm.split(".")[1]
            l = [x for x in leg_bones if x[0] == tag][0][4]
            rx = 0.5 * (l["xmax"] - l["xmin"]) + 0.03 * L; ry = 0.5 * (l["ymax"] - l["ymin"]) + 0.03 * L
            inside = (np.abs(V[:, 0] - l["x"]) < rx * 1.2) & (np.abs(V[:, 1] - l["y"]) < ry * 1.2) & (V[:, 2] < segs[nm][0][2] + 0.05 * H if nm.startswith("thigh") else V[:, 2] < segs[nm][0][2] + 0.02 * H)
            d = np.where(inside, d, 1e9)
        if nm == "jaw":
            inside = (V[:, 1] < yH + 0.02 * L) & (V[:, 2] < jaw_z + 0.02 * H)
            d = np.where(inside, d * 0.6, 1e9)
        if nm == "root": d = d + 1e9
        D[:, j] = d
    # gaussian blend over the 4 nearest bones
    K = 4
    order = np.argsort(D, axis=1)[:, :K]
    dk = np.take_along_axis(D, order, axis=1)
    d0 = dk[:, :1]
    blend_r = 0.07 * L
    w = np.exp(-((dk - d0) / blend_r) ** 2); w[dk > 1e8] = 0
    w = w / np.maximum(w.sum(1, keepdims=True), 1e-9)
    return names, order, w

names, order, W = distance_weights()
for nm in names: body.vertex_groups.new(name=nm)
vg = {g.name: g for g in body.vertex_groups}
for i in range(len(V)):
    for k in range(order.shape[1]):
        if W[i, k] > 0.01: vg[names[order[i, k]]].add([i], float(W[i, k]), 'REPLACE')
# smooth weights along the mesh a little
body.parent = arm
mod = body.modifiers.new("Armature", 'ARMATURE'); mod.object = arm
bpy.context.view_layer.objects.active = body
bpy.ops.object.select_all(action='DESELECT'); body.select_set(True); arm.select_set(True)
try:
    if CFG.get("no_smooth"): raise RuntimeError("smoothing disabled for this species")
    bpy.ops.object.mode_set(mode='WEIGHT_PAINT')
    bpy.ops.object.vertex_group_smooth(group_select_mode='ALL', factor=0.5, repeat=10, expand=0.0)
    bpy.ops.object.mode_set(mode='OBJECT')
    log("weights smoothed")
except Exception as e:
    bpy.ops.object.mode_set(mode='OBJECT'); log("smooth failed", e)
bpy.ops.object.vertex_group_normalize_all(lock_active=False)

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
    bob = 0.012 * H * (0.5 - 0.5 * math.cos(4 * math.pi * t))
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
    rot_world(rootb, 'Z', 2.0 * S(t))     # hip sway
    rot_world(rootb, 'Y', 1.5 * S(t))

def roar(t, s):
    k = ease(t / 0.25) * (1 - ease((t - 0.75) / 0.25))
    for nb in necks: rot_world(nb, 'X', -8 * k)
    rot_world(head, 'X', -16 * k + 2.5 * k * S(6 * t))
    rot_world(jawb, 'X', 24 * k + 2 * k * S(8 * t))
    for sb in spines: rot_world(sb, 'X', -3 * k)
    tail_sway(t, 7 * amp, 0.0, 2.0)
    rootb.location.z = -0.01 * H * k

def eat(t, s):
    k = ease(t / 0.3) * (1 - ease((t - 0.7) / 0.3))
    down = 24 if SPECIES_ID != "paluxysaurus" else 20
    for nb in necks: rot_world(nb, 'X', down * k / n_neck * 1.2)
    rot_world(head, 'X', 14 * k)
    rot_world(spines[-1], 'X', 3 * k)
    chew = max(0.0, S(4 * t)) * (1 if 0.3 < t < 0.7 else 0)
    rot_world(jawb, 'X', 10 * chew)
    tail_sway(t, 4 * amp, 0.0, 1.0)
    for sb in spines: rot_world(sb, 'X', 4 * k)

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
        m.use_backface_culling = True
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
               stride=STRIDE, walkSeconds=((CLIPS["walk"][1] - 1) / FPS) if "walk" in CLIPS else None,
               bones=[b.name for b in arm_data.bones]), open(os.path.join(OUT_DIR, f"{SPECIES_ID}.json"), "w"), indent=1)
log("total", round(time.time() - t0, 1), "s")
