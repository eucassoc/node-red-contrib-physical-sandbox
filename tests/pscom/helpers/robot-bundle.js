// A small bundle (the JSON robot.js reads) and its binary meshes, for the robot and viewer tests.

/** One triangle in the RBM1 format (tools/web_mesh.py), with normals. */
export function triangleMesh() {
  const vertexCount = 3;
  const indexCount = 3;
  const buffer = new ArrayBuffer(16 + vertexCount * 12 * 2 + indexCount * 4);
  const bytes = new Uint8Array(buffer);
  bytes.set([...'RBM1'].map((c) => c.charCodeAt(0)), 0);
  const view = new DataView(buffer);
  view.setUint32(4, 2, true); // HAS_NORMAL
  view.setUint32(8, vertexCount, true);
  view.setUint32(12, indexCount, true);
  new Float32Array(buffer, 16, 9).set([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0.2]);
  new Float32Array(buffer, 16 + 36, 9).set([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  new Uint32Array(buffer, 16 + 72, 3).set([0, 1, 2]);
  return buffer;
}

/** An arm of a revolute joint, a fixed tool link and a prismatic finger; a mesh on each moving link. */
export function armBundle() {
  const visual = (mesh) => ({ mesh, origin: { xyz: [0, 0, 0], rpy: [0, 0, 0] } });
  return {
    rootLink: 'base',
    links: {
      base: { visuals: [visual('meshes/part.bin')] },
      link1: { visuals: [visual('meshes/part.bin')] },
      tool0: { visuals: [] },
      finger: { visuals: [visual('meshes/part.bin')] },
    },
    joints: [
      { name: 'shoulder', type: 'revolute', parent: 'base', child: 'link1', lower: -1, upper: 1,
        origin: { xyz: [0, 0, 0.1], rpy: [0, 0, 0] }, axis: [0, 0, 1] },
      { name: 'to_tool0', type: 'fixed', parent: 'link1', child: 'tool0',
        origin: { xyz: [0.2, 0, 0], rpy: [0, 0, 0] }, axis: [0, 0, 1] },
      { name: 'gripper', type: 'prismatic', parent: 'tool0', child: 'finger', lower: 0, upper: 0.04,
        origin: { xyz: [0, 0, 0], rpy: [0, 0, 0] }, axis: [0, 1, 0] },
    ],
    chains: [{ name: 'arm', baseLink: 'base', tipLink: 'tool0', joints: ['shoulder'] }],
    locomotion: 'Static',
  };
}

const json = (body) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body });

/**
 * A fetch answering the catalog's addresses of `physical-sandbox/arm:1`: its manifest (bundle at
 * `bundle.json`), the bundle, and the mesh. `missingMesh` answers 404 for the mesh.
 */
export function catalogFetch({ bundle = armBundle(), missingMesh = false, calls = [] } = {}) {
  const root = '/api/catalog/physical-sandbox/arm/1';
  return async (url) => {
    calls.push(url);
    if (url === `${root}/manifest`) return json({ bundle: 'bundle.json', kind: 'machine' });
    if (url === `${root}/files/bundle.json`) return json(bundle);
    if (url === `${root}/files/meshes/part.bin` && !missingMesh) {
      return { ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => triangleMesh() };
    }
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
  };
}
