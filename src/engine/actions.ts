import { buildPlan, CycleError } from '../canvas/topo';
import { graphCost } from '../lib/cost';
import { nodeRegistry } from '../registry';
import { useGraph } from '../store/graphStore';
import { useRun } from '../store/runStore';
import { useUi } from '../store/uiStore';
import { mockRuntime } from './mockEngine';

/** 运行前预检：环 / 缺输入 / 预算闸门（顺序与后端 create_run 一致） */
export function preflight(mode: 'full' | 'subgraph' | 'single', nodeIds?: string[]): string | null {
  const { graph } = useGraph.getState();
  let plan;
  try {
    plan = buildPlan(graph, mode, nodeIds, mode === 'subgraph');
  } catch (e) {
    if (e instanceof CycleError) return '工作流存在循环依赖，请先修复连线';
    throw e;
  }
  if (!plan.order.length) return '没有可执行的节点';

  for (const id of plan.order) {
    const node = graph.nodes.find((n) => n.id === id);
    if (!node || node.type === 'group' || !node.data.enabled) continue;
    const spec = nodeRegistry.get(node.data.type);
    const missing = spec.inputs.filter(
      (p) =>
        p.required &&
        !node.data.pinnedInputs?.[p.id] &&
        !graph.edges.some((e) => e.target === id && e.targetHandle === `in:${p.id}`),
    );
    if (missing.length) {
      return `节点「${node.data.label}」缺少必需输入：${missing.map((m) => m.label).join('、')}`;
    }
  }

  const cost = costOfSubset(plan.order);
  const limit = graph.constraints.budgetLimitCny;
  // 预算是「每次运行」的上限：新一轮开始时花费从头累计，
  // 只有运行进行中（单点重试/续跑）才把已花计入。
  const rs = useRun.getState();
  const inFlight = rs.status === 'running' || rs.status === 'partial' || rs.status === 'paused';
  const spent = inFlight ? rs.spentCny : 0;
  if (spent + cost > limit) {
    useUi.getState().openDialog({
      kind: 'budget',
      title: '预估超出预算上限',
      body: `本次预估 ¥${cost.toFixed(2)}，已花 ¥${spent.toFixed(2)}，上限 ¥${limit.toFixed(2)}。运行已拦截，不会产生费用。`,
      detail: '三条出路：①提高预算上限 ②把非关键镜头降到静图动效（T-C）③减少图像生成张数。',
      actions: [
        {
          label: `提到 ¥${Math.ceil((spent + cost) / 2) * 2} 并运行`,
          tone: 'primary',
          run: () => {
            const next = Math.ceil((spent + cost) / 2) * 2;
            useGraph.setState((s) => {
              s.graph.constraints.budgetLimitCny = next;
            });
            void startRun(mode, nodeIds);
          },
        },
        { label: '取消', tone: 'ghost' },
      ],
    });
    return 'BUDGET_BLOCKED';
  }
  return null;
}

export function costOfSubset(ids: string[]): number {
  const { graph } = useGraph.getState();
  return ids
    .map((id) => graph.nodes.find((n) => n.id === id))
    .filter((n): n is NonNullable<typeof n> => !!n && n.type !== 'group' && n.data.enabled)
    .reduce((sum, n) => sum + nodeRegistry.get(n.data.type).estimateCost(n.data.params), 0);
}

export async function startRun(mode: 'full' | 'subgraph' | 'single', nodeIds?: string[]) {
  const reason = preflight(mode, nodeIds);
  if (reason) {
    if (reason !== 'BUDGET_BLOCKED') useUi.getState().toast('error', reason);
    return;
  }
  if (mockRuntime.isRunning) {
    useUi.getState().toast('warn', '已有运行在进行中');
    return;
  }
  const { graph } = useGraph.getState();
  const plan = buildPlan(graph, mode, nodeIds, mode === 'subgraph');
  const est = costOfSubset(plan.order);
  useUi.getState().toast('info', `开始运行 · ${mode} · ${plan.order.length} 节点 · 预估 ¥${est.toFixed(2)}`);
  await mockRuntime.run({ graph, mode, nodeIds, budget: graph.constraints.budgetLimitCny });
}

export function cancelRun() {
  mockRuntime.cancel();
  useUi.getState().toast('warn', '已请求取消：不再取新任务，运行中节点等回调或超时');
}

export { graphCost };
