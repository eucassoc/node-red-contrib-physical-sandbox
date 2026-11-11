// Copied from app/src/devices/state.js of ps-com (commit 615120e).
// Copied 2026-11-11, Apache-2.0 by permission of the owner (2026-11-11).
// Do not edit here: tools/check-pscom-copy.mjs compares this file with its source.
/**
 * Topics, and where the devices' current state is kept.
 *
 * **The topic says nothing about what kind of device it is, and nothing about whether it is
 * real or simulated** (design of 2026-09-21). That is what lets a simulated gate be replaced
 * by a real one without the flow changing.
 *
 * **Everything arriving from the broker is treated as rubbish until it proves otherwise.**
 * A broker carries whatever anyone publishes on it.
 *
 * **An older `at` never wins.** Several parts of a flow start at once and the order they
 * arrive in gets swapped.
 */

const KINDS = new Set(['state', 'command', 'event']);

export function topicFor(site, id, kind) {
  return `ps/${site}/${id}/${kind}`;
}

/**
 * A name a device can answer to: **one topic segment**, so no level separator, no wildcard,
 * no control character, and not `$` first (brokers keep those for themselves). Any language
 * otherwise — topics are UTF-8. The last three are refused because a names table is looked up
 * as an object, where they would shadow its own members. Its length is counted in characters
 * (code points), as the schema's maxLength counts them.
 */
export function isTopicName(value) {
  if (typeof value !== 'string') return false;
  const length = [...value].length;
  return length >= 1 && length <= 80
    && !/[/+#\u0000-\u001f\u007f]/.test(value) && !value.startsWith('$')
    && !['__proto__', 'constructor', 'prototype'].includes(value);
}

export function parseTopic(topic) {
  const parts = String(topic).split('/');
  if (parts.length !== 4) return null;
  const [head, site, id, kind] = parts;
  if (head !== 'ps' || !site || !id || !KINDS.has(kind)) return null;
  return { site, id, kind };
}

export function decode(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (!Number.isFinite(value.at)) return null;
  return value;
}

export const newStore = () => new Map();

const clamp = (n, low, high) => Math.min(high, Math.max(low, n));

export function applyState(store, device, msg) {
  const held = store.get(device.id);
  if (held && msg.at < held.at) return false;

  if (device.type === 'substance') {
    const outlets = device.outlets ?? [];
    if (!outlets.length) {
      if (!Number.isFinite(msg.amount)) return false;
      store.set(device.id, { at: msg.at, amount: clamp(msg.amount, 0, device.max) });
      return true;
    }
    return applyOutlets(store, device, msg);
  }
  if (device.type === 'equipment') {
    if (!(msg.state in (device.states ?? {}))) return false;
    store.set(device.id, { at: msg.at, state: msg.state });
    return true;
  }
  if (device.type === 'sensor') {
    if (!Number.isFinite(msg.value)) return false;
    store.set(device.id, { at: msg.at, value: msg.value });
    return true;
  }
  if (device.type === 'mover') {
    // Where it is, how its joints stand, or both (the design of 2026-10-05). **Whatever a
    // message leaves out stays as it was**: something driving an arm's joints from outside
    // sends no position, and something flying a drone sends no joints.
    //
    // Which way it faces rides along as `yaw`, a turn about ROS +Z [rad] — the same field a
    // recording's deviceTrace sample carries. Like there, it comes with a position or joints,
    // never on its own.
    const p = msg.position;
    const hasPosition = p !== undefined;
    if (hasPosition && !(Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))) return false;
    const hasYaw = msg.yaw !== undefined;
    if (hasYaw && !Number.isFinite(msg.yaw)) return false;
    const joints = readJoints(msg.joints);
    if (!hasPosition && !joints) return false;
    const yaw = hasYaw ? msg.yaw : held?.yaw;
    store.set(device.id, {
      at: msg.at,
      ...(hasPosition ? { position: [...p] } : held?.position ? { position: held.position } : {}),
      ...(yaw === undefined ? {} : { yaw }),
      joints: { ...(held?.joints ?? {}), ...(joints ?? {}) },
    });
    return true;
  }
  if (device.type === 'item') {
    // Where it is: on which parent, and where on it (the design of 2026-09-25). Changing
    // hands is this state changing; the command that did it went to whatever carried it
    const p = msg.xyz;
    if (typeof msg.parent !== 'string' || !msg.parent) return false;
    if (!(Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))) return false;
    store.set(device.id, { at: msg.at, parent: msg.parent, xyz: [...p] });
    return true;
  }
  return false;
}

/**
 * The joints of a message, by name, in radians (metres for a sliding joint): only the ones
 * that are numbers. Null when there is not one. The names are the robot's own (its URDF's);
 * whether the robot has such a joint is the stage's to say, not this table's.
 */
function readJoints(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out = {};
  for (const [name, angle] of Object.entries(value)) {
    if (!isTopicName(name) || !Number.isFinite(angle)) continue;
    out[name] = angle;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * A substance with outlets keeps **a volume per outlet**; its `amount` is their sum, so
 * everything that only asks "how much" reads it the same as before outlets.
 *
 * A message carrying `outlets: { id: volume }` sets each outlet it names (the others keep
 * theirs); one carrying only `amount` puts all of it on the first outlet, which is where a
 * command with no `outlet` goes too. **The total is held to `max` by taking the excess off the
 * outlets named last**, so the one that just filled up is the one that stops, not the others.
 */
function applyOutlets(store, device, msg) {
  const held = { ...(store.get(device.id)?.outlets ?? {}) };
  const ids = device.outlets.map((o) => o.id);
  let next;
  if (msg.outlets && typeof msg.outlets === 'object' && !Array.isArray(msg.outlets)) {
    next = {};
    for (const id of ids) {
      const v = msg.outlets[id];
      next[id] = Number.isFinite(v) ? Math.max(0, v) : Math.max(0, held[id] ?? 0);
    }
  } else if (Number.isFinite(msg.amount)) {
    next = Object.fromEntries(ids.map((id, n) => [id, n === 0 ? Math.max(0, msg.amount) : 0]));
  } else {
    return false;
  }

  let excess = Object.values(next).reduce((a, b) => a + b, 0) - device.max;
  const named = msg.outlets ? ids.filter((id) => id in msg.outlets) : [ids[0]];
  for (const id of [...named.reverse(), ...[...ids].reverse()]) {
    if (!(excess > 0)) break;
    const off = Math.min(excess, next[id]);
    next[id] -= off;
    excess -= off;
  }
  const amount = Object.values(next).reduce((a, b) => a + b, 0);
  store.set(device.id, { at: msg.at, amount, outlets: next });
  return true;
}

export const amountOf = (store, id) => store.get(id)?.amount ?? 0;
export const stateOf = (store, id) => store.get(id)?.state;
export const valueOf = (store, id) => store.get(id)?.value ?? 0;

/** `{ total, outlets: { id: volume } }` — the shape substance.js's substanceDepths reads. */
export const amountsOf = (store, id) => {
  const held = store.get(id);
  return { total: held?.amount ?? 0, outlets: { ...(held?.outlets ?? {}) } };
};

/** A mover's joints as last told, `{ name: angle }`; empty for one nothing has posed. */
export const jointsOf = (store, id) => ({ ...(store.get(id)?.joints ?? {}) });

/** An item's `{ at, parent, xyz }`, or undefined for one nothing has placed. */
export const whereOf = (store, id) => store.get(id);
