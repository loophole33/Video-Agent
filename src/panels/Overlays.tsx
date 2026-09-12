import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useUi } from '../store/uiStore';
import { cn } from '../lib/utils';
import { useRun } from '../store/runStore';
import { graphCost } from '../lib/cost';
import { useGraph } from '../store/graphStore';

/* ── 提示条 ── */
const TONE = {
  info: { icon: Info, ring: 'border-bay-600', text: 'text-bone-200' },
  success: { icon: CheckCircle2, ring: 'border-status-success/50', text: 'text-bone-100' },
  warn: { icon: AlertTriangle, ring: 'border-sodium-600', text: 'text-sodium-300' },
  error: { icon: XCircle, ring: 'border-status-failed/60', text: 'text-[#ffb4ae]' },
} as const;

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-1.5">
      {toasts.map((t) => {
        const tone = TONE[t.tone];
        const Icon = tone.icon;
        return (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex max-w-[520px] animate-rise items-center gap-2 rounded-md border bg-bay-900/95 px-3 py-2 shadow-dock backdrop-blur',
              tone.ring,
            )}
          >
            <Icon className={cn('size-3.5 shrink-0', tone.text)} />
            <span className={cn('text-[14px]', tone.text)}>{t.message}</span>
            <button className="ml-1 text-bone-400 hover:text-bone-200" onClick={() => dismiss(t.id)} aria-label="关闭">
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/* ── 模态对话（预算熔断 / 审核阻断） ── */
export function DialogHost() {
  const dialog = useUi((s) => s.dialog);
  const close = useUi((s) => s.closeDialog);
  if (!dialog) return null;
  const tone =
    dialog.kind === 'budget'
      ? 'border-sodium-600'
      : dialog.kind === 'policy'
        ? 'border-status-failed/60'
        : 'border-bay-600';
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-bay-950/70 backdrop-blur-sm">
      <div className={cn('w-[520px] animate-rise rounded-lg border bg-bay-900 p-4 shadow-dock', tone)}>
        <div className="mb-2 flex items-center gap-2">
          {dialog.kind === 'budget' ? (
            <AlertTriangle className="size-4 text-sodium-500" />
          ) : (
            <XCircle className="size-4 text-status-failed" />
          )}
          <h2 className="font-display text-[16px] font-semibold tracking-tight text-bone-100">{dialog.title}</h2>
        </div>
        <p className="text-[14.5px] leading-relaxed text-bone-200">{dialog.body}</p>
        {dialog.detail && (
          <p className="mt-2 rounded border border-bay-700 bg-bay-950 px-2 py-1.5 font-mono text-[13px] leading-relaxed text-bone-400">
            {dialog.detail}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          {dialog.actions?.map((a) => (
            <button
              key={a.label}
              className={cn('btn', a.tone === 'primary' && 'btn-primary')}
              onClick={() => {
                a.run?.();
                close();
              }}
            >
              {a.label}
            </button>
          )) ?? (
            <button className="btn btn-primary" onClick={close}>
              知道了
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── 成本计量条 ── */
export function CostMeter({ compact }: { compact?: boolean }) {
  const spent = useRun((s) => s.spentCny);
  const status = useRun((s) => s.status);
  const graph = useGraph((s) => s.graph);
  const limit = graph.constraints.budgetLimitCny;
  const estimate = graphCost(graph);
  const pct = Math.min(100, (spent / limit) * 100);
  // 「超预算」指的是：下一次完整运行的预估会超过上限（与运行前预检口径一致）
  const over = estimate > limit;

  return (
    <div className={cn('rounded-md border border-bay-800 bg-bay-900/90 px-2.5 py-1.5 backdrop-blur', compact && 'min-w-[190px]')}>
      <div className="flex items-center justify-between gap-3">
        <span className="eyebrow">cost</span>
        <span className="font-mono text-[13px] tabular-nums text-bone-200">
          ¥{spent.toFixed(2)}
          <span className="text-bone-400"> / ¥{limit.toFixed(0)}</span>
        </span>
      </div>
      <div className="mt-1 h-[4px] overflow-hidden rounded-full bg-bay-700">
        <div
          className={cn('h-full transition-all', pct >= 100 ? 'bg-status-failed' : pct >= 80 ? 'bg-sodium-500' : 'bg-status-success')}
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between">
        <span className="tc">估算 ≈¥{estimate.toFixed(2)}</span>
        <span className={cn('tc', over && 'text-status-failed')}>
          {status === 'running' ? '运行中' : over ? '超预算' : '预算内'}
        </span>
      </div>
    </div>
  );
}

/* ── 快捷键说明 ── */
export function HelpOverlay() {
  const show = useUi((s) => s.showHelp);
  const close = () => useUi.getState().setShowHelp(false);
  if (!show) return null;
  const rows: [string, string][] = [
    ['双击空白', '新建节点（搜索式）'],
    ['拖拽端口', '连线（类型不匹配/成环会被拒绝）'],
    ['框选 / Shift+点击', '多选'],
    ['Cmd/Ctrl + G', '打组（≥2 个节点）'],
    ['Cmd/Ctrl + Z / Shift+Z', '撤销 / 重做（含整批撤销 Agent 提案）'],
    ['Cmd/Ctrl + D', '复制选中节点'],
    ['Delete', '删除选中节点'],
    ['Cmd/Ctrl + S', '保存（版本 +1 + 快照）'],
    ['F', '适配视图'],
    ['Esc', '取消选择 / 关闭弹层'],
    ['拖入文件', '外部图片/视频/音频 → 自动建素材节点'],
  ];
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-bay-950/70 backdrop-blur-sm" onClick={close}>
      <div className="w-[560px] rounded-lg border border-bay-700 bg-bay-900 p-4 shadow-dock" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-display text-[16px] font-semibold tracking-tight text-bone-100">快捷键与操作</h2>
        <dl className="mt-3 grid grid-cols-[190px_1fr] gap-y-1.5">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-mono text-[13px] text-sodium-500">{k}</dt>
              <dd className="text-[14px] text-bone-300">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 flex justify-end">
          <button className="btn" onClick={close}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
