import { memo, useMemo } from 'react';
import { Handle, Position, NodeToolbar, type NodeProps } from '@xyflow/react';
import {
  AlertTriangle,
  Ban,
  Bug,
  ChevronDown,
  ChevronRight,
  Copy,
  Lock,
  LockOpen,
  Play,
  RotateCcw,
  Trash2,
  Ungroup,
} from 'lucide-react';
import type { MvaNode, NodeData, NodeStatus, PortDef, PortValue } from '../types/graph';
import { nodeRegistry } from '../registry';
import { useGraph } from '../store/graphStore';
import { useRun } from '../store/runStore';
import { useUi } from '../store/uiStore';
import { mockRuntime } from '../engine/mockEngine';
import { cn, formatCny, timecode } from '../lib/utils';
import { PORT_COLOR } from '../canvas/validation';

const STATUS_STYLE: Record<NodeStatus, { border: string; dot: string; label: string; text: string }> = {
  idle: { border: 'border-bay-600', dot: 'bg-status-idle', label: 'IDLE', text: 'text-bay-900/45' },
  stale: { border: 'border-status-stale/80', dot: 'bg-status-stale', label: 'STALE', text: 'text-[#8a6d1b]' },
  queued: { border: 'border-status-queued/70', dot: 'bg-status-queued', label: 'QUEUED', text: 'text-[#4a5f85]' },
  running: { border: 'border-status-running', dot: 'bg-status-running animate-breathe', label: 'RUNNING', text: 'text-sodium-700' },
  success: { border: 'border-status-success/70', dot: 'bg-status-success', label: 'DONE', text: 'text-[#1f7a5c]' },
  failed: { border: 'border-status-failed', dot: 'bg-status-failed', label: 'FAILED', text: 'text-status-failed' },
  skipped: { border: 'border-bay-700', dot: 'bg-status-skipped', label: 'SKIPPED', text: 'text-bay-900/40' },
  blocked: { border: 'border-status-blocked', dot: 'bg-status-blocked', label: 'BLOCKED', text: 'text-[#7a3fb0]' },
};

const ACCENT_TEXT: Record<string, string> = {
  slate: 'text-bay-900/60',
  blue: 'text-[#2b6cb0]',
  violet: 'text-[#7a3fb0]',
  green: 'text-[#1f7a5c]',
  amber: 'text-sodium-600',
  rose: 'text-status-failed',
  cyan: 'text-[#8a6d1b]',
};

const HANDLE_GAP = 22;

/** 解析节点输入（钉住值 > 本次运行产物） */
function useResolvedInputs(nodeId: string, data: NodeData): Record<string, PortValue | undefined> {
  const edges = useGraph((s) => s.graph.edges);
  const runtime = useRun((s) => s.runtime);
  return useMemo(() => {
    const spec = nodeRegistry.get(data.type);
    const out: Record<string, PortValue | undefined> = {};
    for (const port of spec.inputs) {
      const pinned = data.pinnedInputs?.[port.id];
      if (pinned) {
        let hit: { id: string } | undefined;
        for (const r of Object.values(runtime)) {
          for (const v of Object.values(r.outputs ?? {})) {
            if (v && 'items' in v) hit = v.items.find((a) => a.id === pinned) ?? hit;
          }
        }
        if (hit) {
          out[port.id] = { type: port.type as 'image', items: [hit as never] };
          continue;
        }
      }
      const incoming = edges.filter((e) => e.target === nodeId && e.targetHandle === `in:${port.id}`);
      const values: PortValue[] = [];
      for (const e of incoming) {
        const portId = (e.sourceHandle ?? '').split(':')[1];
        const v = runtime[e.source]?.outputs?.[portId];
        if (v) values.push(v);
      }
      if (!values.length) continue;
      const withItems = values.filter((v): v is { type: 'image' | 'video' | 'audio'; items: never[] } => 'items' in v);
      if (withItems.length) {
        out[port.id] = { type: port.type as 'image', items: withItems.flatMap((v) => v.items) };
      } else {
        out[port.id] = values.find((v) => v.type === 'text') ?? values.find((v) => v.type === 'json');
      }
    }
    return out;
  }, [edges, runtime, data, nodeId]);
}

function PortHandle({
  port,
  side,
  index,
  count,
  connected,
  hasValue,
}: {
  port: PortDef;
  side: 'in' | 'out';
  index: number;
  count: number;
  connected: boolean;
  hasValue: boolean;
}) {
  const active = connected || hasValue;
  return (
    <Handle
      id={`${side}:${port.id}`}
      type={side === 'in' ? 'target' : 'source'}
      position={side === 'in' ? Position.Left : Position.Right}
      isConnectable
      style={{
        position: 'absolute',
        top: `calc(50% + ${(index - (count - 1) / 2) * HANDLE_GAP}px)`,
        transform: 'translateY(-50%)',
        [side === 'in' ? 'left' : 'right']: -7,
        background: active ? PORT_COLOR[port.type] : '#F5F1E8',
        borderColor: active ? '#14110F' : PORT_COLOR[port.type],
        boxShadow: port.required && !connected ? '0 0 0 3px rgba(226,85,75,0.2)' : undefined,
      }}
      title={`${port.label} · ${port.type}${port.required ? ' · 必需' : ''}${port.multi ? ' · 多入' : ''}`}
    />
  );
}

export const BaseNode = memo(function BaseNode({ id, data, selected }: NodeProps<MvaNode>) {
  const spec = nodeRegistry.get(data.type);
  const rt = useRun((s) => s.runtime[id]);
  const status: NodeStatus = rt?.status ?? 'idle';
  const style = STATUS_STYLE[status];
  const inputs = useResolvedInputs(id, data);
  const edges = useGraph((s) => s.graph.edges);
  const apply = useGraph((s) => s.applyLocal);
  const budget = useGraph((s) => s.graph.constraints.budgetLimitCny);
  const setSelection = useUi((s) => s.setSelection);

  const connectedPorts = useMemo(() => {
    const set = new Set<string>();
    for (const e of edges) {
      if (e.target === id) set.add(e.targetHandle ?? '');
      if (e.source === id) set.add(e.sourceHandle ?? '');
    }
    return set;
  }, [edges, id]);

  const missingRequired = spec.inputs.filter((p) => p.required && !inputs[p.id]);
  const cost = spec.estimateCost(data.params);
  const items = rt?.outputs?.out && 'items' in rt.outputs.out ? rt.outputs.out.items : [];
  const Icon = spec.icon;

  const setParam = (key: string, value: unknown) =>
    apply([{ op: 'update_node_params', node_id: id, params: { [key]: value } }]);
  const setParams = (patch: Record<string, unknown>) =>
    apply([{ op: 'update_node_params', node_id: id, params: patch }]);
  const setUi = (patch: Partial<NodeData['ui']>) => patchNode(id, (n) => { n.data.ui = { ...n.data.ui, ...patch }; });
  const retry = () => mockRuntime.retryNode(useGraph.getState().graph, id, budget);

  return (
    <>
      <NodeToolbar isVisible={selected} position={Position.Top} className="flex gap-1">
        <ToolBtn icon={Play} title="运行该节点" onClick={() => runSingle(id)} />
        <ToolBtn
          icon={RotateCcw}
          title="重试（不影响其他分支）"
          disabled={status !== 'failed' && status !== 'stale'}
          onClick={retry}
        />
        <ToolBtn
          icon={data.locked ? Lock : LockOpen}
          title={data.locked ? '解锁' : '锁定（Agent 不可修改）'}
          active={data.locked}
          onClick={() => patchNode(id, (n) => { n.data.locked = !n.data.locked; })}
        />
        <ToolBtn icon={Copy} title="复制节点" onClick={() => duplicate(id)} />
        <ToolBtn icon={Ungroup} title="打组（Cmd/Ctrl+G）" onClick={() => groupSelection()} />
        <ToolBtn
          icon={Ban}
          title={data.enabled ? '禁用' : '启用'}
          active={!data.enabled}
          onClick={() => patchNode(id, (n) => { n.data.enabled = !n.data.enabled; })}
        />
        <ToolBtn
          icon={Bug}
          title="注入故障（演示单点失败隔离与重试）"
          active={mockRuntime.isFailing(id)}
          onClick={() => {
            const next = !mockRuntime.isFailing(id);
            mockRuntime.injectFailure(id, next);
            useUi.getState().toast('warn', next ? '已注入故障：运行时该节点会失败' : '已解除故障注入');
          }}
        />
        <ToolBtn icon={Trash2} title="删除节点" danger onClick={() => apply([{ op: 'remove_node', node_id: id }])} />
      </NodeToolbar>

      <div
        data-testid={`node-${id}`}
        data-status={status}
        onPointerDown={() => setSelection([id])}
        className={cn(
          'mva-card group relative w-[352px] rounded-lg border-2 bg-bone-100 text-bay-900 shadow-card transition-shadow',
          style.border,
          !data.enabled && 'opacity-55',
          status === 'running' && 'shadow-[0_0_0_4px_rgba(232,163,61,0.14)]',
        )}
      >
        <header className="flex items-center gap-2 rounded-t-[6px] border-b border-bay-900/10 bg-bone-50 px-2.5 py-1.5">
          <Icon className={cn('size-3.5 shrink-0', ACCENT_TEXT[spec.accent])} />
          <input
            className="min-w-0 flex-1 truncate bg-transparent font-display text-[14.5px] font-semibold tracking-tight text-bay-900 outline-none"
            value={data.label}
            onChange={(e) => patchNode(id, (n) => { n.data.label = e.target.value; })}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label="节点名称"
          />
          {data.locked && <Lock className="size-3 shrink-0 text-bay-900/40" />}
          {missingRequired.length > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 rounded-sm bg-status-failed/15 px-1 py-[1px] font-mono text-[11px] text-status-failed">
              <AlertTriangle className="size-2.5" />
              缺输入
            </span>
          )}
          <button
            className="shrink-0 rounded p-0.5 text-bay-900/40 hover:bg-bay-900/5 hover:text-bay-900"
            onClick={() => setUi({ collapsed: !data.ui.collapsed })}
            aria-label={data.ui.collapsed ? '展开' : '折叠'}
          >
            {data.ui.collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </button>
        </header>

        {spec.inputs.map((p, i) => (
          <PortHandle
            key={p.id}
            port={p}
            side="in"
            index={i}
            count={spec.inputs.length}
            connected={connectedPorts.has(`in:${p.id}`)}
            hasValue={!!inputs[p.id]}
          />
        ))}
        {spec.outputs.map((p, i) => (
          <PortHandle
            key={p.id}
            port={p}
            side="out"
            index={i}
            count={spec.outputs.length}
            connected={connectedPorts.has(`out:${p.id}`)}
            hasValue={!!rt?.outputs?.[p.id]}
          />
        ))}

        {!data.ui.collapsed && (
          <div className="px-2.5 pb-2 pt-2">
            <spec.Body
              id={id}
              data={data}
              outputs={rt?.outputs}
              inputs={inputs}
              setParam={setParam}
              setParams={setParams}
              setUi={setUi}
            />
          </div>
        )}

        <footer className="flex items-center gap-2 rounded-b-[6px] border-t border-bay-900/10 bg-bone-50 px-2.5 py-1">
          <span className={cn('size-[6px] shrink-0 rounded-full', style.dot)} />
          <span className={cn('font-mono text-[11.5px] tracking-wider', style.text)}>{style.label}</span>

          {status === 'running' && rt?.progress && (
            <>
              <span className="h-[3px] w-14 overflow-hidden rounded-full bg-bay-900/10">
                <span className="block h-full bg-sodium-500 transition-all" style={{ width: `${rt.progress.pct}%` }} />
              </span>
              <span className="font-mono text-[11.5px] text-sodium-600">{rt.progress.pct}%</span>
            </>
          )}
          {status === 'success' && rt?.runMeta?.latencyMs != null && (
            <span className="font-mono text-[11.5px] tabular-nums text-bay-900/45">
              {timecode(rt.runMeta.latencyMs)}
            </span>
          )}

          <span className="ml-auto flex items-center gap-2">
            {rt?.runMeta?.costCny != null && (
              <span className="font-mono text-[11.5px] text-bay-900/60">{formatCny(rt.runMeta.costCny)}</span>
            )}
            {(status === 'idle' || status === 'stale') && (
              <span
                className={cn('font-mono text-[11.5px]', cost > budget * 0.25 ? 'text-status-failed' : 'text-bay-900/45')}
                title="本地估算成本"
              >
                ≈{formatCny(cost)}
              </span>
            )}
            {items.length > 0 && <span className="font-mono text-[11.5px] text-bay-900/45">{items.length} 件</span>}
            {rt?.runMeta?.adapter && (
              <span className="hidden font-mono text-[11.5px] text-bay-900/40 group-hover:inline">
                {rt.runMeta.adapter}
              </span>
            )}
          </span>
        </footer>

        {rt?.error && (
          <div className="mx-2 mb-2 mt-1 rounded border border-status-failed/40 bg-status-failed/10 px-2 py-1">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[11.5px] uppercase text-status-failed">{rt.error.class}</span>
              {rt.error.retryable && <span className="font-mono text-[11px] text-bay-900/50">可重试</span>}
              <button
                className="ml-auto rounded border border-status-failed/40 px-1.5 py-[1px] font-mono text-[11.5px] text-status-failed hover:bg-status-failed/10"
                onClick={retry}
              >
                重试
              </button>
            </div>
            <p className="mt-0.5 text-[12.5px] leading-snug text-bay-900/75">{rt.error.message}</p>
          </div>
        )}
      </div>
    </>
  );
});

function ToolBtn({
  icon: Icon,
  title,
  onClick,
  disabled,
  active,
  danger,
}: {
  icon: typeof Play;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'grid size-6 place-items-center rounded border border-bay-600 bg-bay-800 text-bone-300 transition-colors',
        'hover:border-sodium-600 hover:text-sodium-400 disabled:cursor-not-allowed disabled:opacity-35',
        active && 'border-sodium-500 text-sodium-400',
        danger && 'hover:border-status-failed hover:text-status-failed',
      )}
    >
      <Icon className="size-3.5" />
    </button>
  );
}

/* ── 图操作工具（运行时状态不进 undo 栈；结构变更走 patch） ── */
function patchNode(id: string, fn: (n: MvaNode) => void) {
  useGraph.setState((s) => {
    const n = s.graph.nodes.find((x) => x.id === id);
    if (n) fn(n);
  });
}

function duplicate(id: string) {
  const n = useGraph.getState().graph.nodes.find((x) => x.id === id);
  if (!n) return;
  const copy: MvaNode = {
    ...structuredClone(n),
    id: `n_${Math.random().toString(36).slice(2, 9)}`,
    position: { x: n.position.x + 40, y: n.position.y + 60 },
    selected: false,
  };
  copy.data = { ...copy.data, createdBy: 'user' };
  useGraph.getState().applyLocal([{ op: 'add_node', node: copy }], '复制节点');
  useUi.getState().toast('success', '已复制节点');
}

function groupSelection() {
  const ids = useUi.getState().selectedIds;
  if (ids.length < 2) {
    useUi.getState().toast('warn', '至少选中两个节点才能打组');
    return;
  }
  const gid = `g_${Math.random().toString(36).slice(2, 7)}`;
  useGraph.getState().applyLocal([{ op: 'group', group_id: gid, node_ids: ids, label: '分组' }], '打组');
  useUi.getState().toast('success', `已打组 ${ids.length} 个节点`);
}

async function runSingle(id: string) {
  const { graph } = useGraph.getState();
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return;
  const spec = nodeRegistry.get(node.data.type);
  const missing = spec.inputs.filter(
    (p) =>
      p.required &&
      !node.data.pinnedInputs?.[p.id] &&
      !graph.edges.some((e) => e.target === id && e.targetHandle === `in:${p.id}`),
  );
  if (missing.length) {
    useUi.getState().toast('error', `缺少必需输入：${missing.map((m) => m.label).join('、')}`);
    return;
  }
  useUi.getState().setSelection([id]);
  await mockRuntime.run({ graph, mode: 'single', nodeIds: [id], budget: graph.constraints.budgetLimitCny });
}

export { runSingle, groupSelection };
