/**
 * 事件桥：Mock 运行时 → runStore（reducer）
 * 真实环境下这一段就是 WebSocket 客户端（since 游标 + 缺口重连），此处用本地总线等价替代。
 */
import { useEffect } from 'react';
import { mockRuntime } from './mockEngine';
import { useRun } from '../store/runStore';
import { useGraph } from '../store/graphStore';
import { useUi } from '../store/uiStore';

let bound = false;

export function bindRuntime() {
  if (bound) return;
  bound = true;
  mockRuntime.subscribe((evt) => {
    useRun.getState().ingest(evt);
    if (evt.type === 'policy.blocked') {
      const p = evt.payload as { node_id: string; categories: string[]; message: string };
      useUi.getState().openDialog({
        kind: 'policy',
        title: '内容审核阻断（L3）',
        body: p.message,
        detail: `节点 ${p.node_id} · 命中类别：${p.categories.join('、')} · 该次调用未计费，已写入 audit_log`,
        actions: [{ label: '知道了', tone: 'primary' }],
      });
    }
    if (evt.type === 'cost.warning') {
      const p = evt.payload as { spent_cny: number; limit_cny: number; pct: number };
      if (p.pct >= 1) {
        useUi.getState().openDialog({
          kind: 'budget',
          title: '预算闸门触发：已暂停',
          body: `本次运行已花费 ¥${p.spent_cny.toFixed(2)}，达到上限 ¥${p.limit_cny.toFixed(2)}。执行已暂停，不会继续产生费用。`,
          detail: '选择「提高上限」可继续运行；已完成节点的产物会被复用，不会重复计费。',
          actions: [
            {
              label: '提高上限到 ¥20 并继续',
              tone: 'primary',
              run: () => {
                useGraph.setState((s) => {
                  s.graph.constraints.budgetLimitCny = 20;
                });
                const { graph } = useGraph.getState();
                void mockRuntime.run({ graph, mode: 'full', budget: 20 });
              },
            },
            { label: '保持暂停', tone: 'ghost' },
          ],
        });
      } else {
        useUi.getState().toast('warn', `成本预警：已花 ¥${p.spent_cny.toFixed(2)} / ¥${p.limit_cny.toFixed(2)}`);
      }
    }
  });
}

export function useRuntimeBridge() {
  useEffect(() => {
    bindRuntime();
  }, []);
}
