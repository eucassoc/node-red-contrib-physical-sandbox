/**
 * The flow tools: the agent reads the flows the open editor holds (`ps_flows_read`, with the
 * person's undeployed edits, never credentials) and proposes a flow (`ps_flow_propose`), which the
 * editor imports as an undeployed change, with new ids (an id the person's flows already have is
 * never overwritten) and, by default, in a tab of its own. The person looks at it and presses
 * Deploy: that is the approval. Nothing here posts to `/flows`; the plugin never deploys.
 *
 * Both go through the editor link (editor-link.ts): with no editor open the agent is told to open
 * one. A proposal is checked here before any editor is asked.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EditorRefused, LINK_WORDS, NoEditor, ProposalUnanswered, type EditorLink } from '../editor-link.js';

export const MAX_PROPOSED_NODES = 2000;

// What the agent is told, to pass on to the person, who may read either language
export const FLOW_WORDS = {
  noEditor: `${LINK_WORDS.noEditor} / Open the Node-RED editor in a browser: reading the flows and proposing a flow need an open editor`,
  notArray: 'nodes には Node-RED のノードの配列（フローの書き出しと同じ形）を指定してください / nodes must be an array of Node-RED node objects, as in a flow export',
  empty: 'nodes が空です。ノードを 1 つ以上指定してください / nodes is empty: give at least one node',
  tooMany: `一度に提案できるノードは ${MAX_PROPOSED_NODES} 個までです / At most ${MAX_PROPOSED_NODES} nodes can be proposed at once`,
  notObject: (i: number) => `nodes[${i}] がノード（オブジェクト）ではありません / nodes[${i}] is not a node object`,
  noType: (i: number) => `nodes[${i}] に type（ノードの種類の文字列）を指定してください / nodes[${i}] has no type (the node type, a string)`,
  noId: (i: number) => `nodes[${i}] に id（提案の中で重ならない文字列）を指定してください / nodes[${i}] has no id (a string, unique within the proposal)`,
  sameId: (i: number, first: number) => `nodes[${i}] の id が nodes[${first}] と同じです。id は提案の中で重ならないようにしてください`
    + ` / nodes[${i}] has the same id as nodes[${first}]: the ids must be unique within the proposal`,
  globalConfig: (i: number) => `nodes[${i}] は global-config です。人のグローバル環境変数を置き換えてしまうため、提案には含められません`
    + ` / nodes[${i}] is a global-config node, which would replace the person's global environment variables: it cannot be proposed`,
  credentialsRemoved: '提案のノードの資格情報（credentials）は取り除きました。必要な資格情報は人がエディタで設定してください'
    + ' / The credentials in the proposed nodes were removed: the person enters any that are needed in the editor',
  flowsRefused: 'エディタからフローを取得できませんでした / The editor could not give its flows',
  notImported: 'The editor could not import the proposal',
  proposed: 'エディタに提案を Deploy 前の変更として取り込みました。内容を確かめて Deploy してください。Deploy するまで動きません'
    + ' / The proposal is in the editor as an undeployed change: the person checks it and presses Deploy; nothing runs until then',
  notInstalled: (types: string[]) => `次の種類のノードはこの Node-RED にインストールされていません: ${types.join(', ')}。パレットの管理からインストールしてください`
    + ` / These node types are not installed in this Node-RED: ${types.join(', ')} (install them from Manage palette)`,
};

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const failed = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Why a proposal cannot go to the editor, or null when it can. Node-RED's import keeps only the
 * first node of an id, so every node needs an id of its own; a global-config node would merge into
 * (and can replace) the person's global environment variables, which new ids do not prevent.
 */
export function proposalProblem(nodes: unknown): string | null {
  if (!Array.isArray(nodes)) return FLOW_WORDS.notArray;
  if (nodes.length === 0) return FLOW_WORDS.empty;
  if (nodes.length > MAX_PROPOSED_NODES) return FLOW_WORDS.tooMany;
  const seen = new Map<string, number>();
  for (const [i, node] of nodes.entries()) {
    if (!isPlainObject(node)) return FLOW_WORDS.notObject(i);
    if (typeof node.type !== 'string' || node.type === '') return FLOW_WORDS.noType(i);
    if (typeof node.id !== 'string' || node.id === '') return FLOW_WORDS.noId(i);
    if (node.type === 'global-config') return FLOW_WORDS.globalConfig(i);
    const first = seen.get(node.id);
    if (first !== undefined) return FLOW_WORDS.sameId(i, first);
    seen.set(node.id, i);
  }
  return null;
}

/** The nodes without their credentials, and whether any were there. */
function withoutCredentials(nodes: Record<string, unknown>[]): { nodes: Record<string, unknown>[]; removed: boolean } {
  let removed = false;
  const kept = nodes.map((node) => {
    if (!Object.hasOwn(node, 'credentials')) return node;
    removed = true;
    const { credentials: _dropped, ...rest } = node;
    return rest;
  });
  return { nodes: kept, removed };
}

/** What a failed ask tells the agent. */
function askFailed(e: unknown, refused: (message: string) => string) {
  if (e instanceof NoEditor) return failed(FLOW_WORDS.noEditor);
  if (e instanceof ProposalUnanswered) return failed(e.message);
  if (e instanceof EditorRefused) return failed(refused(e.message));
  throw e;
}

// The schema the agent sees describes a proposal fully (nodes required, its shape); the check itself
// is proposalProblem, so a wrong one, a missing one too, is answered in the person's words rather
// than in the schema library's
const NODES = z.any().optional().meta({
  type: 'array',
  minItems: 1,
  maxItems: MAX_PROPOSED_NODES,
  items: { type: 'object', properties: { type: { type: 'string' }, id: { type: 'string' } }, required: ['type', 'id'] },
  description: 'Node-RED nodes as in a flow export (the JSON of Export/Import): each with a type and an id unique within the proposal; '
    + 'wires and z refer to those ids. The editor gives every node a new id on import, so an id the person\'s flows already have is never overwritten. '
    + 'A node of type "tab" with the other nodes\' z set to its id makes a named tab. '
    + 'Not allowed: global-config nodes (they would replace the person\'s global environment variables). Credentials are removed before import.',
});

export function registerFlowTools(server: McpServer, link: EditorLink | undefined): void {
  server.registerTool('ps_flows_read', {
    description: 'The flows in the open Node-RED editor, as a flow export: every tab, node and config node, including the person\'s changes that are not deployed yet; '
      + 'credentials are never included. Needs a Node-RED editor open in a browser (see ps_status editors).',
  }, async () => {
    if (!link) return failed(FLOW_WORDS.noEditor);
    try {
      return text(await link.ask('flows', {}));
    } catch (e) {
      return askFailed(e, (why) => `${FLOW_WORDS.flowsRefused}: ${why}`);
    }
  });

  server.registerTool('ps_flow_propose', {
    description: 'Propose a flow to the person: the open Node-RED editor imports the nodes as an undeployed change (in a new tab unless newTab is false), '
      + 'with new ids, and tells the person to check it and press Deploy. This tool never deploys and nothing runs until the person presses Deploy. '
      + 'Node types that are not installed are imported all the same and named in the answer (notInstalled). '
      + 'Needs a Node-RED editor open in a browser (see ps_status editors). If the answer says the editor took the proposal but did not answer, '
      + 'read the flows (ps_flows_read) before proposing again, so it is not imported twice.',
    inputSchema: z.object({
      nodes: NODES,
      newTab: z.boolean().optional().describe('Import into a new tab (the default) or, with false, into the tab open in the editor.'),
    }).meta({ required: ['nodes'] }),
  }, async ({ nodes, newTab }) => {
    const problem = proposalProblem(nodes);
    if (problem) return failed(problem);
    if (!link) return failed(FLOW_WORDS.noEditor);
    const sent = withoutCredentials(nodes);
    let result: any;
    try {
      result = await link.ask('propose', { nodes: sent.nodes, newTab: newTab ?? true });
    } catch (e) {
      return askFailed(e, (why) => `${why} / ${FLOW_WORDS.notImported}`);
    }
    const answer: Record<string, unknown> = { imported: result?.imported, tab: result?.tab, deployed: false };
    const missing = Array.isArray(result?.notInstalled) ? result.notInstalled.filter((t: unknown) => typeof t === 'string') : [];
    if (missing.length > 0) answer.notInstalled = missing;
    if (sent.removed) answer.credentialsRemoved = true;
    answer.next = [
      FLOW_WORDS.proposed,
      ...(missing.length > 0 ? [FLOW_WORDS.notInstalled(missing)] : []),
      ...(sent.removed ? [FLOW_WORDS.credentialsRemoved] : []),
    ].join('\n');
    return text(answer);
  });
}
