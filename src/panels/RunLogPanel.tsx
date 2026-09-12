import { useState } from 'react';
import { ChevronDown, ChevronUp, ListTree, ScrollText, Table2 } from 'lucide-react';
import { useRun } from '../store/runStore';
import { useUi } from '../store/uiStore';
import { useGraph } from '../store/graphStore';
import { buildPlan } from '../canvas/topo';
import { cn, formatCny, formatMs } from '../lib/utils';

type Tab = 'logs' | 'nodes' | 'plan';

export function RunLogPanel({ height }: { height?: number }) {
  const open = useUi((s) => s.logOpen);
  const toggle = useUi((s) => s.toggleLog);
  const logs = useRun((s) => s.logs);
  const runtime = useRun((s) => s.runtime);
  const progress = useRun((s) => s.progress);
  const spent = useRun((s) => s.spentCny);
  const graph = useGraph((s) => s.graph);
  const [tab, setTab] = useState<Tab>('logs');

  const plan = (() => {
    try {
      return buildPlan(graph, 'full', undefined);
    } catch {
      return null;
    }
  })();

  return (
    <div className="border-t border-bay-800 bg-bay-900">
      <div className="flex h-9 items-center gap-1.5 px-2.5">
        <button className="btn btn-ghost !px-1.5 !py-0.5" onClick={() => toggle()} aria-label="折叠日志面板">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
        </button>
        {(
          [
            ['logs', '执行日志', ScrollText],
            ['nodes', '节点明细', Table2],
            ['plan', '执行计划', ListTree],
          ] as const
        ).map(([k, label, Icon]) => (
          <button
            key={k}
            onClick={() => {
              setTab(k);
              if (!open) toggle(true);
            }}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-[3px] font-mono text-[12.5px] transition-colors',
              tab === k ? 'bg-bay-800 text-sodium-400' : 'text-bone-400 hover:bg-bay-850 hover:text-bone-200',
            )}
          >
            <Icon className="size-3" />
            {label}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-3">
          <span className="tc">
            ok {progress.success} · run {progress.running} · fail {progress.failed} · skip {progress.skipped}
          </span>
          <span className="font-mono text-[13px] text-sodium-500">{formatCny(spent)}</span>
        </div>
      </div>

      {open && (
        <div
          className="overflow-y-auto border-t border-bay-800 bg-bay-950"
          style={{ height: height ?? 230 }}
        >
          {tab === 'logs' && (
            <ul className="divide-y divide-bay-900">
              {logs.length === 0 && (
                <li className="px-3 py-6 text-center text-[13px] text-bone-400">
                  还没有执行记录。点顶部「运行全部」或节点工具条上的运行按钮。
                </li>
              )}
              {logs.map((l, i) => (
                <li key={`${l.seq}-${i}`} className="flex items-start gap-2 px-3 py-[3px] font-mono text-[12.5px]">
                  <span className="shrink-0 text-bone-400/70">
                    {new Date(l.ts).toISOString().slice(11, 23)}
                  </span>
                  <span
                    className={cn(
                      'w-10 shrink-0 uppercase',
                      l.level === 'error'
                        ? 'text-status-failed'
                        : l.level === 'warn'
                          ? 'text-sodium-500'
                          : 'text-bone-400',
                    )}
                  >
                    {l.level}
                  </span>
                  {l.nodeId && <span className="w-[86px] shrink-0 truncate text-port-image">{l.nodeId}</span>}
                  <span className="min-w-0 flex-1 text-bone-200">{l.message}</span>
                </li>
              ))}
            </ul>
          )}

          {tab === 'nodes' && (
            <table className="w-full border-collapse font-mono text-[12.5px]">
              <thead className="sticky top-0 bg-bay-900 text-bone-400">
                <tr>
                  {['节点', '类型', '状态', '适配器', '耗时', '花费', '尝试'].map((h) => (
                    <th key={h} className="border-b border-bay-800 px-2 py-1 text-left font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {graph.nodes
                  .filter((n) => n.type !== 'group')
                  .map((n) => {
                    const rt = runtime[n.id];
                    return (
                      <tr key={n.id} className="border-b border-bay-900/60">
                        <td className="max-w-[220px] truncate px-2 py-1 text-bone-200">{n.data.label}</td>
                        <td className="px-2 py-1 text-bone-400">{n.data.type}</td>
                        <td
                          className={cn(
                            'px-2 py-1',
                            rt?.status === 'success'
                              ? 'text-status-success'
                              : rt?.status === 'failed'
                                ? 'text-status-failed'
                                : rt?.status === 'running'
                                  ? 'text-sodium-500'
                                  : 'text-bone-400',
                          )}
                        >
                          {rt?.status ?? 'idle'}
                        </td>
                        <td className="px-2 py-1 text-bone-400">{rt?.runMeta?.adapter ?? '—'}</td>
                        <td className="px-2 py-1 tabular-nums text-bone-300">{formatMs(rt?.runMeta?.latencyMs)}</td>
                        <td className="px-2 py-1 tabular-nums text-sodium-500">
                          {rt?.runMeta?.costCny != null ? formatCny(rt.runMeta.costCny) : '—'}
                        </td>
                        <td className="px-2 py-1 tabular-nums text-bone-400">{rt?.runMeta?.attempt ?? 0}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          )}

          {tab === 'plan' && plan && (
            <div className="flex gap-2 p-2">
              {plan.levels.map((level, i) => (
                <div key={i} className="min-w-[168px] flex-1 rounded border border-bay-800 bg-bay-900 p-2">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-mono text-[12px] text-sodium-500">L{i}</span>
                    <span className="font-mono text-[11.5px] text-bone-400">并行 {level.length}</span>
                  </div>
                  {level.map((id) => {
                    const n = graph.nodes.find((x) => x.id === id);
                    const rt = runtime[id];
                    return (
                      <div key={id} className="flex items-center gap-1.5 py-[2px]">
                        <span
                          className={cn(
                            'size-[6px] shrink-0 rounded-full',
                            rt?.status === 'success'
                              ? 'bg-status-success'
                              : rt?.status === 'failed'
                                ? 'bg-status-failed'
                                : rt?.status === 'running'
                                  ? 'animate-breathe bg-status-running'
                                  : 'bg-status-idle',
                          )}
                        />
                        <span className="truncate font-mono text-[12px] text-bone-300">{n?.data.label ?? id}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {tab === 'plan' && !plan && (
            <p className="p-3 text-[13px] text-[#ffb4ae]">存在循环依赖，无法生成计划。</p>
          )}
        </div>
      )}
    </div>
  );
}
