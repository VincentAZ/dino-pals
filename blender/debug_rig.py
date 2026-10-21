"""Debug render: armature bones drawn as coloured sticks over a semi-transparent dinosaur, side + front views."""
import bpy, sys, math
from mathutils import Vector
argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
sc = bpy.context.scene
arm = bpy.data.objects["Armature"]
body = [o for o in bpy.data.objects if o.type == 'MESH' and o.parent == arm][0]
# ghost material
for m in body.data.materials:
    if not m or not m.use_nodes: continue
    b = [n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'][0]
    for l in list(b.inputs['Alpha'].links): m.node_tree.links.remove(l)
    b.inputs['Alpha'].default_value = 0.35
    m.surface_render_method = 'BLENDED'
cols = {"thigh": (1, 0.1, 0.1), "shin": (0.1, 0.9, 0.1), "foot": (0.1, 0.3, 1), "toe": (1, 1, 0), "spine": (1, 0.6, 0), "neck": (0.8, 0, 0.8), "head": (0, 1, 1), "jaw": (1, 1, 1), "tail": (0.6, 0.4, 0.2), "root": (1, 1, 1), "snout": (1, 1, 0), "wing": (1, 0, 0.5), "flip": (0, 0.5, 1)}
mats = {}
for k, c in cols.items():
    m = bpy.data.materials.new("dbg_" + k); m.use_nodes = True
    e = m.node_tree.nodes.new('ShaderNodeEmission'); e.inputs[0].default_value = (*c, 1); e.inputs[1].default_value = 3
    out = m.node_tree.nodes['Material Output']; m.node_tree.links.new(e.outputs[0], out.inputs[0]); mats[k] = m
L = max(body.dimensions)
for b in arm.data.bones:
    h = arm.matrix_world @ b.head_local; t = arm.matrix_world @ b.tail_local
    d = t - h; n = d.length
    if n < 1e-5: continue
    bpy.ops.mesh.primitive_cylinder_add(radius=L * 0.006, depth=n, location=(h + t) / 2)
    cyl = bpy.context.active_object; cyl.rotation_mode = 'QUATERNION'; cyl.rotation_quaternion = d.to_track_quat('Z', 'Y')
    key = next((k for k in cols if b.name.startswith(k)), "root"); cyl.data.materials.append(mats[key])
    bpy.ops.mesh.primitive_uv_sphere_add(radius=L * 0.012, location=h); s = bpy.context.active_object; s.data.materials.append(mats[key])
sc.render.engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items] else 'BLENDER_EEVEE'
sc.render.resolution_x = 900; sc.render.resolution_y = 600
w = bpy.data.worlds.new("W"); sc.world = w; w.use_nodes = True; w.node_tree.nodes["Background"].inputs[1].default_value = 1.0
cam = bpy.data.objects.new("C", bpy.data.cameras.new("C")); sc.collection.objects.link(cam); sc.camera = cam
cam.data.type = 'ORTHO'
bb = [body.matrix_world @ Vector(c) for c in body.bound_box]
mn = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb))); mx = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
ctr = (mn + mx) / 2; ext = max(mx - mn)
for name, d in (("side", Vector((1, 0, 0))), ("front", Vector((0, -1, 0))), ("top", Vector((0, 0, 1)))):
    cam.location = ctr + d * ext * 2; cam.rotation_euler = (-d).to_track_quat('-Z', 'Y' if name != "top" else 'Y').to_euler()
    cam.data.ortho_scale = ext * 1.1
    sc.render.filepath = f"{OUT}_{name}.png"; bpy.ops.render.render(write_still=True)
print("DEBUGRIG done")
