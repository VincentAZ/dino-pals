"""Gait-extreme deformation test: one leg far forward + raised knee, other far back; render side & 3/4."""
import bpy, sys, math
from mathutils import Vector, Quaternion
argv = sys.argv[sys.argv.index("--") + 1:]; OUT = argv[0]
exec(open(__file__.replace("pose_walk.py", "pose_test.py")).read().split("for pb in PB: pb.rotation_mode")[0])
for pb in PB: pb.rotation_mode = 'QUATERNION'; pb.rotation_quaternion = (1, 0, 0, 0)
legs = sorted({n.split('.')[1] for n in PB.keys() if n.startswith('thigh.')})
for i, t in enumerate(legs):
    fwd = (i % 2 == 0) != (t.startswith('F') and len(legs) == 4 and False)
    if t in ('L', 'BL', 'FR'):
        rw(PB[f'thigh.{t}'], 'X', -34); rw(PB[f'shin.{t}'], 'X', 40); rw(PB[f'foot.{t}'], 'X', -20)
    else:
        rw(PB[f'thigh.{t}'], 'X', 26); rw(PB[f'shin.{t}'], 'X', -6); rw(PB[f'foot.{t}'], 'X', 18)
bpy.context.view_layer.update()
exec("sc = bpy.context.scene\n" + open(__file__.replace("pose_walk.py", "pose_test.py")).read().split("bpy.context.view_layer.update()\n", 1)[1].replace("POSETEST", "POSEWALK"))
