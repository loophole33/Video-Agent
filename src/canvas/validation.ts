import type { MvaEdge, PortType, WorkflowGraph, Connection } from '../types/graph';

/** 端口类型兼容矩阵（docs/phase-5 §5.5.1） */
export const COMPAT: Record<PortType, readonly PortType[]> = {
  text: ['text', 'any'],
  image: ['image', 'any'],
  video: ['video', 'image', 'any'], // 静图可作为视频节点输入（i2v 首帧 / 静图动效）
  audio: ['audio', 'any'],
  json: ['json', 'any'],
  any: ['text', 'image', 'video', 'audio', 'json'],
};

export const PORT_COLOR: Record<PortType, string> = {
  text: '#8A8578',
  image: '#4C9BE8',
  video: '#B06BE8',
  audio: '#3FBF8F',
  json: '#E0B341',
  any: '#9AA0A6',
};

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  severity?: 'error' | 'warn';
}

export function createsCycle(graph: WorkflowGraph, source: string, target: string): boolean {
  // 若从 target 出发能到达 source，则新增 source→target 会成环
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === source) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of adj.get(cur) ?? []) stack.push(nxt);
  }
  return false;
}

export function validateConnection(
  conn: Connection,
  graph: WorkflowGraph,
  specOf: (nodeId: string) => { inputs: { id: string; type: PortType; multi?: boolean; maxConnections?: number }[]; outputs: { id: string; type: PortType }[] },
): ValidationResult {
  const { source, target, sourceHandle, targetHandle } = conn;
  if (!source || !target) return { ok: false, reason: '无效的连接端点' };
  if (source === target) return { ok: false, reason: '不能连接自身' };

  const sNode = graph.nodes.find((n) => n.id === source);
  const tNode = graph.nodes.find((n) => n.id === target);
  if (!sNode || !tNode) return { ok: false, reason: '节点不存在' };
  if (sNode.type === 'group' || tNode.type === 'group') return { ok: false, reason: '分组不可连线' };

  const sPort = specOf(source).outputs.find((p) => `out:${p.id}` === sourceHandle);
  const tPort = specOf(target).inputs.find((p) => `in:${p.id}` === targetHandle);
  if (!sPort || !tPort) return { ok: false, reason: '端口不存在' };

  if (!COMPAT[sPort.type].includes(tPort.type))
    return { ok: false, reason: `${sPort.type} → ${tPort.type} 类型不匹配` };

  if (sNode.data.locked || tNode.data.locked) return { ok: false, reason: '节点已锁定，Agent/用户均不可改拓扑' };

  if (createsCycle(graph, source, target)) return { ok: false, reason: '会产生循环依赖' };

  const occupied = graph.edges.filter((e) => e.target === target && e.targetHandle === targetHandle);
  if (!tPort.multi && occupied.length >= (tPort.maxConnections ?? 1))
    return { ok: true, severity: 'warn', reason: '该输入端口已有连线，将被替换' };

  // 肖像/授权：仅告警不阻断（运行期由 PolicyService 强制）
  const upstreamPortrait = (sNode.data.outputs?.out as { items?: { meta?: Record<string, unknown> }[] } | undefined)
    ?.items?.some((a) => a.meta?.portrait === true);
  if (tPort.type === 'image' && upstreamPortrait)
    return { ok: true, severity: 'warn', reason: '上游含真人素材，需有效授权方可导出' };

  return { ok: true };
}

/** 单输入端口：新边替换旧边 */
export function replaceOnPort(edges: MvaEdge[], incoming: MvaEdge, multi: boolean): MvaEdge[] {
  if (multi) return [...edges, incoming];
  return [...edges.filter((e) => !(e.target === incoming.target && e.targetHandle === incoming.targetHandle)), incoming];
}

export function withUpstream(graph: WorkflowGraph, ids: Iterable<string>): Set<string> {
  const out = new Set(ids);
  const stack = [...out];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of graph.edges) {
      if (e.target === cur && !out.has(e.source)) {
        out.add(e.source);
        stack.push(e.source);
      }
    }
  }
  return out;
}
