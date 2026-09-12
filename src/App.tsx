import { useEffect } from 'react';
import { CanvasView } from './canvas/CanvasView';
import { TopBar } from './panels/TopBar';
import { LeftRail } from './panels/LeftRail';
import { Inspector } from './panels/Inspector';
import { RunLogPanel } from './panels/RunLogPanel';
import { ProposalDock } from './panels/ProposalCard';
import { AgentChat } from './panels/AgentChat';
import { CostMeter, DialogHost, HelpOverlay, Toasts } from './panels/Overlays';
import { Resizer } from './panels/Resizer';
import { useRuntimeBridge } from './engine/bridge';
import { useModelStore } from './engine/realVideo';
import { useUi, DEFAULT_LAYOUT_STATE } from './store/uiStore';
import { useCanvas, scheduleCanvasSave } from './store/canvasStore';
import { useGraph } from './store/graphStore';
import { useRun } from './store/runStore';

export default function App() {
  useRuntimeBridge();

  const layout = useUi((s) => s.layout);
  const setLayout = useUi((s) => s.setLayout);
  const logOpen = useUi((s) => s.logOpen);

  // 启动：装载持久化的画布（多画布从这里恢复）
  useEffect(() => {
    useCanvas.getState().hydrate();
    void useModelStore.getState().refresh();
    const t = window.setInterval(() => void useModelStore.getState().refresh(), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // 图 / 运行态变化 → 防抖写回当前画布快照（多画布与刷新都不丢）
  useEffect(() => {
    const unsubGraph = useGraph.subscribe(scheduleCanvasSave);
    const unsubRun = useRun.subscribe(scheduleCanvasSave);
    const onUnload = () => useCanvas.getState().saveActive();
    window.addEventListener('beforeunload', onUnload);
    return () => {
      unsubGraph();
      unsubRun();
      window.removeEventListener('beforeunload', onUnload);
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bay-950">
      <TopBar />

      <div className="flex min-h-0 flex-1">
        {!layout.leftCollapsed && (
          <>
            <LeftRail width={layout.leftWidth} />
            <Resizer
              direction="vertical"
              value={layout.leftWidth}
              min={200}
              max={480}
              defaultValue={DEFAULT_LAYOUT_STATE.leftWidth}
              onChange={(v) => setLayout({ leftWidth: v })}
            />
          </>
        )}

        <main className="relative flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <CanvasView />
            <ProposalDock />
            <div className="pointer-events-none absolute bottom-3 left-3 z-20">
              <CostMeter />
            </div>
            {layout.leftCollapsed && (
              <button
                className="btn absolute left-3 top-3 z-20"
                onClick={() => setLayout({ leftCollapsed: false })}
                title="展开左侧栏"
              >
                ▸ 侧栏
              </button>
            )}
          </div>

          {logOpen && (
            <Resizer
              direction="horizontal"
              value={layout.logHeight}
              min={120}
              max={520}
              defaultValue={DEFAULT_LAYOUT_STATE.logHeight}
              onChange={(v) => setLayout({ logHeight: v })}
              sign={-1}
            />
          )}
          <RunLogPanel height={layout.logHeight} />

          {layout.rightCollapsed && (
            <button
              className="btn absolute right-3 top-3 z-20"
              onClick={() => setLayout({ rightCollapsed: false })}
              title="展开右侧检查器"
            >
              ◂ 检查器
            </button>
          )}
        </main>

        {!layout.rightCollapsed && (
          <>
            <Resizer
              direction="vertical"
              value={layout.rightWidth}
              min={260}
              max={560}
              defaultValue={DEFAULT_LAYOUT_STATE.rightWidth}
              onChange={(v) => setLayout({ rightWidth: v })}
              sign={-1}
            />
            <aside
              className="flex shrink-0 flex-col border-l border-bay-800 bg-bay-900"
              style={{ width: layout.rightWidth }}
            >
              <Inspector />
              <AgentChat />
            </aside>
          </>
        )}
      </div>

      <Toasts />
      <DialogHost />
      <HelpOverlay />
    </div>
  );
}
