"""Deformation stress test: bend legs, neck, tail and jaw hard and render textured views."""
import bpy, sys, math
from mathutils import Vector, Quaternion
argv = sys.argv[sys.argv.index("--") + 1:]; OUT = argv[0]
sc = bpy.context.scene
arm = bpy.data.objects["Armature"]; body = [o for o in bpy.data.objects if o.type == 'MESH' and o.parent == arm][0]
if arm.animation_data:
    arm.animation_data.action = None
    for tr in arm.animation_data.nla_tracks: tr.mute = True
PB = arm.pose.bones
def rw(pb, axis, deg):
    ax = {'X': Vector((1, 0, 0)), 'Y': Vector((0, 1, 0)), 'Z': Vector((0, 0, 1))}[axis]
    Mb = pb.bone.matrix_local.to_3x3()
    q = (Mb.inverted() @ Quaternion(ax, math.radians(deg)).to_matrix() @ Mb).to_quaternion()
    pb.rotation_mode = 'QUATERNION'; pb.rotation_quaternion = (pb.rotation_quaternion.to_matrix() @ q.to_matrix()).to_quaternion()
for pb in PB: pb.rotation_mode = 'QUATERNION'; pb.rotation_quaternion = (1, 0, 0, 0)
legs = sorted({n.split('.')[1] for n in PB.keys() if n.startswith('thigh.')})
for i, t in enumerate(legs):
    s = 1 if i % 2 == 0 else -1
    rw(PB[f'thigh.{t}'], 'X', -28 * s); rw(PB[f'shin.{t}'], 'X', 35 if s > 0 else 10); rw(PB[f'foot.{t}'], 'X', -20 if s > 0 else 5)
for n in PB.keys():
    if n.startswith('tail'): rw(PB[n], 'Z', 9)
    if n.startswith('neck'): rw(PB[n], 'Z', -10); rw(PB[n], 'X', 6)
if 'jaw' in PB: rw(PB['jaw'], 'X', 28)
bpy.context.view_layer.update()
sc.render.engine = 'CYCLES'; sc.cycles.device = 'GPU'; sc.cycles.samples = 24; sc.cycles.use_denoising = True
prefs = bpy.context.preferences.addons['cycles'].preferences; prefs.compute_device_type = 'OPTIX'; prefs.refresh_devices()
for d in prefs.devices: d.use = (d.type == 'OPTIX')
sc.render.resolution_x = 640; sc.render.resolution_y = 420
w = bpy.data.worlds.new("W"); sc.world = w; w.use_nodes = True; w.node_tree.nodes["Background"].inputs[0].default_value = (0.6, 0.7, 0.85, 1); w.node_tree.nodes["Background"].inputs[1].default_value = 0.8
sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", 'SUN')); sc.collection.objects.link(sun); sun.data.energy = 4; sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(35))
bb = [body.matrix_world @ Vector(c) for c in body.bound_box]
mn = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb))); mx = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
ctr = (mn + mx) / 2; R = (mx - mn).length / 2
cam = bpy.data.objects.new("C", bpy.data.cameras.new("C")); sc.collection.objects.link(cam); sc.camera = cam; cam.data.lens = 40; cam.data.clip_end = R * 20
for name, az, el, k in (("side", 180, 4, 2.2), ("q", -130, 14, 1.6)):
    a, e = math.radians(az), math.radians(el)
    p = ctr + Vector((math.cos(a) * math.cos(e), math.sin(a) * math.cos(e), math.sin(e))) * R * k
    cam.location = p; cam.rotation_euler = (ctr - p).to_track_quat('-Z', 'Y').to_euler()
    sc.render.filepath = f"{OUT}_{name}.png"; bpy.ops.render.render(write_still=True)
print("POSETEST done")
