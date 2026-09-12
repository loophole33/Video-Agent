import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { GraphPatch, MvaEdge, MvaNode, NodeStatus, PortType, PortValue, WorkflowGraph } from '../types/graph';
import { applyPatch, invertOps, makePatch } from '../canvas/applyPatch';
import { downstreamOf, edgeKey } from '../canvas/topo';
import { useRun } from './runStore';
import { nodeRegistry } from '../registry';

interface GraphState {
  graph: WorkflowGraph;
  undoStack: GraphPatch[];
  redoStack: GraphPatch[];
  dirty: boolean;
  lastSavedAt: number | null;

  /** 人为/Agent 的图结构变更（进 undo 栈） */
  applyLocal: (ops: GraphPatch['ops'], rationale?: string) => void;
  applyAgentPatch: (patch: GraphPatch) => void;
  updateParams: (nodeId: string, params: Record<string, unknown>) => void;
  replaceGraph: (g: WorkflowGraph) => void;
  setViewport: (v: WorkflowGraph['viewport']) => void;
  undo: () => void;
  redo: () => void;
  markSaved: () => void;
}

// 端口信息由注册表提供
function portsOf(nodeId: string, graph: WorkflowGraph) {
  const n = graph.nodes.find((x) => x.id === nodeId);
  if (!n || n.type === 'group') return { inputs: [], outputs: [] };
  const spec = nodeRegistry.get(n.data.type);
  return { inputs: spec.inputs, outputs: spec.outputs };
}
export { portsOf };

function emptyGraph(): WorkflowGraph {
  return {
    schemaVersion: '1.0.0',
    id: 'wf_demo',
    name: '未命名工作流',
    version: 1,
    viewport: { x: 0, y: 0, zoom: 0.85 },
    nodes: [],
    edges: [],
    groups: [],
    constraints: { budgetLimitCny: 8, platform: 'douyin', ratio: '9:16' },
  };
}

export const useGraph = create<GraphState>()(
  immer((set, get) => ({
    graph: emptyGraph(),
    undoStack: [],
    redoStack: [],
    dirty: false,
    lastSavedAt: null,

    applyLocal: (ops, rationale = '手动编辑') => {
      // ⚠️ 必须在 immer producer 之外计算：applyPatch 用 structuredClone，
      //    而 producer 内的 s.graph 是不可克隆的 draft proxy。
      const before = get().graph;
      const inverse = invertOps(before, ops);
      const next = applyPatch(before, ops);
      next.version = before.version + 1;
      set((s) => {
        s.undoStack.push({ ...makePatch(before, inverse, 'user', `撤销：${rationale}`) });
        if (s.undoStack.length > 100) s.undoStack.shift();
        s.redoStack = [];
        s.graph = next;
        s.dirty = true;
      });
    },

    applyAgentPatch: (patch) => {
      const before = get().graph;
      const inverse = invertOps(before, patch.ops);
      const next = applyPatch(before, patch.ops);
      next.version = before.version + 1;
      set((s) => {
        s.undoStack.push({ ...makePatch(before, inverse, 'agent', `撤销 Agent 提案：${patch.rationale}`) });
        s.redoStack = [];
        s.graph = next;
        s.dirty = true;
      });
    },

    updateParams: (nodeId, params) => get().applyLocal([{ op: 'update_node_params', node_id: nodeId, params }]),

    replaceGraph: (g) => set((s) => { s.graph = g; s.undoStack = []; s.redoStack = []; s.dirty = false; }),

    setViewport: (v) => set((s) => { s.graph.viewport = v; }),

    undo: () => {
      const state = get();
      const patch = state.undoStack[state.undoStack.length - 1];
      if (!patch) return;
      const before = state.graph;
      const redoOps = invertOps(before, patch.ops);
      const next = applyPatch(before, patch.ops);
      next.version = before.version + 1;
      set((s) => {
        s.undoStack.pop();
        s.redoStack.push({ ...makePatch(before, redoOps, 'user', `重做：${patch.rationale}`) });
        s.graph = next;
        s.dirty = true;
      });
      // 撤销后下游标 stale（产物可能是旧参数生成的）
      useRun.getState().markStale(downstreamOf(next, changedNodesOf(patch.ops)));
    },

    redo: () => {
      const state = get();
      const patch = state.redoStack[state.redoStack.length - 1];
      if (!patch) return;
      const before = state.graph;
      const undoOps = invertOps(before, patch.ops);
      const next = applyPatch(before, patch.ops);
      next.version = before.version + 1;
      set((s) => {
        s.redoStack.pop();
        s.undoStack.push({ ...makePatch(before, undoOps, 'user', `撤销：${patch.rationale}`) });
        s.graph = next;
        s.dirty = true;
      });
    },

    markSaved: () => set((s) => { s.dirty = false; s.lastSavedAt = Date.now(); }),
  })),
);

function changedNodesOf(ops: GraphPatch['ops']): string[] {
  const ids = new Set<string>();
  for (const op of ops) {
    if ('node_id' in op) ids.add(op.node_id);
    if (op.op === 'add_node') ids.add(op.node.id);
    if (op.op === 'connect') {
      ids.add(op.edge.source);
      ids.add(op.edge.target);
    }
    if (op.op === 'group') op.node_ids.forEach((i) => ids.add(i));
  }
  return [...ids];
}

/* ── 图操作辅助（供画布/面板复用，统一走 patch，保证可撤销） ── */

export function nodePatchConnect(edge: MvaEdge) {
  return { op: 'connect' as const, edge };
}

export function makeEdge(
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
  portType: PortType,
): MvaEdge {
  return {
    id: `e_${Math.random().toString(36).slice(2, 10)}`,
    source,
    sourceHandle,
    target,
    targetHandle,
    type: 'typed',
    data: { portType },
  };
}

export function nodeStatusOf(node: MvaNode): NodeStatus {
  return node.data.status ?? 'idle';
}

export function outputOf(node: MvaNode, port: string): PortValue | undefined {
  return node.data.outputs?.[port];
}

export { edgeKey };
