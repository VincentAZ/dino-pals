"""Dino Pals - photoreal food pile for the herbivores, built only from Poly Haven CC0 scans.

A settled heap of real produce (banana bunches, bananas, pomegranates, apples, an avocado, lemons,
a lime, sweet potatoes, Asian pears) at real-world scale, lying in a thatch of cut fern fronds and
broad calathea / anthurium leaves.

    blender -b --python blender/food/build_food.py -- \
        --src  <download dir, one subfolder per Poly Haven asset; missing files are fetched with curl> \
        [--out web/public/assets/dinos/food.glb] [--json <out>.json] [--work <scratch dir>] \
        [--seed 11] [--frames 150] [--blend <debug .blend>] [--no-optimize] [--litter]

Pipeline
  1. fetch    1k glTF of every scan + the maps the glTF does not wire up (foliage Alpha, arm = AO/rough/metal)
  2. import   welded (merge_vertices) so decimation cannot open cracks along UV seams
  3. material plain glTF PBR rebuilt per scan: baseColor (+Alpha packed into A, alphaMode MASK 0.5 for
              foliage), normal, ORM; texels outside the UV islands are push-pull padded
  4. meshes   produce decimated per item; foliage scans split into single fronds / leaves, decimated each
  5. settle   produce dropped in waves (big items first) into the lowest hollows of the heap and settled
              with Blender rigid bodies (convex hulls, hidden mound collider + ground plane, `--frames`
              per wave, earlier waves frozen as passive); anything that rolls off is re-dropped
  6. nest     leaves draped in layers over scaled copies of the mound, pressed down under the produce
  7. export   GLB (Y up) -> gltf-transform dedup / prune / resize 1024 / webp / draco -> sidecar JSON

Nodes: item_00..item_NN (edible, origin = item centre, item_00 = top of the heap, i.e. eat in order),
leaf_00..leaf_NN (greenery joined per material). Pile origin = ground centre.
QA: blender/food/render_food.py (Cycles renders), blender/food/verify_food.py (budgets, sidecar).
"""
import bpy, bmesh, sys, os, json, math, random, subprocess, argparse, glob, shutil
import numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
API = "https://api.polyhaven.com"


def log(*a):
    print("[food]", *a, flush=True)


# --------------------------------------------------------------------------------------------
# Content
# --------------------------------------------------------------------------------------------
# (asset id, source object, kind, count, target triangles, texture size)
PRODUCE = [
    ("bananas", "bananas_bunch", "banana_bunch", 4, 1000, 1024),
    ("bananas", "bananas_a", "banana", 1, 320, 1024),
    ("bananas", "bananas_b", "banana", 1, 320, 1024),
    ("bananas", "bananas_c", "banana", 1, 320, 1024),
    ("bananas", "bananas_d", "banana", 1, 320, 1024),
    ("food_pomegranate_01", "food_pomegranate_01", "pomegranate", 4, 340, 512),
    ("food_apple_01", "food_apple_01", "apple", 4, 320, 512),
    ("food_avocado_01", "food_avocado_01", "avocado", 1, 320, 512),
    ("lemon", "lemon", "lemon", 2, 300, 512),
    ("sweet_potato", "sweet_potato", "sweet_potato", 2, 300, 512),
    ("food_lime_01", "food_lime_01", "lime", 1, 300, 512),
    ("food_pears_asian_01", "food_pears_asian_01_b", "asian_pear", 1, 280, 512),
    ("food_pears_asian_01", "food_pears_asian_01_c", "asian_pear", 1, 280, 512),
]
# greenery sources: (asset id, source object, triangles per leaf after decimation, min leaf size m)
# each scan is split into its separate fronds / leaves, which are laid individually like a thatch
GREEN = [
    ("fern_02", "fern_02_a", 64, 0.18), ("fern_02", "fern_02_b", 64, 0.25), ("fern_02", "fern_02_c", 64, 0.25),
    ("fern_02", "fern_02_d", 64, 0.18),
    ("calathea_orbifolia_01", "calathea_orbifolia_01_a", 70, 0.15),
    ("anthurium_botany_01", "anthurium_botany_01_a", 110, 0.3), ("anthurium_botany_01", "anthurium_botany_01_b", 110, 0.3),
]
GREEN_TEX = {"fern_02": 1024, "anthurium_botany_01": 1024, "calathea_orbifolia_01": 1024}
LITTER = "forest_leaves_02"      # optional (--litter) Poly Haven texture for a leaf-litter core under the nest
LITTER_TEX = 256                # buried under the foliage: only glimpsed through gaps, in shade
LITTER_RES, LITTER_CROP, LITTER_M = "1k", 0.5, 1.5   # 1k scan of 3 x 3 m, keep the central 1.5 m

MODEL_ASSETS = sorted({p[0] for p in PRODUCE} | {g[0] for g in GREEN})


# --------------------------------------------------------------------------------------------
# Download (curl: Poly Haven rejects urllib's default UA)
# --------------------------------------------------------------------------------------------
def curl(url, dst=None):
    cmd = ["curl", "-sfL", "--retry", "3", "-A", "Mozilla/5.0 (dino-pals food builder)", url]
    if dst:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        subprocess.run(cmd + ["-o", dst], check=True)
        return None
    return subprocess.run(cmd, check=True, capture_output=True).stdout


def _meta(aid, d):
    for name, url in (("files.json", f"{API}/files/{aid}"), ("info.json", f"{API}/info/{aid}")):
        p = os.path.join(d, name)
        if not os.path.exists(p):
            open(p, "wb").write(curl(url))
    return json.load(open(os.path.join(d, "files.json")))


def fetch_model(aid, root, res="1k"):
    d = os.path.join(root, aid)
    os.makedirs(d, exist_ok=True)
    files = _meta(aid, d)
    g = files["gltf"][res]["gltf"]
    gl = os.path.join(d, os.path.basename(g["url"]))
    if not os.path.exists(gl):
        curl(g["url"], gl)
    for rel, inc in g["include"].items():
        p = os.path.join(d, rel)
        if not os.path.exists(p):
            curl(inc["url"], p)
    # maps that are NOT always wired into the glTF: Alpha (foliage) and arm (AO/rough/metal)
    for key, ent in files.items():
        kl = key.lower()
        if kl in ("gltf", "blend", "fbx", "usd") or not (kl.endswith("alpha") or kl.endswith("arm")):
            continue
        src = ent.get(res, {}).get("png") or ent.get(res, {}).get("jpg")
        if src:
            p = os.path.join(d, "extra", os.path.basename(src["url"]))
            if not os.path.exists(p):
                curl(src["url"], p)
    return gl


def fetch_texture(aid, root, res="1k"):
    d = os.path.join(root, aid)
    os.makedirs(d, exist_ok=True)
    files = _meta(aid, d)
    out = {}
    for key in ("Diffuse", "nor_gl", "arm"):
        src = files[key][res]["jpg"]
        p = os.path.join(d, os.path.basename(src["url"]))
        if not os.path.exists(p):
            curl(src["url"], p)
        out[key] = p
    return out


# --------------------------------------------------------------------------------------------
# Images / materials
# --------------------------------------------------------------------------------------------
def load_px(path, size, crop=1.0):
    """Load an image file, optionally keep the central `crop` fraction, resample to size x size.
    Returns an HxWx4 float array of the raw encoded values (no colour conversion)."""
    im = bpy.data.images.load(path)
    im.colorspace_settings.name = 'Non-Color'
    if crop < 1.0:
        w, h = im.size
        a = np.empty(w * h * 4, np.float32)
        im.pixels.foreach_get(a)
        a = a.reshape(h, w, 4)
        cw, ch = int(w * crop), int(h * crop)
        a = np.ascontiguousarray(a[(h - ch) // 2:(h - ch) // 2 + ch, (w - cw) // 2:(w - cw) // 2 + cw])
        bpy.data.images.remove(im)
        im = bpy.data.images.new("crop_tmp", cw, ch, alpha=True)
        im.pixels.foreach_set(a.ravel())
    if tuple(im.size) != (size, size):
        im.scale(size, size)
    a = np.empty(size * size * 4, np.float32)
    im.pixels.foreach_get(a)
    bpy.data.images.remove(im)
    return a.reshape(size, size, 4)


def save_png(name, px, path, colorspace, alpha):
    h, w, _ = px.shape
    im = bpy.data.images.new(name, w, h, alpha=alpha)
    if not alpha:
        px = px.copy(); px[..., 3] = 1.0
    im.pixels.foreach_set(px.ravel())
    im.filepath_raw = path
    im.file_format = 'PNG'
    im.save()
    bpy.data.images.remove(im)
    im = bpy.data.images.load(path)
    im.colorspace_settings.name = colorspace
    im.name = name
    return im


def uv_mask(meshes, size):
    """Texels covered by the UV islands of `meshes` (rasterised at size x size, dilated by 2 px)."""
    m = np.zeros((size, size), bool)
    for me in meshes:
        if not me.uv_layers:
            continue
        me.calc_loop_triangles()
        uv = np.empty(len(me.loops) * 2, np.float32)
        me.uv_layers.active.data.foreach_get("uv", uv)
        uv = uv.reshape(-1, 2) * size - 0.5
        tri = np.empty(len(me.loop_triangles) * 3, np.int32)
        me.loop_triangles.foreach_get("loops", tri)
        for a, b, c in uv[tri.reshape(-1, 3)]:
            x0, y0 = np.floor(np.minimum(np.minimum(a, b), c)).astype(int)
            x1, y1 = np.ceil(np.maximum(np.maximum(a, b), c)).astype(int)
            x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, size - 1), min(y1, size - 1)
            if x1 < x0 or y1 < y0:
                continue
            d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
            if abs(d) < 1e-12:
                continue
            gx, gy = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
            l1 = ((b[1] - c[1]) * (gx - c[0]) + (c[0] - b[0]) * (gy - c[1])) / d
            l2 = ((c[1] - a[1]) * (gx - c[0]) + (a[0] - c[0]) * (gy - c[1])) / d
            e = -0.02
            m[gy, gx] |= (l1 >= e) & (l2 >= e) & (1 - l1 - l2 >= e)
    for _ in range(2):
        m = m | np.roll(m, 1, 0) | np.roll(m, -1, 0) | np.roll(m, 1, 1) | np.roll(m, -1, 1)
    return m


def pad_texture(px, mask):
    """Push-pull fill of the RGB of texels outside the UV islands with the colours of the nearest islands,
    so seams that drift during decimation (and engine mip-mapping) never sample the black background."""
    if mask.all():
        return px
    img = px[..., :3].astype(np.float64)
    w = mask.astype(np.float64)
    pyr = [(img * w[..., None], w)]
    while pyr[-1][1].shape[0] > 1:
        I, W = pyr[-1]
        h, ww = W.shape
        pyr.append((I.reshape(h // 2, 2, ww // 2, 2, 3).sum((1, 3)), W.reshape(h // 2, 2, ww // 2, 2).sum((1, 3))))
    col = pyr[-1][0] / np.maximum(pyr[-1][1], 1e-9)[..., None]
    for I, W in reversed(pyr[:-1]):
        up = np.repeat(np.repeat(col, 2, 0), 2, 1)
        a = np.clip(W, 0, 1)[..., None]
        col = (I / np.maximum(W, 1e-9)[..., None]) * a + up * (1 - a)
    out = px.copy()
    out[..., :3] = np.where(mask[..., None], px[..., :3], col)
    return out


def gltf_output_group():
    g = bpy.data.node_groups.get("glTF Material Output")
    if g is None:
        g = bpy.data.node_groups.new("glTF Material Output", 'ShaderNodeTree')
        g.interface.new_socket("Occlusion", in_out='INPUT', socket_type='NodeSocketFloat')
        g.nodes.new('NodeGroupOutput')
        g.nodes.new('NodeGroupInput')
    return g


def build_material(name, diff, nor, arm, alpha, size, work, crop=1.0, meshes=()):
    """Plain glTF PBR: baseColor (+alpha packed in A, MASK 0.5), normal, ORM (R=AO, G=rough, B=metal).
    Texels outside the UV islands of `meshes` are padded (see pad_texture)."""
    mask = uv_mask(meshes, size) if meshes else np.ones((size, size), bool)
    base = pad_texture(load_px(diff, size, crop), mask)
    if alpha:
        a = load_px(alpha, size)
        base[..., 3] = a[..., 0]
    nrm = pad_texture(load_px(nor, size, crop), mask)
    orm = pad_texture(load_px(arm, size, crop), mask)
    img_c = save_png(name + "_col", base, os.path.join(work, name + "_col.png"), 'sRGB', bool(alpha))
    img_n = save_png(name + "_nrm", nrm, os.path.join(work, name + "_nrm.png"), 'Non-Color', False)
    img_o = save_png(name + "_orm", orm, os.path.join(work, name + "_orm.png"), 'Non-Color', False)

    old = bpy.data.materials.get(name)
    if old is not None:
        old.name = name + "_src"           # the importer's material keeps the scan's name; ours takes it
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    N, L = nt.nodes, nt.links
    for n in list(N):
        N.remove(n)
    out = N.new('ShaderNodeOutputMaterial'); out.location = (600, 0)
    b = N.new('ShaderNodeBsdfPrincipled'); b.location = (250, 0)
    L.new(b.outputs['BSDF'], out.inputs['Surface'])
    b.inputs['IOR'].default_value = 1.5
    b.inputs['Specular IOR Level'].default_value = 0.5
    tc = N.new('ShaderNodeTexImage'); tc.image = img_c; tc.location = (-500, 300)
    L.new(tc.outputs['Color'], b.inputs['Base Color'])
    if alpha:
        lt = N.new('ShaderNodeMath'); lt.operation = 'LESS_THAN'; lt.inputs[1].default_value = 0.5; lt.location = (-200, 150)
        sub = N.new('ShaderNodeMath'); sub.operation = 'SUBTRACT'; sub.inputs[0].default_value = 1.0; sub.location = (0, 150)
        L.new(tc.outputs['Alpha'], lt.inputs[0])
        L.new(lt.outputs[0], sub.inputs[1])
        L.new(sub.outputs[0], b.inputs['Alpha'])
        m.surface_render_method = 'DITHERED'
        m.use_backface_culling = False      # leaves: doubleSided
    else:
        m.use_backface_culling = True       # closed produce scans: single-sided
    tn = N.new('ShaderNodeTexImage'); tn.image = img_n; tn.location = (-500, -350)
    nm = N.new('ShaderNodeNormalMap'); nm.location = (-200, -350)
    L.new(tn.outputs['Color'], nm.inputs['Color'])
    L.new(nm.outputs['Normal'], b.inputs['Normal'])
    to = N.new('ShaderNodeTexImage'); to.image = img_o; to.location = (-500, -20)
    sp = N.new('ShaderNodeSeparateColor'); sp.location = (-200, -20)
    L.new(to.outputs['Color'], sp.inputs['Color'])
    L.new(sp.outputs['Green'], b.inputs['Roughness'])
    L.new(sp.outputs['Blue'], b.inputs['Metallic'])
    go = N.new('ShaderNodeGroup'); go.node_tree = gltf_output_group(); go.location = (250, -450)
    L.new(sp.outputs['Red'], go.inputs['Occlusion'])
    return m


def model_maps(adir, aid, prefix=""):
    tex = os.path.join(adir, "textures")
    stem = f"{aid}_{prefix}" if prefix else f"{aid}_"
    diff = glob.glob(os.path.join(tex, f"{stem}diff_*"))[0]
    nor = glob.glob(os.path.join(tex, f"{stem}nor_gl_*"))[0]
    arm = (glob.glob(os.path.join(adir, "extra", f"{stem}arm_*")) or glob.glob(os.path.join(tex, f"{stem}arm_*")))[0]
    al = glob.glob(os.path.join(adir, "extra", f"{stem}alpha_*"))
    return diff, nor, arm, (al[0] if al else None)


# --------------------------------------------------------------------------------------------
# Meshes
# --------------------------------------------------------------------------------------------
def tri_count(me):
    return sum(len(p.vertices) - 2 for p in me.polygons)


def clean_normals(me):
    for an in ("custom_normal", "sharp_edge", "sharp_face"):
        a = me.attributes.get(an)
        if a is not None:
            me.attributes.remove(a)
    me.shade_smooth()


def verts_np(me):
    a = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get("co", a)
    return a.reshape(-1, 3)


def set_verts(me, v):
    me.vertices.foreach_set("co", v.astype(np.float32).ravel())
    me.update()


def add_decimate(obj, ratio):
    mod = obj.modifiers.new("dec", 'DECIMATE')
    mod.ratio = ratio
    mod.use_collapse_triangulate = True
    return mod


def make_proto(obj, target, name, pivot="center"):
    """Decimated, transform-applied copy of a scan. pivot: 'center' (bounds centre) or 'base' (centre-bottom)."""
    dg = bpy.context.evaluated_depsgraph_get()
    t0 = tri_count(obj.data)
    if target and t0 > target * 1.05:
        add_decimate(obj, target / t0)
        dg.update()
    me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    me.transform(obj.matrix_world)
    v = verts_np(me)
    lo, hi = v.min(0), v.max(0)
    c = (lo + hi) / 2
    if pivot == "base":
        c[2] = lo[2]
    me.transform(Matrix.Translation(Vector(-c)))
    clean_normals(me)
    me.name = name
    log(f"proto {name}: {t0} -> {tri_count(me)} tris, dims {np.round(hi - lo, 3)}")
    return me


def decimate_mesh(me, target):
    """Collapse-decimate a mesh datablock to ~target triangles (returns a new mesh, or `me` if small)."""
    t0 = tri_count(me)
    if not target or t0 <= target * 1.1:
        return me
    tmp = bpy.data.objects.new("_dec", me)
    bpy.context.scene.collection.objects.link(tmp)
    add_decimate(tmp, target / t0)
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    out = bpy.data.meshes.new_from_object(tmp.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    bpy.data.objects.remove(tmp)
    clean_normals(out)
    return out


def split_parts(me, min_size, name, part_tris=0):
    """Split a (base-pivoted) plant scan into its connected parts (fronds / leaves). Each part is
    re-expressed in 'leaf space': its stem end at the origin, pointing along +X, Z up."""
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    comp = [-1] * len(bm.faces)
    groups = []
    for f in bm.faces:
        if comp[f.index] >= 0:
            continue
        stack, cur = [f], []
        comp[f.index] = len(groups)
        while stack:
            g = stack.pop()
            cur.append(g.index)
            for e in g.edges:
                for h in e.link_faces:
                    if comp[h.index] < 0:
                        comp[h.index] = len(groups)
                        stack.append(h)
        groups.append(cur)
    parts = []
    for gi, faces in enumerate(groups):
        keep = set(faces)
        b2 = bm.copy()
        b2.faces.ensure_lookup_table()
        bmesh.ops.delete(b2, geom=[f for f in b2.faces if f.index not in keep], context='FACES')
        bmesh.ops.delete(b2, geom=[v for v in b2.verts if not v.link_faces], context='VERTS')
        co = np.array([v.co[:] for v in b2.verts])
        if co.size == 0 or float((co.max(0) - co.min(0)).max()) < min_size:
            b2.free()
            continue
        # stem end = the vertex nearest the plant's centre axis (low down); tip = farthest from it
        hd = np.hypot(co[:, 0], co[:, 1])
        base = co[np.argmin(hd + 0.5 * co[:, 2])]
        d = np.hypot(co[:, 0] - base[0], co[:, 1] - base[1])
        tip = co[np.argmax(d)]
        az = math.atan2(tip[1] - base[1], tip[0] - base[0])
        m = bpy.data.meshes.new(f"{name}_{gi:02d}")
        b2.to_mesh(m)
        b2.free()
        m.transform(Matrix.Rotation(-az, 4, 'Z') @ Matrix.Translation(Vector(-base)))
        m.materials.append(me.materials[0])
        clean_normals(m)
        m = decimate_mesh(m, part_tris)
        parts.append((m, float(d.max()), tri_count(m)))
    bm.free()
    return parts


# --------------------------------------------------------------------------------------------
# Mound (hidden collider + heightfield used for draping the nest)
# --------------------------------------------------------------------------------------------
class Mound:
    """Leaf-heap shape: a plateau mound (flat crown, ~40 deg flanks) with a shallow basin on top that
    cradles the produce, plus an irregular outline and a few low bumps."""

    def __init__(self, rnd, R=0.82, P=0.36, H=0.33, D=0.05, B=0.3):
        self.R, self.P, self.H, self.D, self.B = R, P, H, D, B
        self.waves = [(rnd.uniform(0, 6.283), k, rnd.uniform(0.03, 0.06)) for k in (2, 3, 5)]
        self.bumps = [(rnd.uniform(-0.5, 0.5), rnd.uniform(-0.5, 0.5), rnd.uniform(0.1, 0.18), rnd.uniform(-0.025, 0.025))
                      for _ in range(7)]

    def h(self, x, y):
        x = np.asarray(x, np.float64); y = np.asarray(y, np.float64)
        ang = np.arctan2(y, x)
        rr = np.hypot(x, y)
        r = rr / (1.0 + sum(a * np.sin(k * ang + p) for p, k, a in self.waves))
        t = np.clip((r - self.P) / (self.R - self.P), 0.0, 1.0)
        fall = 1.0 - t * t * (3.0 - 2.0 * t)
        base = self.H * fall
        base = base - self.D * np.clip(1.0 - (rr / self.B) ** 2, 0.0, None) ** 2
        inside = np.clip(1.0 - t, 0.0, 1.0)
        for bx, by, s, a in self.bumps:
            base = base + a * np.exp(-((x - bx) ** 2 + (y - by) ** 2) / (s * s)) * inside
        return np.clip(base, 0.0, None)

    def mesh(self, name, offset=0.0, n_r=40, n_a=96, r_max=1.0, f=1.0):
        verts, faces = [(0.0, 0.0, f * float(self.h(0.0, 0.0)) + offset)], []
        rmax = self.R * 1.12 * r_max
        for i in range(1, n_r + 1):
            r = rmax * (i / n_r) ** 0.85
            for j in range(n_a):
                a = 2 * math.pi * j / n_a
                x, y = r * math.cos(a), r * math.sin(a)
                verts.append((x, y, max(0.0, f * float(self.h(x, y)) + offset)))
        for j in range(n_a):
            faces.append((0, 1 + j, 1 + (j + 1) % n_a))
        for i in range(n_r - 1):
            for j in range(n_a):
                a0 = 1 + i * n_a + j; a1 = 1 + i * n_a + (j + 1) % n_a
                faces.append((a0, a0 + n_a, a1 + n_a, a1))
        me = bpy.data.meshes.new(name)
        me.from_pydata(verts, [], faces)
        me.update()
        return me


# --------------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------------
def link(obj, coll):
    coll.objects.link(obj)
    return obj


def world_bvh(objs):
    verts, polys, off = [], [], 0
    for o in objs:
        mw = o.matrix_world
        v = [mw @ vv.co for vv in o.data.vertices]
        verts += v
        polys += [[i + off for i in p.vertices] for p in o.data.polygons]
        off += len(v)
    return BVHTree.FromPolygons(verts, polys)


def obj_world_verts(o):
    v = verts_np(o.data)
    mw = np.array(o.matrix_world)
    return v @ mw[:3, :3].T + mw[:3, 3]


# --------------------------------------------------------------------------------------------
# Main build
# --------------------------------------------------------------------------------------------
def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--work", default=None)
    ap.add_argument("--out", default=os.path.join(REPO, "web/public/assets/dinos/food.glb"))
    ap.add_argument("--json", default=None)
    ap.add_argument("--blend", default=None)
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--frames", type=int, default=150)
    ap.add_argument("--no-optimize", action="store_true")
    ap.add_argument("--litter", action="store_true", help="add a leaf-litter core under the foliage")
    args = ap.parse_args(argv)
    src = os.path.abspath(args.src)
    work = os.path.abspath(args.work or os.path.join(src, "_work"))
    os.makedirs(work, exist_ok=True)
    json_out = args.json or os.path.splitext(args.out)[0] + ".json"
    rnd = random.Random(args.seed)

    # ---- fetch -------------------------------------------------------------------------------
    gltf_paths = {aid: fetch_model(aid, src) for aid in MODEL_ASSETS}
    litter_maps = fetch_texture(LITTER, src, LITTER_RES) if args.litter else None

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    src_coll = bpy.data.collections.new("_sources"); scene.collection.children.link(src_coll)
    pile = bpy.data.collections.new("pile"); scene.collection.children.link(pile)

    # ---- import scans + materials ----------------------------------------------------------
    src_objs = {}
    mats = {}
    for aid in MODEL_ASSETS:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=gltf_paths[aid], merge_vertices=True)   # weld UV seams
        new = [o for o in bpy.data.objects if o not in before]
        for o in new:
            for c in list(o.users_collection):
                c.objects.unlink(o)
            src_coll.objects.link(o)
            if o.type == 'MESH':
                src_objs[o.name] = o
        size = next((p[5] for p in PRODUCE if p[0] == aid), GREEN_TEX.get(aid, 1024))
        diff, nor, arm, al = model_maps(os.path.dirname(gltf_paths[aid]), aid)
        mats[aid] = build_material(aid, diff, nor, arm, al, size, work,
                                   meshes=[o.data for o in new if o.type == 'MESH'])
        log(f"material {aid}: size {size}, alpha={'yes' if al else 'no'}")
        for o in new:
            if o.type == 'MESH':
                o.data.materials.clear()
                o.data.materials.append(mats[aid])
    src_coll.hide_render = True
    lit_mat = None
    if args.litter:
        lit_mat = build_material(LITTER, litter_maps["Diffuse"], litter_maps["nor_gl"], litter_maps["arm"], None,
                                 LITTER_TEX, work, crop=LITTER_CROP)

    # ---- prototypes ----------------------------------------------------------------------------
    protos = {}
    for aid, oname, kind, cnt, tgt, _ in PRODUCE:
        if oname not in protos:
            protos[oname] = make_proto(src_objs[oname], tgt, "p_" + oname, pivot="center")
    leaves = {"fern_02": [], "calathea_orbifolia_01": [], "anthurium_botany_01": []}
    for aid, oname, part_tris, min_size in GREEN:
        clump = make_proto(src_objs[oname], 0, "g_" + oname, pivot="base")
        parts = split_parts(clump, min_size, "g_" + oname, part_tris)
        leaves[aid] += parts
        log(f"  {oname}: {len(parts)} leaves/fronds, avg {np.mean([p[2] for p in parts]):.0f} tris, "
            f"length {min(p[1] for p in parts):.2f}-{max(p[1] for p in parts):.2f} m")

    # ---- hidden mound collider (the compressed leaf bed) + ground ----------------------------------
    mound = Mound(rnd)
    LEAF_BED = 0.022            # thickness of the flattened leaf layer the produce rests on
    HEAP_R = 0.6                # produce further out than this has rolled off the leafy heap
    col_me = mound.mesh("collider", offset=LEAF_BED)
    collider = link(bpy.data.objects.new("collider", col_me), scene.collection)
    ground = link(bpy.data.objects.new("ground", bpy.data.meshes.new("ground")), scene.collection)
    ground.data.from_pydata([(-6, -6, 0), (6, -6, 0), (6, 6, 0), (-6, 6, 0)], [], [(0, 1, 2, 3)])

    # ---- produce: dropped in waves onto the heap and settled with rigid-body physics ---------------
    items = []
    for aid, oname, kind, cnt, tgt, _ in PRODUCE:
        for k in range(cnt):
            me = protos[oname]
            ob = link(bpy.data.objects.new(f"tmp_{len(items):02d}", me), pile)
            ob["kind"] = kind
            ob["src"] = aid
            sc = rnd.uniform(1.0, 1.12)                      # real-world size, +0..12 % natural variation
            ob.scale = (sc, sc, sc)
            items.append(ob)
    radius = {o.name: float(np.linalg.norm(verts_np(o.data), axis=1).max()) * o.scale.x for o in items}
    rnd.shuffle(items)
    # roughly biggest first (they form the base of the heap), jittered so the kinds mix
    jit = {o.name: radius[o.name] * rnd.uniform(0.7, 1.3) for o in items}
    items.sort(key=lambda o: -jit[o.name])
    for o in items:                                          # parked far away until their wave drops
        o.location = (50.0 + 2 * items.index(o), 0.0, 0.0)

    def add_rb(o, kind, shape, mass=1.0):
        bpy.ops.object.select_all(action='DESELECT')
        bpy.context.view_layer.objects.active = o
        o.select_set(True)
        bpy.ops.rigidbody.object_add(type=kind)
        rb = o.rigid_body
        rb.collision_shape = shape
        rb.use_margin = True
        rb.collision_margin = 0.0005
        rb.friction = 0.95
        rb.restitution = 0.0
        if kind == 'ACTIVE':
            rb.mass = mass
            # heavy damping stands in for the drag of the leaf bed (fruit does not roll off a heap of leaves)
            rb.linear_damping = 0.6
            rb.angular_damping = 0.95
        else:
            rb.mesh_source = 'BASE'

    def simulate(active, passive, frames):
        """Rigid-body settle (convex hulls) of `active` items on the mound collider, the ground plane and the
        already-settled `passive` items. Bakes `frames` frames and applies the final transforms."""
        bpy.ops.rigidbody.world_add()
        rbw = scene.rigidbody_world
        rbw.substeps_per_frame = 30
        rbw.solver_iterations = 40
        rbw.point_cache.frame_start = 1
        rbw.point_cache.frame_end = frames
        scene.frame_start, scene.frame_end = 1, frames
        scene.frame_set(1)
        add_rb(collider, 'PASSIVE', 'MESH')
        add_rb(ground, 'PASSIVE', 'BOX')
        for o in passive:
            add_rb(o, 'PASSIVE', 'CONVEX_HULL')
        for o in active:
            d = o.dimensions
            add_rb(o, 'ACTIVE', 'CONVEX_HULL', mass=max(0.05, 600.0 * d.x * d.y * d.z * 0.52))
        hist = {}
        for f in range(1, frames + 1):
            scene.frame_set(f)
            if f in (frames - 15, frames):
                hist[f] = [o.matrix_world.copy() for o in active]
        final = hist[frames]
        moves = [(final[i].translation - hist[frames - 15][i].translation).length for i in range(len(active))]
        bpy.ops.object.select_all(action='DESELECT')
        for o in active + passive + [collider, ground]:
            o.select_set(True)
        bpy.context.view_layer.objects.active = collider
        bpy.ops.rigidbody.objects_remove()
        bpy.ops.rigidbody.world_remove()
        scene.frame_set(1)
        for o, m in zip(active, final):
            o.matrix_world = m
        bpy.context.view_layer.update()
        return max(moves)

    def drop_height(x, y, rn, solid):
        """Lowest centre height at (x, y) for a sphere of radius rn that clears the mound (+ leaf bed) and
        the bounding spheres of the `solid` items."""
        z = float(mound.h(x, y)) + LEAF_BED + rn
        for o in solid:
            c = o.matrix_world.translation
            rr = radius[o.name] + rn
            d2 = (c.x - x) ** 2 + (c.y - y) ** 2
            if d2 < rr * rr:
                z = max(z, c.z + math.sqrt(rr * rr - d2))
        return z

    settled, queue, tries = [], list(items), {o.name: 0 for o in items}
    WAVE = 6
    wave_no = 0
    while queue:
        wave, queue = queue[:WAVE], queue[WAVE:]
        wave_no += 1
        placed = list(settled)
        for o in wave:                       # drop each into the lowest hollow of the heap near the middle
            cands = []
            for _ in range(96):
                a = rnd.uniform(0, 6.283); r = 0.28 * math.sqrt(rnd.random())
                x, y = r * math.cos(a), r * math.sin(a)
                zc = drop_height(x, y, radius[o.name], placed)
                cands.append((zc - radius[o.name] + 0.08 * r, zc, x, y))
            _, zc, x, y = min(cands)
            o.location = (x, y, zc + 0.008)
            if o["kind"] in ("banana", "banana_bunch"):
                o.rotation_euler = (rnd.uniform(-0.3, 0.3), rnd.uniform(-0.3, 0.3), rnd.uniform(0, 6.283))
            else:
                o.rotation_euler = (rnd.uniform(0, 6.283), rnd.uniform(0, 6.283), rnd.uniform(0, 6.283))
            bpy.context.view_layer.update()
            placed.append(o)
        starts = {o.name: o.matrix_world.translation.copy() for o in wave}
        motion = simulate(wave, settled, args.frames)
        if os.environ.get("FOOD_DEBUG"):
            for o in wave:
                log(f"    {o['kind']:12s} {tuple(round(v, 3) for v in starts[o.name])} -> "
                    f"{tuple(round(v, 3) for v in o.matrix_world.translation)}")
        rolled = [o for o in wave if math.hypot(*o.matrix_world.translation.xy) > HEAP_R and tries[o.name] < 10]
        for o in rolled:
            tries[o.name] += 1
            o.location = (50.0 + 2 * items.index(o), 0.0, 0.0)
        settled += [o for o in wave if o not in rolled]
        queue += rolled
        log(f"wave {wave_no}: {len(wave)} dropped, settled (max motion {motion * 1000:.1f} mm), "
            f"{len(rolled)} rolled off -> re-queued")
    esc = [o for o in items if math.hypot(*o.matrix_world.translation.xy) > HEAP_R]
    if esc:
        log(f"WARNING: {len(esc)} item(s) still off the heap: {[o['kind'] for o in esc]}")

    # ---- QA: floating / interpenetration -----------------------------------------------------
    sup_bvh = BVHTree.FromObject(collider, bpy.context.evaluated_depsgraph_get())

    def contact(i, item_bvhs):
        """(distance from the item to whatever supports it - mound, ground or another item -,
        number of triangle pairs intersecting other items)"""
        wv = obj_world_verts(items[i])
        gap = 1e9
        for p in wv:
            p = Vector(p)
            r = sup_bvh.find_nearest(p)
            if r[0] is not None:
                gap = min(gap, r[3])
            gap = min(gap, max(p.z, 0.0))
            for j, b in enumerate(item_bvhs):
                if j != i:
                    r = b.find_nearest(p)
                    if r[0] is not None:
                        gap = min(gap, r[3])
        ov = sum(len(item_bvhs[i].overlap(item_bvhs[j])) for j in range(len(items)) if j != i)
        return gap, ov

    # convex hulls can leave an item hovering over a concave neighbour (e.g. the curve of a banana
    # bunch): lower such items in 1 mm steps until they touch, never into another item
    for i, o in enumerate(items):
        bvhs = [world_bvh([q]) for q in items]
        gap, ov = contact(i, bvhs)
        steps = 0
        while gap > 0.003 and steps < 40:
            o.location.z -= 0.001
            bpy.context.view_layer.update()
            bvhs[i] = world_bvh([o])
            g2, ov2 = contact(i, bvhs)
            if ov2 > ov:
                o.location.z += 0.001
                bpy.context.view_layer.update()
                break
            gap, steps = g2, steps + 1
        if steps:
            log(f"  lowered {o.name} ({o['kind']}) by {steps} mm")
    bvhs = [world_bvh([q]) for q in items]
    for i, o in enumerate(items):
        gap, ov = contact(i, bvhs)
        t = o.matrix_world.translation
        flag = (" <-- FLOAT" if gap > 0.006 else "") + (" <-- OVERLAP" if ov > 12 else "")
        log(f"  {o.name:8s} {o['kind']:13s} gap={gap * 1000:5.1f}mm overlapTris={ov:3d} pos=({t.x:+.2f},{t.y:+.2f},{t.z:.2f}){flag}")

    # ---- greenery: individual fronds / leaves laid like a thatch, draped over the mound -----------
    fruit_bvh = world_bvh(items)
    greens = []

    def drape(part, px, py, yaw, scale, squash, roll=0.0, lift=0.0, cap=None, f=1.0):
        """Lay one leaf (leaf space: stem at origin, pointing +X) at (px, py) pointing along `yaw`, follow the
        mound surface, flatten its arch by `squash`, and press it down under any produce lying on top."""
        me = part.copy()
        v = verts_np(me)
        R = np.array(Matrix.Rotation(yaw, 3, 'Z') @ Matrix.Rotation(roll, 3, 'X')) * scale
        w = v @ R.T
        zl = (w[:, 2] - w[:, 2].min()) * squash
        if cap is not None:
            zl = np.minimum(zl, cap)
        x = w[:, 0] + px; y = w[:, 1] + py
        h = f * mound.h(x, y)
        z = h + zl + lift
        for k in range(len(z)):
            hit = fruit_bvh.ray_cast(Vector((x[k], y[k], h[k] - 0.02)), Vector((0, 0, 1)), 1.5)
            if hit[0] is None:
                continue
            zb = hit[0].z
            top = fruit_bvh.ray_cast(Vector((x[k], y[k], 2.0)), Vector((0, 0, -1)), 3.0)[0]
            zt = top.z if top is not None else zb
            if zb - 0.004 < z[k] < zt + 0.004:
                z[k] = max(h[k] + 0.001, zb - 0.004) if (z[k] - zb) < (zt - z[k]) + 0.03 else zt + 0.004
        z = np.maximum(z, 0.002)
        set_verts(me, np.stack([x, y, z], 1))
        ob = link(bpy.data.objects.new("g_tmp", me), pile)
        return ob, len(BVHTree.FromPolygons([vv.co for vv in me.vertices],
                                            [p.vertices[:] for p in me.polygons]).overlap(fruit_bvh))

    def lay(pool, n, r_lo, r_hi, squash, scale=(0.9, 1.15), spread=0.35, lift=0.0, cap=None, a0=None, f=1.0):
        a0 = rnd.uniform(0, 6.283) if a0 is None else a0
        for i in range(n):
            part = pool[i % len(pool)][0]
            a = a0 + 2 * math.pi * (i + rnd.uniform(-0.35, 0.35)) / n
            r = rnd.uniform(r_lo, r_hi)
            best = None
            for t in range(5):           # retry a few headings if the leaf would cut through produce
                yaw = a + rnd.uniform(-spread, spread)
                ob, ov = drape(part, r * math.cos(a), r * math.sin(a), yaw, rnd.uniform(*scale),
                               rnd.uniform(*squash), rnd.uniform(-0.35, 0.35), lift, cap, f)
                if best is None or ov < best[1]:
                    if best is not None:
                        bpy.data.meshes.remove(best[0].data)
                    best = (ob, ov)
                else:
                    bpy.data.meshes.remove(ob.data)
                if best[1] == 0:
                    break
            greens.append(best[0])

    ferns = sorted(leaves["fern_02"], key=lambda p: -p[1])
    rnd.shuffle(ferns)
    long_ferns = [p for p in ferns if p[1] >= 0.36]
    short_ferns = [p for p in ferns if p[1] < 0.36]
    cal = sorted(leaves["calathea_orbifolia_01"], key=lambda p: -p[1])
    ant = sorted(leaves["anthurium_botany_01"], key=lambda p: -p[1])
    # The heap's volume is built from layers of leaves draped over scaled copies of the mound
    # (f = fraction of the mound height), so gaps in the top layer show shaded leaves underneath.
    # bottom layer + skirt: long fronds from the foot of the heap spilling onto the ground
    lay(long_ferns, 44, 0.3, 0.56, (0.35, 0.5), spread=0.6, f=0.42)
    lay(ant, 7, 0.3, 0.5, (0.3, 0.4), spread=0.6, f=0.42)
    lay(cal, 6, 0.3, 0.5, (0.3, 0.45), scale=(1.0, 1.2), spread=0.6, f=0.42)
    # middle layer
    lay(ferns, 60, 0.18, 0.46, (0.3, 0.45), spread=0.6, f=0.72)
    lay(cal, 14, 0.2, 0.45, (0.3, 0.45), scale=(1.0, 1.2), spread=0.6, f=0.72)
    # top layer
    lay(ferns[::-1], 60, 0.12, 0.44, (0.28, 0.4), spread=0.6, lift=0.004)
    # under the heap: flattened fronds (pressed by the produce)
    lay(short_ferns, 12, 0.0, 0.14, (0.15, 0.2), spread=1.0, cap=0.03)
    # broad leaves tucked around the heap on top of the ferns
    lay(cal, 16, 0.2, 0.42, (0.3, 0.45), scale=(1.0, 1.2), spread=0.6, lift=0.01)
    lay(ant, 5, 0.24, 0.42, (0.3, 0.4), scale=(0.95, 1.1), spread=0.6, lift=0.014)

    # optional leaf-litter core deep inside the heap (only glimpsed, in shade, through gaps in the fronds)
    litter = None
    if args.litter:
        litter_me = mound.mesh("litter", offset=-0.02, n_r=10, n_a=36, r_max=0.69, f=0.36)
        uv = litter_me.uv_layers.new(name="UVMap")
        for li, lp in enumerate(litter_me.loops):
            co = litter_me.vertices[lp.vertex_index].co
            uv.data[li].uv = (co.x / LITTER_M + 0.5, co.y / LITTER_M + 0.5)
        litter_me.materials.append(lit_mat)
        litter_me.shade_smooth()
        litter = link(bpy.data.objects.new("litter", litter_me), pile)

    # ---- naming, origins, sidecar -------------------------------------------------------------
    items.sort(key=lambda o: -o.matrix_world.translation.z)    # item_00 = top of the heap (eaten first)
    for i, o in enumerate(items):
        o.name = f"item_{i:02d}"
    # greenery joined per material (few draw calls); only the produce needs to be separate nodes
    greens_all = [litter] if litter else []
    groups = [[o for o in greens if o.data.materials[0] == mats[m]]
              for m in ("fern_02", "calathea_orbifolia_01", "anthurium_botany_01")]
    for grp in groups:
        if not grp:
            continue
        bpy.ops.object.select_all(action='DESELECT')
        for o in grp:
            o.select_set(True)
        bpy.context.view_layer.objects.active = grp[0]
        bpy.ops.object.join()
        greens_all.append(bpy.context.view_layer.objects.active)
    for i, o in enumerate(greens_all):
        o.name = f"leaf_{i:02d}"
        o.data.name = f"leaf_{i:02d}"

    allv = np.concatenate([obj_world_verts(o) for o in items + greens_all])
    foot = float(np.hypot(allv[:, 0], allv[:, 1]).max())
    height = float(allv[:, 2].max())
    tris = sum(tri_count(o.data) for o in items + greens_all)
    log(f"pile: footprint radius {foot:.2f} m, height {height:.2f} m, rendered tris {tris}")
    side = {"items": [], "radius": round(foot, 3), "height": round(height, 3)}
    for o in items:
        t = o.matrix_world.translation
        r = float(np.linalg.norm(verts_np(o.data), axis=1).max()) * o.scale.x
        side["items"].append({"name": o.name, "x": round(t.x, 4), "y": round(t.z, 4), "z": round(-t.y, 4),
                              "r": round(r, 3), "kind": o["kind"]})

    # ---- export ------------------------------------------------------------------------------
    for o in list(scene.objects):
        if o not in items and o not in greens_all:
            o.hide_render = True
    bpy.ops.object.select_all(action='DESELECT')
    for o in items + greens_all:
        o.select_set(True)
    raw = os.path.join(work, "food_raw.glb")
    bpy.ops.export_scene.gltf(filepath=raw, export_format='GLB', use_selection=True, export_apply=True,
                              export_yup=True, export_image_format='AUTO', export_animations=False,
                              export_materials='EXPORT', export_cameras=False, export_lights=False,
                              export_extras=False)
    log("raw export", raw, os.path.getsize(raw))
    if args.blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.blend))

    out = os.path.abspath(args.out)
    if args.no_optimize:
        shutil.copy(raw, out)
    else:
        optimize(raw, out, work)
    with open(json_out, "w") as fh:
        json.dump(side, fh, indent=1)
    log("wrote", out, os.path.getsize(out), "bytes;", json_out)


def optimize(raw, out, work):
    """gltf-transform: dedup -> prune -> resize 1024 -> webp -> draco (node names are preserved)."""
    steps = [("dedup", []), ("prune", []), ("resize", ["--width", "1024", "--height", "1024"]),
             ("webp", ["--quality", "82"]), ("draco", [])]
    cur = raw
    for i, (cmd, extra) in enumerate(steps):
        nxt = out if i == len(steps) - 1 else os.path.join(work, f"food_{i}_{cmd}.glb")
        subprocess.run(["npx", "-y", "@gltf-transform/cli", cmd, cur, nxt] + extra, check=True)
        cur = nxt


if __name__ == "__main__":
    main()
