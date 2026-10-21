"""Builds food.glb: a mound of fern fronds with fruit on top (origin at ground centre, ~1.5 m wide)."""
import bpy, sys, math, random, os
argv = sys.argv[sys.argv.index("--") + 1:]
FERN, OUT = argv[0], argv[1]
random.seed(7)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=FERN)
ferns = [o for o in bpy.data.objects if o.type == 'MESH']
for o in ferns: o.parent = None
# wire the alpha map if the material lacks it
for m in bpy.data.materials:
    if not m.use_nodes: continue
    nt = m.node_tree; bsdf = [n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'][0]
    if not bsdf.inputs['Alpha'].is_linked:
        d = os.path.dirname(FERN)
        cand = [f for f in os.listdir(os.path.join(d, "textures")) if "alpha" in f.lower()] if os.path.isdir(os.path.join(d, "textures")) else []
        if cand:
            img = bpy.data.images.load(os.path.join(d, "textures", cand[0])); img.colorspace_settings.name = 'Non-Color'
            tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = img; nt.links.new(tex.outputs['Color'], bsdf.inputs['Alpha'])
    m.surface_render_method = 'DITHERED'; m.use_backface_culling = False
# join fern parts into one object
bpy.ops.object.select_all(action='DESELECT')
for o in ferns: o.select_set(True)
bpy.context.view_layer.objects.active = ferns[0]
if len(ferns) > 1: bpy.ops.object.join()
fern = bpy.context.view_layer.objects.active; fern.name = "fern"
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
# size it: fronds ~0.9 m
dims = fern.dimensions; sc = 0.9 / max(dims.x, dims.y)
fern.scale = (sc, sc, sc); bpy.ops.object.transform_apply(scale=True)
pile = []
N = 16
for i in range(N):
    o = fern.copy(); o.data = fern.data; bpy.context.scene.collection.objects.link(o)
    ring = i % 2
    a = i / N * math.pi * 2 + random.random() * 0.4; r = (0.12 if ring == 0 else 0.3) + random.random() * 0.12
    o.location = (math.cos(a) * r, math.sin(a) * r, (0.18 if ring == 0 else 0.04) + random.random() * 0.08)
    o.rotation_euler = (math.radians(-35 + random.random() * 30), math.radians(random.random() * 16 - 8), a + math.pi)
    o.scale = (0.9 + random.random() * 0.5,) * 3
    pile.append(o)
bpy.data.objects.remove(fern)
# mound core (dark leaf-litter sphere so the pile has volume)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.42, segments=24, ring_count=12, location=(0, 0, -0.02))
core = bpy.context.active_object; core.scale = (1.15, 1.15, 0.6); core.name = "mound"
cm = bpy.data.materials.new("litter"); cm.use_nodes = True
b = cm.node_tree.nodes["Principled BSDF"]; b.inputs["Base Color"].default_value = (0.08, 0.12, 0.04, 1); b.inputs["Roughness"].default_value = 1.0
core.data.materials.append(cm); bpy.ops.object.shade_smooth(); pile.append(core)
# fruit: apples/berries with a stem
cols = [(0.48, 0.03, 0.02), (0.6, 0.18, 0.02), (0.16, 0.03, 0.2), (0.25, 0.4, 0.05), (0.5, 0.05, 0.12), (0.62, 0.3, 0.04)]
mats = []
for i, c in enumerate(cols):
    fm = bpy.data.materials.new(f"fruit{i}"); fm.use_nodes = True
    b = fm.node_tree.nodes["Principled BSDF"]; b.inputs["Base Color"].default_value = (*c, 1); b.inputs["Roughness"].default_value = 0.42
    b.inputs["Specular IOR Level"].default_value = 0.4
    mats.append(fm)
stem_m = bpy.data.materials.new("stem"); stem_m.use_nodes = True
stem_m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.2, 0.12, 0.05, 1)
for i in range(12):
    rad = 0.075 + random.random() * 0.055
    a = random.random() * math.pi * 2; r = random.random() * 0.42
    z = 0.26 * math.sqrt(max(0.0, 1 - (r / 0.6) ** 2)) + rad * 0.55 + 0.04
    bpy.ops.mesh.primitive_uv_sphere_add(radius=rad, segments=20, ring_count=12, location=(math.cos(a) * r, math.sin(a) * r, z))
    f = bpy.context.active_object; f.scale = (1, 1, 0.92); f.data.materials.append(mats[i % len(mats)]); bpy.ops.object.shade_smooth()
    f.name = f"fruit{i}"
    bpy.ops.mesh.primitive_cylinder_add(radius=0.008, depth=rad * 0.6, location=(math.cos(a) * r, math.sin(a) * r, z + rad * 0.95))
    st = bpy.context.active_object; st.rotation_euler = (random.random() * 0.4, random.random() * 0.4, 0); st.data.materials.append(stem_m); st.name = f"stem{i}"
    pile += [f, st]
bpy.ops.object.select_all(action='DESELECT')
for o in pile: o.select_set(True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
                          export_image_format='WEBP', export_animations=False, export_materials='EXPORT')
print("FOOD exported", OUT, len(pile), "objects")
