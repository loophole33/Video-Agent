import { Eye, Sparkles, ThumbsDown, ThumbsUp, Lock } from 'lucide-react';
import { useAgent } from '../store/agentStore';
import { useGraph } from '../store/graphStore';
import { useUi } from '../store/uiStore';
import { patchDeltaCost } from '../lib/cost';
import { cn, formatCny } from '../lib/utils';
import type { GraphPatch, PatchOp } from '../types/graph';

/** 把 ops 翻译成人能读懂的改动清单（不是给机器看的 diff） */
function describe(patch: GraphPatch, graph = useGraph.getState().graph) {
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const linked = patch.ops.filter((o) => o.op === 'connect').length;
  const lockedSkipped: string[] = [];

  for (const op of patch.ops) {
    if (op.op === 'add_node' && op.node.type !== 'group') {
      added.push(op.node.data.label);
    } else if (op.op === 'update_node_params') {
      const n = graph.nodes.find((x) => x.id === op.node_id);
      if (n?.data.locked) lockedSkipped.push(n.data.label);
      else updated.push(n?.data.label ?? op.node_id);
    } else if (op.op === 'remove_node') {
      const n = graph.nodes.find((x) => x.id === op.node_id);
      if (n?.data.locked) lockedSkipped.push(n.data.label);
      else removed.push(n?.data.label ?? op.node_id);
    }
  }
  return { added, updated, removed, linked, lockedSkipped };
}

export function ProposalDock() {
  const proposals = useAgent((s) => s.proposals);
  const accept = useAgent((s) => s.accept);
  const reject = useAgent((s) => s.reject);
  const previewGhost = useAgent((s) => s.previewGhost);
  const ghostOps = useUi((s) => s.ghostOps);

  if (!proposals.length) return null;

  return (
    <div className="pointer-events-none absolute bottom-3 right-[240px] z-30 flex w-[420px] flex-col gap-2">
      {proposals.map((p) => {
        const d = describe(p);
        const delta = patchDeltaCost(p, useGraph.getState().graph);
        const previewing = ghostOps === p.ops || (ghostOps != null && p.ops.length === ghostOps.length);
        return (
          <div
            key={p.patch_id}
            className="pointer-events-auto animate-rise rounded-lg border border-sodium-700/60 bg-bay-900/95 p-3 shadow-dock backdrop-blur"
          >
            <div className="flex items-center gap-2">
              <Sparkles className="size-3.5 text-sodium-500" />
              <span className="eyebrow">agent 提案</span>
              <span
                className={cn(
                  'chip',
                  p.risk === 'high'
                    ? 'border-status-failed/50 text-status-failed'
                    : p.risk === 'medium'
                      ? 'border-sodium-700 text-sodium-400'
                      : 'border-status-success/40 text-status-success',
                )}
              >
                risk {p.risk}
              </span>
              <span className="ml-auto font-mono text-[12px] text-bone-400">
                Δ {delta >= 0 ? '+' : '−'}
                {formatCny(Math.abs(delta))}
              </span>
            </div>

            <p className="mt-1.5 text-[14px] leading-relaxed text-bone-200">{p.rationale}</p>

            <ul className="mt-2 space-y-[3px] font-mono text-[12.5px]">
              {d.added.length > 0 && (
                <li className="text-status-success">
                  + 新增 {d.added.length}：{d.added.slice(0, 4).join('、')}
                  {d.added.length > 4 ? ` …+${d.added.length - 4}` : ''}
                </li>
              )}
              {d.updated.length > 0 && (
                <li className="text-sodium-500">
                  ~ 修改 {d.updated.length}：{d.updated.slice(0, 4).join('、')}
                  {d.updated.length > 4 ? ` …+${d.updated.length - 4}` : ''}
                </li>
              )}
              {d.removed.length > 0 && <li className="text-status-failed">− 删除：{d.removed.join('、')}</li>}
              {d.linked > 0 && <li className="text-bone-400">→ 建立 {d.linked} 条连线</li>}
              {d.lockedSkipped.length > 0 && (
                <li className="flex items-center gap-1 text-bone-400">
                  <Lock className="size-3" /> 已跳过锁定节点：{d.lockedSkipped.join('、')}
                </li>
              )}
            </ul>

            <div className="mt-2.5 flex items-center gap-1.5">
              <button className="btn btn-primary" onClick={() => accept(p.patch_id)}>
                <ThumbsUp className="size-3.5" /> 接受并应用
              </button>
              <button
                className={cn('btn', previewing && 'border-sodium-600 text-sodium-400')}
                onClick={() => previewGhost(previewing ? null : p.patch_id)}
              >
                <Eye className="size-3.5" /> {previewing ? '退出预览' : '幽灵预览'}
              </button>
              <button className="btn ml-auto" onClick={() => reject(p.patch_id, '不需要这次改动')}>
                <ThumbsDown className="size-3.5" /> 拒绝
              </button>
            </div>
            <p className="mt-1.5 text-[12px] text-bone-400/80">
              接受后可 Ctrl/Cmd+Z 整批撤销 —— Agent 与你的手改走同一条补丁通道。
            </p>
          </div>
        );
      })}
    </div>
  );
}

export function opSummary(ops: PatchOp[]) {
  return ops.reduce<Record<string, number>>((acc, op) => {
    acc[op.op] = (acc[op.op] ?? 0) + 1;
    return acc;
  }, {});
}
