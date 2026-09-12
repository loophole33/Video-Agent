import { useEffect, useState } from 'react';
import {
  Download,
  HelpCircle,
  Play,
  RotateCcw,
  Square,
  Upload,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { useGraph } from '../store/graphStore';
import { useRun } from '../store/runStore';
import { useUi } from '../store/uiStore';
import { useCanvas } from '../store/canvasStore';
import { mockRuntime } from '../engine/mockEngine';
import { cancelRun, startRun } from '../engine/actions';
import { buildPlan } from '../canvas/topo';
import { cn, download, timecode } from '../lib/utils';
import { CostMeter } from './Overlays';

export function TopBar() {
  const graph = useGraph((s) => s.graph);
  const dirty = useGraph((s) => s.dirty);
  const replaceGraph = useGraph((s) => s.replaceGraph);
  const selected = useUi((s) => s.selectedIds);
  const runStatus = useRun((s) => s.status);
  const startedAt = useRun((s) => s.startedAt);
  const finishedAt = useRun((s) => s.finishedAt);
  const wsOnline = useRun((s) => s.wsOnline);
  const wsSeq = useRun((s) => s.wsSeq);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, []);

  const elapsed = startedAt ? (finishedAt ?? now) - startedAt : 0;
  const failedCount = Object.values(useRun.getState().runtime).filter((r) => r.status === 'failed').length;

  const exportJson = () => {
    download(`${graph.name.replace(/\s+/g, '_')}_v${graph.version}.json`, useCanvas.getState().exportCanvas());
    useUi.getState().toast('success', '已导出画布 JSON（可从顶部导入为新画布）');
  };

  const importJson = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        // 导入为**新画布**（不动当前画布）
        const res = useCanvas.getState().importCanvas(parsed);
        if (!res.ok) {
          useUi.getState().toast('error', `导入失败：${res.message}`);
          return;
        }
        buildPlan(useGraph.getState().graph, 'full', undefined);
        useUi.getState().toast('success', res.message);
      } catch (e) {
        useUi.getState().toast('error', `导入失败：${(e as Error).message}`);
      }
    };
    input.click();
  };

  const retryAllFailed = async () => {
    const graphNow = useGraph.getState().graph;
    const ids = Object.entries(useRun.getState().runtime)
      .filter(([, r]) => r.status === 'failed')
      .map(([id]) => id);
    if (!ids.length) {
      useUi.getState().toast('info', '没有失败节点');
      return;
    }
    for (const id of ids) {
      mockRuntime.injectFailure(id, false);
      await mockRuntime.retryNode(graphNow, id, graphNow.constraints.budgetLimitCny);
    }
  };

  return (
    <header className="flex h-[60px] shrink-0 items-center gap-3.5 border-b border-bay-800 bg-bay-900 px-4">
      {/* 品牌 + 片名 */}
      <div className="flex items-center gap-2.5">
        <span className="grid size-7 place-items-center rounded border border-sodium-600 bg-sodium-500/10">
          <Zap className="size-4 text-sodium-500" />
        </span>
        <div className="leading-tight">
          <input
            className="w-[240px] truncate bg-transparent font-display text-[15.5px] font-semibold tracking-tight text-bone-100 outline-none"
            value={graph.name}
            onChange={(e) => useCanvas.getState().renameCanvas(useCanvas.getState().activeId, e.target.value)}
            aria-label="画布名称（也是画布列表里的名字）"
          />
          <div className="flex items-center gap-2">
            <span className="tc">v{graph.version}</span>
            {dirty ? <span className="tc-amber">● 未保存</span> : <span className="tc">已保存</span>}
            <span className="tc">{graph.nodes.filter((n) => n.type !== 'group').length} 节点</span>
            <button
              className="tc hover:text-sodium-400"
              title="复制当前画布"
              onClick={() => useCanvas.getState().duplicateCanvas()}
            >
              复制画布
            </button>
          </div>
        </div>
      </div>

      <div className="h-7 w-px bg-bay-800" />

      {/* 运行控制 */}
      <div className="flex items-center gap-1.5">
        <button className="btn btn-primary" onClick={() => void startRun('full')} disabled={runStatus === 'running'}>
          <Play className="size-3.5" />
          运行全部
        </button>
        <button
          className="btn"
          onClick={() => void startRun('subgraph', selected)}
          disabled={!selected.length || runStatus === 'running'}
          title="只运行选中子图（自动补全上游并按缓存复用）"
        >
          运行选中 {selected.length ? `(${selected.length})` : ''}
        </button>
        <button className="btn" onClick={retryAllFailed} disabled={!failedCount}>
          <RotateCcw className="size-3.5" />
          重试失败 {failedCount ? `(${failedCount})` : ''}
        </button>
        <button className="btn" onClick={cancelRun} disabled={runStatus !== 'running'}>
          <Square className="size-3.5" />
          取消
        </button>
      </div>

      {/* 运行态 */}
      <div className="flex items-center gap-2 rounded-md border border-bay-800 bg-bay-950 px-2 py-1">
        <span
          className={cn(
            'size-[7px] rounded-full',
            runStatus === 'running'
              ? 'animate-breathe bg-status-running'
              : runStatus === 'succeeded'
                ? 'bg-status-success'
                : runStatus === 'failed'
                  ? 'bg-status-failed'
                  : runStatus === 'partial'
                    ? 'bg-status-stale'
                    : 'bg-status-idle',
          )}
        />
        <span className="font-mono text-[12.5px] uppercase tracking-wider text-bone-300">{runStatus}</span>
        <span className="font-mono text-[13px] tabular-nums text-sodium-500">{timecode(elapsed)}</span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <span className="hidden items-center gap-1.5 xl:flex">
          <label className="eyebrow" htmlFor="budget">
            预算上限 ¥
          </label>
          <input
            id="budget"
            type="number"
            min={0.5}
            step={0.5}
            value={graph.constraints.budgetLimitCny}
            onChange={(e) =>
              useGraph.setState((s) => {
                s.graph.constraints.budgetLimitCny = Math.max(0.5, Number(e.target.value));
              })
            }
            className="field w-[68px] !py-1 text-right"
          />
        </span>

        <CostMeter compact />

        <button
          className={cn('btn', !wsOnline && 'border-status-failed/60 text-status-failed')}
          title="断线演练：暂停事件推送，再点一次按 seq 补发缺口事件"
          onClick={() => {
            if (mockRuntime.online) {
              mockRuntime.goOffline();
              useRun.getState().setWsOnline(false);
              useUi.getState().toast('warn', '已模拟 WebSocket 断线：事件仍在服务端累积');
            } else {
              const r = mockRuntime.goOnline();
              useRun.getState().setWsOnline(true);
              useUi.getState().toast('success', `重连成功：按 since=${wsSeq} 补发 ${r.replayed} 条事件（缺口 ${r.missed}）`);
            }
          }}
        >
          {wsOnline ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
          {wsOnline ? `WS #${wsSeq}` : '已断线'}
        </button>

        <button className="btn btn-ghost" onClick={exportJson} title="导出工作流 JSON">
          <Download className="size-3.5" />
        </button>
        <button className="btn btn-ghost" onClick={importJson} title="导入工作流 JSON">
          <Upload className="size-3.5" />
        </button>
        <button className="btn btn-ghost" onClick={() => useUi.getState().setShowHelp(true)} title="快捷键">
          <HelpCircle className="size-3.5" />
        </button>
      </div>
    </header>
  );
}
