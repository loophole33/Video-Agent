import type { WorkflowGraph } from '../types/graph';
import { withUpstream } from './validation';

export interface ExecPlan {
  order: string[];
  levels: string[][];
  deps: Record<string, string[]>;
  skipped: string[];
}

export class CycleError extends Error {}

/** Kahn 拓扑排序 + 分层（前端用于计划预览、子图补全、Mock 调度） */
export function buildPlan(
  graph: WorkflowGraph,
  mode: 'full' | 'subgraph' | 'single',
  nodeIds?: string[],
  includeUpstream = true,
): ExecPlan {
  const real = graph.nodes.filter((n) => n.type !== 'group');
  let sel = new Set(real.map((n) => n.id));
  if (mode !== 'full') {
    let chosen = new Set(nodeIds ?? []);
    if (mode === 'subgraph' && includeUpstream) chosen = withUpstream(graph, chosen);
    sel = new Set([...sel].filter((id) => chosen.has(id)));
  }

  const deps: Record<string, string[]> = {};
  for (const id of sel) deps[id] = [];
  for (const e of graph.edges) {
    if (sel.has(e.source) && sel.has(e.target)) deps[e.target].push(e.source);
  }

  const indeg: Record<string, number> = {};
  for (const id of sel) indeg[id] = deps[id].length;

  const levels: string[][] = [];
  const order: string[] = [];
  let frontier = [...sel].filter((id) => indeg[id] === 0);
  while (frontier.length) {
    levels.push(frontier);
    order.push(...frontier);
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of graph.edges) {
        if (e.source === id && sel.has(e.target)) {
          indeg[e.target] -= 1;
          if (indeg[e.target] === 0) next.push(e.target);
        }
      }
    }
    frontier = next;
  }
  if (order.length !== sel.size) throw new CycleError('CYCLE_DETECTED：工作流存在循环依赖');

  return { order, levels, deps, skipped: real.filter((n) => !sel.has(n.id)).map((n) => n.id) };
}

/** 下游传播：只标状态，不清产物（用户仍可预览旧结果） */
export function downstreamOf(graph: WorkflowGraph, changed: Iterable<string>): string[] {
  const out = new Set<string>();
  const queue = [...changed];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of graph.edges) {
      if (e.source === id && !out.has(e.target)) {
        out.add(e.target);
        queue.push(e.target);
      }
    }
  }
  return [...out];
}

export function edgeKey(source: string, sourceHandle: string, target: string, targetHandle: string) {
  return `${source}:${sourceHandle}->${target}:${targetHandle}`;
}
