import type { GraphPatch, PatchOp, WorkflowGraph } from '../types/graph';

const clone = <T,>(v: T): T =>
  typeof structuredClone === 'function' ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T);

/**
 * applyPatch —— 纯函数：前后端同构实现（后端 Python 版见 docs/phase-6 §6.3）。
 * Demo 中同时承担「本地乐观应用」与「Agent 提案应用」两条路径。
 */
export function applyPatch(graph: WorkflowGraph, ops: PatchOp[]): WorkflowGraph {
  const g = clone(graph);
  for (const op of ops) {
    switch (op.op) {
      case 'add_node':
        if (!g.nodes.some((n) => n.id === op.node.id)) g.nodes.push(clone(op.node));
        break;

      case 'remove_node': {
        g.nodes = g.nodes.filter((n) => n.id !== op.node_id);
        g.edges = g.edges.filter((e) => e.source !== op.node_id && e.target !== op.node_id);
        g.groups = g.groups
          .map((grp) => ({ ...grp, nodeIds: grp.nodeIds.filter((id) => id !== op.node_id) }))
          .filter((grp) => grp.nodeIds.length > 0);
        break;
      }

      case 'update_node_params': {
        const n = g.nodes.find((x) => x.id === op.node_id);
        if (n) n.data = { ...n.data, params: { ...n.data.params, ...op.params } };
        break;
      }

      case 'connect':
        if (!g.edges.some((e) => e.id === op.edge.id)) g.edges.push(clone(op.edge));
        break;

      case 'disconnect':
        g.edges = g.edges.filter((e) => e.id !== op.edge_id);
        break;

      case 'move': {
        const n = g.nodes.find((x) => x.id === op.node_id);
        if (n) n.position = { ...op.position };
        break;
      }

      case 'group': {
        let grp = g.groups.find((x) => x.id === op.group_id);
        if (!grp) {
          grp = { id: op.group_id, label: op.label ?? '分组', nodeIds: [], color: 'slate' };
          g.groups.push(grp);
        }
        grp.nodeIds = Array.from(new Set([...grp.nodeIds, ...op.node_ids]));
        if (op.label) grp.label = op.label;
        for (const id of op.node_ids) {
          const n = g.nodes.find((x) => x.id === id);
          if (n) n.data = { ...n.data, groupId: op.group_id };
        }
        break;
      }

      case 'ungroup': {
        const grp = g.groups.find((x) => x.id === op.group_id);
        for (const id of grp?.nodeIds ?? []) {
          const n = g.nodes.find((x) => x.id === id);
          if (n) n.data = { ...n.data, groupId: undefined };
        }
        g.groups = g.groups.filter((x) => x.id !== op.group_id);
        break;
      }

      case 'pin_input': {
        const n = g.nodes.find((x) => x.id === op.node_id);
        if (n) {
          const pinned = { ...(n.data.pinnedInputs ?? {}) };
          if (op.artifact_id) pinned[op.port_id] = op.artifact_id;
          else delete pinned[op.port_id];
          n.data = { ...n.data, pinnedInputs: pinned };
        }
        break;
      }

      case 'set_status':
        // 运行时状态不写入图（由 runStore 承载），此处为兼容后端契约而保留 no-op
        break;
    }
  }
  return g;
}

/** 基于「变更前」的图计算逆操作 —— 本地 undo/redo 的实现基础 */
export function invertOps(before: WorkflowGraph, ops: PatchOp[]): PatchOp[] {
  const inv: PatchOp[] = [];
  for (const op of ops) {
    switch (op.op) {
      case 'add_node':
        inv.unshift({ op: 'remove_node', node_id: op.node.id });
        break;
      case 'remove_node': {
        const n = before.nodes.find((x) => x.id === op.node_id);
        const edges = before.edges.filter((e) => e.source === op.node_id || e.target === op.node_id);
        if (n) {
          inv.unshift({ op: 'add_node', node: n });
          for (const e of edges) inv.unshift({ op: 'connect', edge: e });
        }
        break;
      }
      case 'update_node_params': {
        const n = before.nodes.find((x) => x.id === op.node_id);
        if (n) {
          const prev: Record<string, unknown> = {};
          for (const k of Object.keys(op.params)) prev[k] = n.data.params[k];
          inv.unshift({ op: 'update_node_params', node_id: op.node_id, params: prev });
        }
        break;
      }
      case 'connect':
        inv.unshift({ op: 'disconnect', edge_id: op.edge.id });
        break;
      case 'disconnect': {
        const e = before.edges.find((x) => x.id === op.edge_id);
        if (e) inv.unshift({ op: 'connect', edge: e });
        break;
      }
      case 'move': {
        const n = before.nodes.find((x) => x.id === op.node_id);
        if (n) inv.unshift({ op: 'move', node_id: op.node_id, position: n.position });
        break;
      }
      case 'group': {
        const existed = before.groups.some((x) => x.id === op.group_id);
        if (existed) {
          const grp = before.groups.find((x) => x.id === op.group_id)!;
          inv.unshift({ op: 'group', group_id: op.group_id, node_ids: grp.nodeIds, label: grp.label });
        } else {
          inv.unshift({ op: 'ungroup', group_id: op.group_id });
        }
        break;
      }
      case 'ungroup': {
        const grp = before.groups.find((x) => x.id === op.group_id);
        if (grp) inv.unshift({ op: 'group', group_id: grp.id, node_ids: grp.nodeIds, label: grp.label });
        break;
      }
      case 'pin_input': {
        const n = before.nodes.find((x) => x.id === op.node_id);
        inv.unshift({
          op: 'pin_input',
          node_id: op.node_id,
          port_id: op.port_id,
          artifact_id: n?.data.pinnedInputs?.[op.port_id] ?? null,
        });
        break;
      }
      case 'set_status':
        break;
    }
  }
  return inv;
}

export function makePatch(
  graph: WorkflowGraph,
  ops: PatchOp[],
  author: GraphPatch['author'],
  rationale = '',
  risk: GraphPatch['risk'] = 'low',
): GraphPatch {
  return {
    patch_id: `p_${Math.random().toString(36).slice(2, 10)}`,
    base_version: graph.version,
    rationale,
    author,
    risk,
    ops,
  };
}
