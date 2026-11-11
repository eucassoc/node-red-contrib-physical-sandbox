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

/** Why a proposal cannot go to the editor, or null when it can. */
export function proposalProblem(nodes: unknown): string | null {
  if (!Array.isArray(nodes)) return FLOW_WORDS.notArray;
  if (nodes.length === 0) return FLOW_WORDS.empty;
  if (nodes.length > MAX_PROPOSED_NODES) return FLOW_WORDS.tooMany;
  for (const [i, node] of nodes.entries()) {
    if (!isPlainObject(node)) return FLOW_WORDS.notObject(i);
    if (typeof node.type !== 'string' || node.type === '') return FLOW_WORDS.noType(i);
  }
  return null;
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
  items: { type: 'object', properties: { type: { type: 'string' }, id: { type: 'string' } }, required: ['type'] },
  description: 'Node-RED nodes as in a flow export (the JSON of Export/Import): each with a type and an id unique within the proposal; '
    + 'wires and z refer to those ids. The editor gives every node a new id on import, so an id the person\'s flows already have is never overwritten. '
    + 'A node of type "tab" with the other nodes\' z set to its id makes a named tab.',
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
    let result: any;
    try {
      result = await link.ask('propose', { nodes, newTab: newTab ?? true });
    } catch (e) {
      return askFailed(e, (why) => `${why} / ${FLOW_WORDS.notImported}`);
    }
    const answer: Record<string, unknown> = { imported: result?.imported, tab: result?.tab, deployed: false };
    const missing = Array.isArray(result?.notInstalled) ? result.notInstalled.filter((t: unknown) => typeof t === 'string') : [];
    if (missing.length > 0) answer.notInstalled = missing;
    answer.next = missing.length > 0 ? `${FLOW_WORDS.proposed}\n${FLOW_WORDS.notInstalled(missing)}` : FLOW_WORDS.proposed;
    return text(answer);
  });
}
