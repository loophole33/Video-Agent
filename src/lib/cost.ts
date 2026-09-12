import type { GraphPatch, WorkflowGraph } from '../types/graph';
import { nodeRegistry } from '../registry';

/** 图成本粗估（<1ms，用于即时反馈；真实预估由后端 CostService 返回） */
export function graphCost(graph: WorkflowGraph): number {
  return graph.nodes
    .filter((n) => n.type !== 'group' && n.data.enabled !== false)
    .reduce((sum, n) => sum + nodeRegistry.get(n.data.type).estimateCost(n.data.params), 0);
}

/** 提案的成本增量（按 ops 推算，不落图） */
export function patchDeltaCost(patch: GraphPatch, graph: WorkflowGraph): number {
  let delta = 0;
  for (const op of patch.ops) {
    if (op.op === 'add_node' && op.node.type !== 'group') {
      delta += nodeRegistry.get(op.node.data.type).estimateCost(op.node.data.params);
    } else if (op.op === 'remove_node') {
      const n = graph.nodes.find((x) => x.id === op.node_id);
      if (n && n.type !== 'group') delta -= nodeRegistry.get(n.data.type).estimateCost(n.data.params);
    } else if (op.op === 'update_node_params') {
      const n = graph.nodes.find((x) => x.id === op.node_id);
      if (n && n.type !== 'group') {
        const spec = nodeRegistry.get(n.data.type);
        delta += spec.estimateCost({ ...n.data.params, ...op.params }) - spec.estimateCost(n.data.params);
      }
    }
  }
  return delta;
}
