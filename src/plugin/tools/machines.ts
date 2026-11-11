/**
 * The robot tools: which robots there are (`ps_machines_list`), a robot's joints and chains
 * (`ps_machine_joints`, also for a device of the scene, with its pose), and joint angles that put
 * a chain's tip at a point (`ps_ik`, src/core/kinematics.ts). The robots are found as the pane
 * finds them (src/core/machines.ts): the PS.com catalog, the psbx cache and local folders.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { chainOf, chainSpecsOf, solvePosition, toBaseFrame, type KinematicBundle } from '../../core/kinematics.js';
import { listMachines, readBundleJson, readProfile, type MachineRow } from '../../core/machines.js';
import type { Actions } from '../actions.js';
import type { Hub } from '../hub.js';

/** The largest coordinate (and yaw) ps_ik takes: far beyond any site, and far from an overflow. */
const LIMIT_M = 1000;

// What the agent is told, to pass on to the person, who may read either language
export const MACHINE_WORDS = {
  noMachine: 'このロボットは見つかりません。ps_machines_list で一覧を確認してください / No such robot: see ps_machines_list for the robots there are',
  notMachine: 'この機器はロボットではありません（製品が指定されていません） / This device is not a robot (it has no product)',
  noChain: (name: string, names: string[]) => `このロボットに ${name} というチェーンはありません。指定できるチェーン: ${names.join(', ') || 'なし'}`
    + ` / This robot has no chain ${name}; its chains: ${names.join(', ') || 'none'}`,
  badChain: (why: string) => `このチェーンでは関節角を求められません: ${why} / The joint angles cannot be worked out for this chain: ${why}`,
  onParent: (parent: string) => `この機器は ${parent} に取り付けられています。pose は ${parent} から見た位置と向きのため、場の座標の目標には使えません`
    + ` / This device hangs on ${parent}: its pose is relative to ${parent}, so site-frame targets are not available for it`,
  tilted: 'この機器は傾けて置かれています（roll または pitch が 0 ではありません）。ps_ik の placement は向き（yaw）しか扱わないため、場の座標の目標には使えません'
    + ' / This device is placed tilted (its roll or pitch is not 0): ps_ik\'s placement takes the yaw only, so site-frame targets are not available for it',
  outOfRange: `目標と placement の値は、それぞれ ${LIMIT_M} 以内の数で指定してください（m、yaw は rad）`
    + ` / The target and placement values must each be numbers within ${LIMIT_M} (metres; radians for yaw)`,
  outOfReach: (errorM: number) => `目標の位置に届きません。最も近づく関節角を返しました（目標まで ${errorM.toFixed(3)} m）`
    + ` / The target is out of reach: these are the joint angles that come closest (${errorM.toFixed(3)} m from the target)`,
};

/** The robots, as the tools reach them. */
export interface MachineAccess {
  list(): Promise<{ machines: MachineRow[]; offline: boolean }>;
  /** A product's bundle.json, with its catalog profile when the bundle names no chains. Throws when there is no such robot. */
  bundle(product: string): Promise<KinematicBundle & Record<string, unknown>>;
}

/**
 * The robots as the pane's routes reach them (the same actions): one catalog cache, and a listing
 * notes each robot's kind, so the agent's ps_scene_place takes what the pane's place takes.
 */
export function machineAccess(hub: Hub, actions: Actions): MachineAccess {
  const where = () => ({ ...actions.catalog, ...actions.roots, token: hub.client.bearer() });

  return {
    async list() {
      const listed = await listMachines(where());
      actions.noteListed(listed.machines);
      return listed;
    },
    async bundle(product) {
      const opts = where();
      const cached = (ref: string) => actions.catalogFetchFor(ref, opts.token);
      const bundle = await readBundleJson(product, opts, cached);
      if (!bundle || typeof bundle !== 'object' || typeof bundle.rootLink !== 'string' || !Array.isArray(bundle.joints)) {
        throw new Error('no bundle.json');
      }
      if (!Array.isArray(bundle.chains) || bundle.chains.length === 0) {
        const profile = await readProfile(product, { ...opts, fetchImpl: cached(product) });
        if (profile) bundle.profile = profile;
      }
      return bundle;
    },
  };
}

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const failed = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

/** A failure the agent is told about in the person's words. */
class Told extends Error {}

const XYZ = z.array(z.number()).length(3);

const inRange = (values: number[]): boolean => values.every((v) => Number.isFinite(v) && Math.abs(v) <= LIMIT_M);

/** A device stands on the site itself: no parent, or the site. */
const onSite = (parent: unknown): boolean => parent === undefined || parent === null || parent === '' || parent === 'site';

/** Joints that are not listed as movable: fixed ones, and a floating or planar base (no single value moves it). */
const NOT_MOVABLE = new Set(['fixed', 'floating', 'planar']);

export function registerMachineTools(server: McpServer, hub: Hub, machines: MachineAccess): void {
  /** The robot a ref names: a device of the scene (by id), else a product. */
  async function robotOf(ref: string) {
    const device = hub.scene().devices.find((d) => d.id === ref);
    if (device && (typeof device.product !== 'string' || device.product === '')) throw new Told(`${ref}: ${MACHINE_WORDS.notMachine}`);
    const product = device ? device.product as string : ref;
    try {
      return { device, product, bundle: await machines.bundle(product) };
    } catch (e) {
      throw new Told(`${ref}: ${MACHINE_WORDS.noMachine} (${(e as Error)?.message ?? e})`);
    }
  }
  const tell = (e: unknown) => {
    if (e instanceof Told) return failed(e.message);
    throw e;
  };

  server.registerTool('ps_machines_list', {
    description: 'The robots and objects that can be placed: from the PS.com catalog (with the account\'s own when signed in), the psbx cache on this machine '
      + 'and the local robot folders set in settings.js. Each has a ref (a catalog reference handle/name:version, or the bare name of a local robot), '
      + 'a label, its source and its kind (machine or object). q narrows the list by ref or label. offline is true when the catalog could not be reached.',
    inputSchema: z.object({ q: z.string().optional().describe('Words the ref or the label contains (any case).') }),
  }, async ({ q }) => {
    const { machines: rows, offline } = await machines.list();
    const wanted = (q ?? '').trim().toLowerCase();
    const shown = wanted === '' ? rows : rows.filter((m) => m.ref.toLowerCase().includes(wanted) || m.label.toLowerCase().includes(wanted));
    return text({ machines: shown, offline });
  });

  server.registerTool('ps_machine_joints', {
    description: 'A robot\'s movable joints and chains, from its bundle. ref is a device id of the scene or a product as ps_machines_list gives it. '
      + 'joints: name, type, lower and upper limits (radians; metres for a prismatic joint; null for a joint that turns freely) and mimic when the joint follows '
      + 'another (it is not set on its own); fixed joints and a floating or planar base are not listed. chains: name, baseLink, tipLink and the joints in order; '
      + 'ps_ik works on a chain. For a device of the scene its product and pose are answered too. pose is the scene\'s starting pose: a stream may have moved '
      + 'the device since. placement (what ps_ik takes for site-frame targets) is given only for a device standing on the site with roll and pitch 0, because '
      + 'ps_ik uses the yaw only; a device hanging on another device answers that parent instead (its pose is relative to it), and a note says why there is no '
      + 'placement. Site-frame heights assume the robot\'s root link stands on the floor (the pane lifts a robot whose meshes reach below its root link, '
      + 'by a few millimetres for the arms in the catalog).',
    inputSchema: z.object({ ref: z.string().min(1).describe('A device id of the scene, or a product (handle/name:version, or a bare name).') }),
  }, async ({ ref }) => {
    try {
      const { device, product, bundle } = await robotOf(ref);
      const joints = bundle.joints.filter((j) => !NOT_MOVABLE.has(j.type)).map((j) => {
        const free = j.type !== 'revolute' && j.type !== 'prismatic';
        const row: Record<string, unknown> = { name: j.name, type: j.type, lower: free ? null : j.lower ?? null, upper: free ? null : j.upper ?? null };
        if (j.mimic) row.mimic = { joint: j.mimic.joint, multiplier: j.mimic.multiplier ?? 1, offset: j.mimic.offset ?? 0 };
        return row;
      });
      const chains = chainSpecsOf(bundle).map((c) => ({ name: c.name, baseLink: c.baseLink, tipLink: c.tipLink, joints: c.joints ?? c.jointNames ?? [] }));
      const answer: Record<string, unknown> = { product };
      if (device) {
        answer.device = device.id;
        if (!onSite(device.parent)) answer.parent = device.parent;
        if (device.pose) {
          answer.pose = device.pose;
          const [roll, pitch, yaw] = device.pose.rpy ?? [0, 0, 0];
          if (!onSite(device.parent)) answer.note = MACHINE_WORDS.onParent(String(device.parent));
          else if (roll !== 0 || pitch !== 0) answer.note = MACHINE_WORDS.tilted;
          else answer.placement = { xyz: device.pose.xyz, yaw: yaw ?? 0 };
        }
      }
      return text({ ...answer, joints, chains });
    } catch (e) { return tell(e); }
  });

  server.registerTool('ps_ik', {
    description: 'Joint angles of one chain of a robot that put the chain\'s tip link at a point: position only in this version (the orientation of the tip is not '
      + 'controlled). The target is in the robot base frame (the robot\'s root link; ROS metres, z up) unless placement is given: then the target is in the site '
      + 'frame and placement is where the robot stands in it (xyz and yaw, as ps_machine_joints answers for a device standing on the site); roll and pitch '
      + 'are not used, and site-frame heights assume the robot\'s root link stands on the floor (the pane lifts a robot whose meshes reach below its root link). '
      + 'Coordinates and yaw must be within 1000. '
      + 'Answers joints (the chain\'s, and any joint that follows one of them), errorM (how far the tip of those joints is from the target) and reached '
      + '(errorM within 2 mm). A target out of reach is not an error: reached is false and the joints are the closest found, within the limits. '
      + 'seed (joint angles by name, e.g. the robot\'s current ones) is where the search starts; when the tip does not get there from the seed, a few other '
      + 'starts are tried, and the answer may then be far from the seed.',
    inputSchema: z.object({
      ref: z.string().min(1).describe('A device id of the scene, or a product (handle/name:version, or a bare name).'),
      chain: z.string().min(1).describe('A chain name from ps_machine_joints.'),
      target: z.object({ xyz: XYZ.describe('[x, y, z] in metres.') }),
      seed: z.record(z.string(), z.number()).optional().describe('Joint angles to start from, by joint name (radians; metres for a prismatic joint).'),
      placement: z.object({
        xyz: XYZ.describe('Where the robot stands in the site [m].'),
        yaw: z.number().optional().describe('Its turn about z [rad] (0 when left out).'),
      }).optional().describe('Give it to put the target in the site frame.'),
    }),
  }, async ({ ref, chain: chainName, target, seed, placement }) => {
    try {
      if (!inRange([...target.xyz, ...(placement ? [...placement.xyz, placement.yaw ?? 0] : [])])) throw new Told(MACHINE_WORDS.outOfRange);
      const { bundle } = await robotOf(ref);
      let chain;
      try {
        chain = chainOf(bundle, chainName);
      } catch (e) {
        const names = chainSpecsOf(bundle).map((c) => c.name);
        throw new Told(names.includes(chainName) ? MACHINE_WORDS.badChain((e as Error).message) : MACHINE_WORDS.noChain(chainName, names));
      }
      const goal = placement ? toBaseFrame(target.xyz, { xyz: placement.xyz, yaw: placement.yaw ?? 0 }) : target.xyz;
      const solved = solvePosition(bundle, chain, goal, { seed });
      return text({ ...solved, ...(solved.reached ? {} : { next: MACHINE_WORDS.outOfReach(solved.errorM) }) });
    } catch (e) { return tell(e); }
  });
}
