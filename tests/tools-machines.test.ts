// The robot tools (src/plugin/tools/machines.ts): ps_machines_list, ps_machine_joints and ps_ik, on a
// small Node-RED whose psbx cache holds so101 and OpenArm (the joints-only fixtures) and whose
// catalog is a fake one, through an MCP client on the plugin's route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHub } from '../src/plugin/hub.js';
import { mountMcp, MCP_ROUTE } from '../src/plugin/mcp.js';
import { readSettings } from '../src/plugin/settings.js';
import { MACHINE_WORDS } from '../src/plugin/tools/machines.js';
import { chainOf, forward } from '../src/core/kinematics.js';
import { fakeClock, fakeRed } from './helpers/fake-red.js';

const CATALOG = 'https://ps.test';
const fixture = (name: string): any => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'));
const so101 = fixture('so101-bundle.json');
const openarm = fixture('openarm-bundle.json');

/** A psbx cache with so101 and OpenArm, each with its `latest` marker and a manifest. */
function cache(): string {
  const root = mkdtempSync(join(tmpdir(), 'ps-tools-machines-cache-'));
  for (const [name, bundle, label] of [['so101', so101, 'SO-101'], ['openarm', openarm, 'OpenArm（双腕）']] as const) {
    const dir = join(root, 'catalog', 'physical-sandbox', name, '1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bundle.json'), JSON.stringify(bundle));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ kind: 'machine', display: { ja: label } }));
    writeFileSync(join(root, 'catalog', 'physical-sandbox', name, 'latest'), '1');
  }
  return root;
}

/** The catalog: an empty search and one robot, `maker/twoarm:2`, whose bundle has no chains but whose manifest's profile has (jointNames). */
async function catalogFetch(url: string): Promise<any> {
  const u = new URL(url);
  const answer = (body: unknown, status = 200) => ({
    ok: status === 200, status, json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer, headers: { get: () => null },
  });
  if (u.pathname === '/api/catalog/search') return answer({ items: [] });
  if (u.pathname === '/api/catalog/maker/twoarm/2/manifest') {
    return answer({ bundle: 'bundle.json', kind: 'machine', profile: { chains: [{ name: 'left', baseLink: 'openarm_left_base_link', tipLink: 'openarm_left_ee_base_link', jointNames: openarm.chains[0].joints }] } });
  }
  if (u.pathname === '/api/catalog/maker/twoarm/2/files/bundle.json') {
    const { chains: _none, ...bundle } = openarm;
    return answer(bundle);
  }
  return answer({}, 404);
}

async function small() {
  const dir = mkdtempSync(join(tmpdir(), 'ps-tools-machines-'));
  const settings = readSettings({ catalogBase: CATALOG, site: 'yard' }, { userDir: dir, env: {} });
  const red = fakeRed({ userDir: dir });
  const hub = createHub(red.RED, { userDir: dir, settings, clock: fakeClock(), pollMs: 0, fetchImpl: catalogFetch as any });
  mountMcp(red.RED, hub, { userDir: dir, cacheRoot: cache(), fetchImpl: catalogFetch as any });
  const url = await red.listen();
  const key = readFileSync(join(dir, 'physical-sandbox', 'mcp-key'), 'utf8').trim();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + MCP_ROUTE), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return { hub, client, async close() { await client.close(); hub.close(); await red.close(); } };
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> => client.callTool({ name, arguments: args });
const json = (answer: any) => {
  assert.equal(answer.isError, undefined, answer.content?.[0]?.text);
  return JSON.parse(answer.content[0].text);
};
const distance = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('the agent sees the three robot tools; ps_ik says it is position only and which frame the target is in', async () => {
  const s = await small();
  try {
    const { tools } = await s.client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ['ps_machines_list', 'ps_machine_joints', 'ps_ik']) assert.ok(byName[name], name);
    assert.match(byName.ps_ik.description ?? '', /position only/i);
    assert.match(byName.ps_ik.description ?? '', /base frame/i);
    const schema: any = byName.ps_ik.inputSchema;
    assert.deepEqual([...schema.required].sort(), ['chain', 'ref', 'target']);
    assert.ok(schema.properties.placement && schema.properties.seed);
  } finally { await s.close(); }
});

test('ps_machines_list: the robots of the cache (and catalog), narrowed by q', async () => {
  const s = await small();
  try {
    const all = json(await call(s.client, 'ps_machines_list'));
    assert.deepEqual(all.machines.map((m: any) => m.ref), ['physical-sandbox/openarm:1', 'physical-sandbox/so101:1']);
    assert.equal(all.offline, false);
    const some = json(await call(s.client, 'ps_machines_list', { q: '双腕' }));
    assert.deepEqual(some.machines.map((m: any) => [m.ref, m.label, m.source]), [['physical-sandbox/openarm:1', 'OpenArm（双腕）', 'cache']]);
    assert.deepEqual(json(await call(s.client, 'ps_machines_list', { q: 'SO1' })).machines.map((m: any) => m.ref), ['physical-sandbox/so101:1']);
  } finally { await s.close(); }
});

test('ps_machine_joints: OpenArm\'s actuated joints (two 7-joint arms and the fingers, the follower marked) and its chains', async () => {
  const s = await small();
  try {
    const got = json(await call(s.client, 'ps_machine_joints', { ref: 'physical-sandbox/openarm:1' }));
    assert.equal(got.product, 'physical-sandbox/openarm:1');
    const names = got.joints.map((j: any) => j.name);
    assert.equal(names.length, 18);
    for (const side of ['left', 'right']) {
      for (let i = 1; i <= 7; i += 1) assert.ok(names.includes(`openarm_${side}_joint${i}`), `${side} ${i}`);
      assert.ok(names.includes(`openarm_${side}_finger_joint1`) && names.includes(`openarm_${side}_finger_joint2`));
    }
    assert.ok(!names.some((n: string) => n.endsWith('mount_joint')), 'no fixed joint');
    const joint1 = got.joints.find((j: any) => j.name === 'openarm_left_joint1');
    assert.deepEqual(joint1, { name: 'openarm_left_joint1', type: 'revolute', lower: -3.4907, upper: 1.3963 });
    const follower = got.joints.find((j: any) => j.name === 'openarm_left_finger_joint2');
    assert.deepEqual(follower.mimic, { joint: 'openarm_left_finger_joint1', multiplier: 1, offset: 0 });
    assert.deepEqual(got.chains.map((c: any) => [c.name, c.baseLink, c.tipLink, c.joints.length]), [
      ['left_arm', 'openarm_left_base_link', 'openarm_left_ee_base_link', 7],
      ['right_arm', 'openarm_right_base_link', 'openarm_right_ee_base_link', 7],
    ]);
    assert.equal(got.device, undefined);
    // a bare name is the cache's latest, as the pane places it
    assert.equal(json(await call(s.client, 'ps_machine_joints', { ref: 'openarm' })).joints.length, 18);
  } finally { await s.close(); }
});

test('ps_machine_joints: a scene device by id, with its pose and the placement ps_ik takes', async () => {
  const s = await small();
  try {
    s.hub.setScene({ devices: [{ id: 'arm1', product: 'physical-sandbox/so101:1', parent: 'site', pose: { xyz: [1, 2, 0], rpy: [0, 0, 1.5] } }] });
    const got = json(await call(s.client, 'ps_machine_joints', { ref: 'arm1' }));
    assert.equal(got.device, 'arm1');
    assert.equal(got.product, 'physical-sandbox/so101:1');
    assert.deepEqual(got.pose, { xyz: [1, 2, 0], rpy: [0, 0, 1.5] });
    assert.deepEqual(got.placement, { xyz: [1, 2, 0], yaw: 1.5 });
    assert.deepEqual(got.chains, [{ name: 'arm', baseLink: 'base_link', tipLink: 'gripper_frame_link', joints: ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll'] }]);
    assert.deepEqual(got.joints.map((j: any) => j.name).sort(), ['elbow_flex', 'gripper', 'shoulder_lift', 'shoulder_pan', 'wrist_flex', 'wrist_roll']);
  } finally { await s.close(); }
});

test('ps_machine_joints: a catalog robot whose bundle has no chains takes them from the manifest\'s profile', async () => {
  const s = await small();
  try {
    const got = json(await call(s.client, 'ps_machine_joints', { ref: 'maker/twoarm:2' }));
    assert.deepEqual(got.chains, [{ name: 'left', baseLink: 'openarm_left_base_link', tipLink: 'openarm_left_ee_base_link', joints: openarm.chains[0].joints }]);
    const solved = json(await call(s.client, 'ps_ik', { ref: 'maker/twoarm:2', chain: 'left', target: { xyz: [0.1, 0.3, 0.1] } }));
    assert.equal(typeof solved.reached, 'boolean');
  } finally { await s.close(); }
});

test('ps_ik: joint angles that reach a target in the robot base frame, and in the site frame with a placement', async () => {
  const s = await small();
  try {
    const chain = chainOf(so101, 'arm');
    const wanted = so101.forwardReference[1].joints;
    const base = forward(so101, chain, wanted).xyz;
    const got = json(await call(s.client, 'ps_ik', { ref: 'physical-sandbox/so101:1', chain: 'arm', target: { xyz: base } }));
    assert.equal(got.reached, true, JSON.stringify(got));
    assert.ok(got.errorM <= 0.002);
    assert.deepEqual(Object.keys(got.joints).sort(), Object.keys(wanted).sort());
    assert.ok(distance(forward(so101, chain, got.joints).xyz, base) <= 0.002);

    // the same point seen from the site, the robot at (1, 2, 0) turned a quarter left
    const site = [1 - base[1], 2 + base[0], base[2]];
    const placed = json(await call(s.client, 'ps_ik', { ref: 'physical-sandbox/so101:1', chain: 'arm', target: { xyz: site }, placement: { xyz: [1, 2, 0], yaw: Math.PI / 2 } }));
    assert.equal(placed.reached, true, JSON.stringify(placed));
    assert.ok(distance(forward(so101, chain, placed.joints).xyz, base) <= 0.002);

    // from a seed already there: the seed itself
    const seeded = json(await call(s.client, 'ps_ik', { ref: 'physical-sandbox/so101:1', chain: 'arm', target: { xyz: base }, seed: wanted }));
    assert.deepEqual(seeded.joints, wanted);
  } finally { await s.close(); }
});

test('ps_ik: a target out of reach answers reached false with finite joints within the limits, not an error', async () => {
  const s = await small();
  try {
    for (const [ref, chain, xyz] of [['physical-sandbox/so101:1', 'arm', [5, -4, 3]], ['physical-sandbox/openarm:1', 'right_arm', [0, -3, 0.3]]] as const) {
      const got = json(await call(s.client, 'ps_ik', { ref, chain, target: { xyz } }));
      assert.equal(got.reached, false);
      assert.ok(Number.isFinite(got.errorM) && got.errorM > 1);
      const bundle = ref.includes('so101') ? so101 : openarm;
      assert.equal(Object.keys(got.joints).length, 5 + (ref.includes('so101') ? 0 : 2));
      for (const [name, value] of Object.entries<number>(got.joints)) {
        const joint = bundle.joints.find((j: any) => j.name === name);
        assert.ok(Number.isFinite(value) && value >= joint.lower && value <= joint.upper, `${name} ${value}`);
      }
      assert.equal(got.next, MACHINE_WORDS.outOfReach(got.errorM));
    }
  } finally { await s.close(); }
});

test('ps_machine_joints and ps_ik: an unknown robot, an unknown chain and a bad target are told in Japanese and English', async () => {
  const s = await small();
  try {
    const nothing = await call(s.client, 'ps_machine_joints', { ref: 'nothing-here' });
    assert.equal(nothing.isError, true);
    assert.match(nothing.content[0].text, /^nothing-here: .+ \/ .+/);
    assert.ok(nothing.content[0].text.startsWith(`nothing-here: ${MACHINE_WORDS.noMachine.split(' / ')[0]}`));

    s.hub.setScene({ devices: [{ id: 'crate1', parent: 'site', type: 'box', pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] } }] });
    const crate = await call(s.client, 'ps_ik', { ref: 'crate1', chain: 'arm', target: { xyz: [0, 0, 0] } });
    assert.equal(crate.isError, true);
    assert.equal(crate.content[0].text, `crate1: ${MACHINE_WORDS.notMachine}`);

    const leg = await call(s.client, 'ps_ik', { ref: 'physical-sandbox/so101:1', chain: 'leg', target: { xyz: [0, 0, 0] } });
    assert.equal(leg.isError, true);
    assert.equal(leg.content[0].text, MACHINE_WORDS.noChain('leg', ['arm']));

    const flat = await call(s.client, 'ps_ik', { ref: 'physical-sandbox/so101:1', chain: 'arm', target: { xyz: [0, 0] } });
    assert.equal(flat.isError, true);
  } finally { await s.close(); }
});
