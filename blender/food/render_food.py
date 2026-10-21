"""QA renders of the exported food pile GLB (re-imported, not the build scene).

    blender -b --python blender/food/render_food.py -- --glb web/public/assets/dinos/food.glb \
        --out blender/out/food_ [--samples 192] [--res 1600 900] [--hide 0]

Cycles (OptiX) daylight: sun + physical sky, grass-green ground. Views:
  eye   - eye level 1.2 m, 4 m away
  close - 2 m close-up
  high  - high three-quarter view from 6 m
--hide N hides item_00..item_{N-1} (checks the pile still reads while being eaten).
"""
import bpy, sys, math, argparse
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--glb", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--samples", type=int, default=192)
ap.add_argument("--res", type=int, nargs=2, default=[1600, 900])
ap.add_argument("--hide", type=int, default=0)
ap.add_argument("--views", default="eye,close,high")
ap.add_argument("--sun-az", type=float, default=215.0)
ap.add_argument("--sun-el", type=float, default=38.0)
args = ap.parse_args(argv)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=args.glb)
pile = [o for o in sc.objects if o.type == 'MESH']
for o in pile:
    if o.name.startswith("item_") and int(o.name[5:7]) < args.hide:
        o.hide_render = True
print("imported", len(pile), "meshes:", sorted(o.name for o in pile))

# ground: grass-green, slightly varied so it is not a flat colour card
g = bpy.data.meshes.new("ground")
g.from_pydata([(-60, -60, 0), (60, -60, 0), (60, 60, 0), (-60, 60, 0)], [], [(0, 1, 2, 3)])
go = bpy.data.objects.new("ground", g); sc.collection.objects.link(go)
gm = bpy.data.materials.new("grass"); gm.use_nodes = True
nt = gm.node_tree; b = nt.nodes["Principled BSDF"]
noise = nt.nodes.new("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = 3.0; noise.inputs["Detail"].default_value = 8
ramp = nt.nodes.new("ShaderNodeValToRGB")
ramp.color_ramp.elements[0].color = (0.10, 0.20, 0.035, 1)
ramp.color_ramp.elements[1].color = (0.20, 0.30, 0.06, 1)
nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"]); nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])
b.inputs["Roughness"].default_value = 0.95
bump = nt.nodes.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.3
n2 = nt.nodes.new("ShaderNodeTexNoise"); n2.inputs["Scale"].default_value = 180.0
nt.links.new(n2.outputs["Fac"], bump.inputs["Height"]); nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
g.materials.append(gm)

# sun + sky
az, el = math.radians(args.sun_az), math.radians(args.sun_el)
sun = bpy.data.lights.new("sun", 'SUN'); sun.energy = 3.2; sun.angle = math.radians(1.2)
so = bpy.data.objects.new("sun", sun); sc.collection.objects.link(so)
so.rotation_euler = (math.pi / 2 - el, 0, az + math.pi / 2)
w = bpy.data.worlds.new("sky"); sc.world = w; w.use_nodes = True
wn = w.node_tree
sky = wn.nodes.new("ShaderNodeTexSky")
types = [e.identifier for e in sky.bl_rna.properties["sky_type"].enum_items]
for t in ("MULTIPLE_SCATTERING", "NISHITA", "SINGLE_SCATTERING", "HOSEK_WILKIE"):
    if t in types:
        sky.sky_type = t; break
if hasattr(sky, "sun_elevation"):
    sky.sun_elevation = el; sky.sun_rotation = az
    if hasattr(sky, "sun_disc"): sky.sun_disc = False
wn.links.new(sky.outputs["Color"], wn.nodes["Background"].inputs["Color"])
wn.nodes["Background"].inputs["Strength"].default_value = 0.22

sc.render.engine = 'CYCLES'
prefs = bpy.context.preferences.addons['cycles'].preferences
prefs.compute_device_type = 'OPTIX'; prefs.get_devices()
for d in prefs.devices: d.use = True
sc.cycles.device = 'GPU'; sc.cycles.samples = args.samples; sc.cycles.use_denoising = True
sc.render.resolution_x, sc.render.resolution_y = args.res
sc.view_settings.view_transform = 'AgX'; sc.view_settings.look = 'AgX - Medium High Contrast'
sc.render.film_transparent = False

cam = bpy.data.cameras.new("cam"); co = bpy.data.objects.new("cam", cam); sc.collection.objects.link(co); sc.camera = co
tgt = Vector((0, 0, 0.22))
views = {
    "eye": (Vector((0.0, -4.0, 1.2)), 50),
    "close": (Vector((0.9, -1.75, 0.95)), 45),
    "high": (Vector((-2.9, -2.9, 4.2)), 50),
}
for name in args.views.split(","):
    pos, lens = views[name]
    co.location = pos; cam.lens = lens
    d = tgt - pos
    co.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    sc.render.filepath = f"{args.out}{name}.png"
    bpy.ops.render.render(write_still=True)
    print("wrote", sc.render.filepath)
