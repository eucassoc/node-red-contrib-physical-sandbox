# Reference forward kinematics of so101 with MuJoCo, made once for tests/fixtures/so101-bundle.json
# (forwardReference): the position of gripper_frame_link in base_link's frame for a few joint sets.
# Not run by the tests. Run with psbx's Python, which has mujoco:
#   ~/work/physical-sandbox/.venv/bin/python -I tests/fixtures/so101-fk-reference.py \
#     ~/.cache/physical-sandbox/catalog/physical-sandbox/so101/1/so101.urdf
import json, sys, xml.etree.ElementTree as ET
import mujoco, numpy as np
urdf = sys.argv[1]
tree = ET.parse(urdf); root = tree.getroot()
for link in root.findall('link'):
    for tag in ('visual', 'collision'):
        for e in link.findall(tag): link.remove(e)
mj = ET.SubElement(root, 'mujoco'); ET.SubElement(mj, 'compiler', fusestatic='false', discardvisual='false')
model = mujoco.MjModel.from_xml_string(ET.tostring(root, encoding='unicode'))
data = mujoco.MjData(model)
names = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll']
sets = [
    {n: 0.0 for n in names},
    {'shoulder_pan': 0.5, 'shoulder_lift': -0.8, 'elbow_flex': 1.0, 'wrist_flex': 0.3, 'wrist_roll': -1.2},
    {'shoulder_pan': -1.2, 'shoulder_lift': 1.1, 'elbow_flex': -1.4, 'wrist_flex': -1.0, 'wrist_roll': 2.0},
    {'shoulder_pan': 1.8, 'shoulder_lift': 0.2, 'elbow_flex': 0.6, 'wrist_flex': 1.5, 'wrist_roll': 0.7},
]
base = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, 'base_link')
tip = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, 'gripper_frame_link')
out = []
for s in sets:
    data.qpos[:] = 0
    for n, v in s.items():
        j = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, n)
        data.qpos[model.jnt_qposadr[j]] = v
    mujoco.mj_kinematics(model, data)
    R = data.xmat[base].reshape(3, 3)
    p = R.T @ (data.xpos[tip] - data.xpos[base])
    out.append({'joints': s, 'tip': [round(float(x), 6) for x in p]})
print(json.dumps({'mujoco': mujoco.__version__, 'base': data.xpos[base].tolist(), 'cases': out}, indent=1))
