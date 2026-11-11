// Copied from app/src/robot-build.js of ps-com (commit 615120e).
// Copied 2026-11-11, Apache-2.0 by permission of the owner (2026-11-11).
// Do not edit here: tools/check-pscom-copy.mjs compares this file with its source.
import * as THREE from 'three';
import { tError } from './i18n.js';

/*
 * The bundle (the JSON that came out of a URDF) and its meshes, built into three objects with
 * joint setters. **Pure of where the bundle lives**: the caller says where each mesh is served
 * and passes the fetch. robot.js (the headset app) and the catalog's machine page
 * (lp/assets/catalog/viewer.js, which gets a copy of this file at build: tools/build.sh
 * CATALOG_APP_FILES) both build machines through this one file.
 *
 * Imports only three and i18n.js (which imports nothing), so the copy needs nothing else.
 */

/**
 * Builds the joint chain from the JSON that came out of a URDF.
 *
 * Coordinates stay as ROS gives them (right-handed, Z-up, metres, radians). three.js is
 * right-handed too, so ROS to three is a single rotation that turns Z-up into Y-up. It is a
 * pure rotation with determinant +1, so none of the mirroring and winding-order flips the
 * Unity side needed happen here. It is applied once, at the root, and nothing inside is touched.
 */

/**
 * ROS (Z-up, X forward) to three (Y-up, -Z forward), as a quaternion.
 *
 *   ROS +X (forward) becomes three -Z  ... three.js's default front
 *   ROS +Y (left)    becomes three -X  ... three's +X is to the right
 *   ROS +Z (up)      becomes three +Y
 *
 * A pure rotation with determinant +1, so nothing is mirrored.
 *
 * This used to be -90 degrees about X alone. Up and down were right, but ROS +X landed on
 * three +X (to the right), **putting the robot's front along +X**. Movement was along +Z,
 * so the robot translated sideways while facing across its path. Align the front with
 * three's convention, -Z.
 *
 * **Exported so the device layer uses this one and not a copy of it** (devices/view.js).
 * There are already two places that convert coordinates — roundtrip.js and twin_align.py —
 * and a third would be one too many.
 */
export function rosToThree() {
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(
      new THREE.Vector3(0, 0, -1),   // Where ROS +X lands
      new THREE.Vector3(-1, 0, 0),   // Where ROS +Y lands
      new THREE.Vector3(0, 1, 0),    // Where ROS +Z lands
    ),
  );
}

/** URDF rpy (fixed-axis roll-pitch-yaw) to a quaternion. R = Rz(yaw)*Ry(pitch)*Rx(roll). */
function quaternionFromRpy([roll, pitch, yaw]) {
  const q = new THREE.Quaternion();
  const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), roll);
  const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), pitch);
  const qz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), yaw);

  return q.copy(qz).multiply(qy).multiply(qx);
}

// Flags from web_mesh.py
const HAS_UV = 1;
const HAS_NORMAL = 2;

/**
 * Turn a binary mesh into a BufferGeometry. For the format, see tools/web_mesh.py.
 *
 * **This is where the speed is.** Parsing OBJ text with OBJLoader used to account for 95% of
 * the time it took to place one robot, and the single largest mesh froze the view for 700 ms
 * on its own. A typed array maps straight onto an ArrayBuffer, so there is no parsing and no
 * copying (0.2 ms, measured).
 */
function geometryFromBinary(buffer, url) {
  const header = new DataView(buffer);

  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
  if (magic !== 'RBM1') throw tError('err.badMeshFormat', { url, magic });

  const flags = header.getUint32(4, true);
  const vertexCount = header.getUint32(8, true);
  const indexCount = header.getUint32(12, true);

  const geometry = new THREE.BufferGeometry();
  let offset = 16;

  geometry.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array(buffer, offset, vertexCount * 3), 3));
  offset += vertexCount * 12;

  if (flags & HAS_NORMAL) {
    geometry.setAttribute('normal', new THREE.BufferAttribute(
      new Float32Array(buffer, offset, vertexCount * 3), 3));
    offset += vertexCount * 12;
  }

  if (flags & HAS_UV) {
    geometry.setAttribute('uv', new THREE.BufferAttribute(
      new Float32Array(buffer, offset, vertexCount * 2), 2));
    offset += vertexCount * 8;
  }

  geometry.setIndex(new THREE.BufferAttribute(
    new Uint32Array(buffer, offset, indexCount), 1));

  // Only meshes converted from DAE / STL have no normals. They are indexed, so they come out smooth.
  if (!(flags & HAS_NORMAL)) geometry.computeVertexNormals();

  return geometry;
}

export class Robot {
  constructor(data) {
    this.data = data;

    /** The container things are assembled into, still in ROS coordinates. */
    this.rosRoot = new THREE.Group();

    /** The one place ROS becomes three, for a robot. See rosToThree above. */
    this.object = new THREE.Group();
    this.object.quaternion.copy(rosToThree());
    this.object.add(this.rosRoot);

    this.linkGroups = new Map();
    this.jointNodes = new Map();

    /** The hand hung off this robot's mount (attachHand), or null. */
    this.hand = null;

    /** Whether a suction hand holds on (gripper.js's applyLevel); undefined until it is set. */
    this.suction = undefined;

    this.#buildTree();
  }

  /**
   * Hang a hand (an end effector, loaded as a Robot of its own) off one of this robot's links.
   *
   * **Its ROS root goes under the link, not its `object`**: `object` carries the ROS-to-three
   * turn and the ground lift, which this robot's root already applies once. The hand's joints and
   * links join this robot's, so setJoint, actuatedJoints (and with it what the chain says of the
   * robot) and a tool point on a hand link all see them. A hand already hanging here comes off
   * first. A name the robot already uses is refused before anything changes.
   *
   * @param {Robot} hand
   * @param {string} link  the link it bolts onto (a product's arm.mount.link)
   */
  attachHand(hand, link) {
    const mount = this.linkGroups.get(link);
    if (!mount) throw new Error(`no link ${link} to hang a hand on`);

    const own = (map, ofHand) => (name) => map.has(name) && !ofHand?.has(name);
    const jointClash = [...hand.jointNodes.keys()].find(own(this.jointNodes, this.hand?.jointNodes));
    if (jointClash !== undefined) throw new Error(`the hand's joint ${jointClash} is already the robot's`);
    const linkClash = [...hand.linkGroups.keys()].find(own(this.linkGroups, this.hand?.linkGroups));
    if (linkClash !== undefined) throw new Error(`the hand's link ${linkClash} is already the robot's`);

    this.detachHand();
    mount.add(hand.rosRoot);
    for (const [name, joint] of hand.jointNodes) this.jointNodes.set(name, joint);
    for (const [name, group] of hand.linkGroups) this.linkGroups.set(name, group);
    this.hand = hand;
  }

  /** Take the hand off: its drawing, its joints and its links, and free its meshes. */
  detachHand() {
    const hand = this.hand;
    if (!hand) return;
    hand.rosRoot.removeFromParent();
    for (const name of hand.jointNodes.keys()) this.jointNodes.delete(name);
    for (const name of hand.linkGroups.keys()) this.linkGroups.delete(name);
    this.hand = null;
    // Suction was the hand's: the next hand starts with none said
    this.suction = undefined;

    // A hand is its own loadRobot's, with its own geometry and material caches, so nothing of
    // this robot's shares what is freed here. Each once, however many meshes share it
    const freed = new Set();
    const free = (thing) => {
      if (!thing || freed.has(thing)) return;
      freed.add(thing);
      thing.dispose();
    };
    hand.rosRoot.traverse((node) => {
      free(node.geometry);
      for (const material of [node.material].flat()) {
        free(material?.map);
        free(material);
      }
    });
  }

  #buildTree() {
    for (const name of Object.keys(this.data.links)) {
      const group = new THREE.Group();
      group.name = name;
      this.linkGroups.set(name, group);
    }

    this.rosRoot.add(this.linkGroups.get(this.data.rootLink));

    for (const joint of this.data.joints) {
      const parent = this.linkGroups.get(joint.parent);
      const child = this.linkGroups.get(joint.child);
      if (!parent || !child) continue;

      parent.add(child);

      child.position.fromArray(joint.origin.xyz);
      child.quaternion.copy(quaternionFromRpy(joint.origin.rpy));

      if (joint.type !== 'fixed') {
        this.jointNodes.set(joint.name, {
          spec: joint,
          node: child,
          originQuaternion: child.quaternion.clone(),
          originPosition: child.position.clone(),
          axis: new THREE.Vector3().fromArray(joint.axis).normalize(),
          value: 0,
        });
      }
    }
  }

  /** The movable joints. Those in a chain come first (the order the sliders use). */
  actuatedJoints() {
    const inChain = new Set(this.data.chains.flatMap((c) => c.joints));
    // A joint that follows another (URDF mimic) has no handle of its own: it goes where
    // the joint it follows goes.
    const all = [...this.jointNodes.values()].filter((j) => !j.spec.mimic);

    return [
      ...all.filter((j) => inChain.has(j.spec.name)),
      ...all.filter((j) => !inChain.has(j.spec.name)),
    ];
  }

  /**
   * Apply joint variables and update the pose. Clamped to each joint's limits.
   * The local pose is origin * motion(q) — the URDF chain rule as written.
   */
  setJoint(name, value) {
    const joint = this.jointNodes.get(name);
    if (!joint) return;

    this.#pose(joint, value);

    // Whatever follows this joint (URDF mimic) moves with it, each within its own limits
    for (const follower of this.jointNodes.values()) {
      const mimic = follower.spec.mimic;
      if (mimic?.joint === name) this.#pose(follower, joint.value * mimic.multiplier + mimic.offset);
    }
  }

  #pose(joint, value) {
    const { lower, upper, type } = joint.spec;
    if (type === 'revolute' || type === 'prismatic') {
      value = Math.min(upper, Math.max(lower, value));
    }
    joint.value = value;

    if (type === 'prismatic') {
      joint.node.position
        .copy(joint.originPosition)
        .add(joint.axis.clone().multiplyScalar(value).applyQuaternion(joint.originQuaternion));
      return;
    }

    const motion = new THREE.Quaternion().setFromAxisAngle(joint.axis, value);
    joint.node.quaternion.copy(joint.originQuaternion).multiply(motion);
  }

  resetJoints() {
    for (const joint of this.jointNodes.values()) this.setJoint(joint.spec.name, 0);
  }

  /**
   * Lift the robot until its lowest point sits on the floor (y = 0).
   *
   * A URDF's origin sits somewhere different on every robot. G1's is the pelvis, so placed as
   * it comes its feet sink 0.79 m into the floor. An arm's origin is its base, so the offset
   * is near zero. Measured once, in the rest pose, and never moved again — shifting up and
   * down every time a joint moves is unsettling.
   */
  alignToGround() {
    this.object.position.y = 0;
    this.object.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(this.object);
    if (!box.isEmpty()) this.object.position.y = -box.min.y;

    return this.object.position.y;
  }

  /** Height from the feet, and the spread on the floor. Used by the placement preview. */
  measure() {
    const box = new THREE.Box3().setFromObject(this.object);
    const size = new THREE.Vector3();
    box.getSize(size);

    return { height: size.y, radius: Math.max(size.x, size.z) / 2, box };
  }
}


/**
 * Build a robot from its bundle: every visual's mesh (and texture) fetched once, hung on its
 * link, the joints at zero and the whole lifted onto the floor.
 * OBJ vertices stay in ROS coordinates. The root's rotation takes care of all of it at once.
 *
 * @param {object} data  the bundle
 * @param {{
 *   meshUrlOf: (relative: string) => string,   where a file the bundle names is served (may throw: that visual is skipped)
 *   fetchImpl?: (url: string) => Promise<Response>,
 *   onProgress?: (done: number, all: number) => void,
 *   label?: string,                             what the console warnings name
 * }} options
 * @returns {Promise<Robot>}
 */
export async function buildRobot(data, { meshUrlOf, fetchImpl = (url) => fetch(url), onProgress, label = 'robot' }) {
  const robot = new Robot(data);

  // Raise metalness too far and it leans on an environment map, sinking to black in AR's real
  // surroundings. Keep it low, closer to how painted machinery looks.
  const plain = new THREE.MeshStandardMaterial({
    color: 0xc6cad0,
    metalness: 0.15,
    roughness: 0.62,
  });

  const textureLoader = new THREE.TextureLoader();
  /** Texture URL to material. The table that stops the same image being loaded twice. */
  const skins = new Map();

  /**
   * The material for a visual. With no texture given, the old flat colour.
   *
   * DeliveryRobot's body, four casters and two drive wheels — seven visuals — share one
   * texture. Done naively that loads the same PNG seven times, so keep them in a table keyed
   * by URL and reuse them.
   */
  async function materialFor(visual) {
    if (!visual.texture) return plain;

    const url = meshUrlOf(visual.texture);
    const cached = skins.get(url);
    if (cached) return cached;

    const map = await textureLoader.loadAsync(url);
    // A colour texture is sRGB. Without saying so it washes out light and shallow.
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 8;

    const material = new THREE.MeshStandardMaterial({
      map,
      metalness: 0.05,
      roughness: 0.75,
    });

    skins.set(url, material);
    return material;
  }

  const jobs = [];
  for (const [linkName, link] of Object.entries(data.links)) {
    for (const visual of link.visuals) {
      jobs.push({ linkName, visual });
    }
  }

  /**
   * URL to geometry. **The same mesh is never loaded twice.**
   * go2's four legs share the same hip / thigh / calf, so there are 17 visuals but only 7
   * distinct meshes. Done naively that is 10 loads wasted.
   *
   * The table is per robot. Sharing it between placed robots would let disposing of one
   * destroy geometry the other is still using.
   */
  const shapes = new Map();

  async function geometryFor(url) {
    const cached = shapes.get(url);
    if (cached) return cached;

    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

    const geometry = geometryFromBinary(await response.arrayBuffer(), url);
    shapes.set(url, geometry);
    return geometry;
  }

  let done = 0;
  let failed = 0;

  for (const { linkName, visual } of jobs) {
    let url = visual.mesh;
    try {
      // Under the catalog version: meshes are large, and a version's files never change. A path
      // that climbs out of the version (`..`) is refused here, and that visual is skipped
      url = meshUrlOf(visual.mesh);
      const mesh = new THREE.Mesh(await geometryFor(url), await materialFor(visual));

      mesh.position.fromArray(visual.origin.xyz);
      mesh.quaternion.copy(quaternionFromRpy(visual.origin.rpy));

      robot.linkGroups.get(linkName)?.add(mesh);
    } catch (error) {
      failed += 1;
      console.warn(`Could not load a mesh: ${url}`, error);
    }

    done += 1;
    onProgress?.(done, jobs.length);
  }

  // **Loading not one of them counts as failure.**
  // Letting it pass quietly means a robot with no body counts as "placed". All anyone sees is
  // "I placed it, loading finished, and nothing appeared", with not one clue as to why. This
  // actually happened when an old cache was picked up.
  if (jobs.length > 0 && failed === jobs.length) {
    throw tError('err.noMeshLoaded', { jobs: jobs.length });
  }

  if (failed > 0) {
    console.warn(`${label}: could not load ${failed} of ${jobs.length} meshes`);
  }

  robot.resetJoints();
  robot.alignToGround();
  return robot;
}
