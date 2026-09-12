import { useMemo } from 'react';
import { Boxes, Play, Save, Trash2, Ungroup } from 'lucide-react';
import { useGraph } from '../store/graphStore';
import { useRun } from '../store/runStore';
import { useUi } from '../store/uiStore';
import { nodeRegistry } from '../registry';
import type { ParamField } from '../registry/types';
import { buildPlan } from '../canvas/topo';
import { cn, formatCny, formatMs } from '../lib/utils';
import { Segmented, Slider } from '../nodes/controls';
import { runSingle } from '../nodes/BaseNode';

export function Inspector() {
  const graph = useGraph((s) => s.graph);
  const apply = useGraph((s) => s.applyLocal);
  const selected = useUi((s) => s.selectedIds);
  const runtime = useRun((s) => s.runtime);

  const node = graph.nodes.find((n) => n.id === selected[0] && n.type !== 'group');

  if (selected.length > 1) return <MultiSelect ids={selected} />;
  if (!node) return <GraphLevel />;

  const spec = nodeRegistry.get(node.data.type);
  const rt = runtime[node.id];
  const setParam = (k: string, v: unknown) =>
    apply([{ op: 'update_node_params', node_id: node.id, params: { [k]: v } }]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="border-b border-bay-800 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <spec.icon className="size-4 text-sodium-500" />
          <h2 className="font-display text-[15px] font-semibold tracking-tight text-bone-100">{spec.title}</h2>
          <span className="chip ml-auto">{node.data.createdBy}</span>
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-bone-400">{spec.description}</p>
        <p className="mt-1.5 font-mono text-[12px] text-bone-400/70">{node.id}</p>
      </div>

      {/* 参数（由 spec.fields 声明式生成） */}
      <div className="space-y-3 px-3 py-3">
        <p className="eyebrow">params</p>
        {spec.fields.map((f) => (
          <Field
            key={f.key}
            field={f}
            value={node.data.params[f.key]}
            onChange={(v) => setParam(f.key, v)}
          />
        ))}
        <div className="flex items-center justify-between border-t border-bay-800 pt-2">
          <span className="eyebrow">estimate</span>
          <span className="font-mono text-[13px] text-sodium-500">{formatCny(spec.estimateCost(node.data.params))}</span>
        </div>
      </div>

      {/* 运行信息 */}
      <div className="border-t border-bay-800 px-3 py-3">
        <p className="eyebrow mb-1.5">run</p>
        <dl className="grid grid-cols-[86px_1fr] gap-y-1">
          <Row label="状态" value={rt?.status ?? 'idle'} />
          <Row label="尝试" value={String(rt?.runMeta?.attempt ?? 0)} />
          <Row label="适配器" value={rt?.runMeta?.adapter ?? '—'} />
          <Row label="模型" value={rt?.runMeta?.model ?? '—'} />
          <Row label="耗时" value={formatMs(rt?.runMeta?.latencyMs)} />
          <Row label="花费" value={rt?.runMeta?.costCny != null ? formatCny(rt.runMeta.costCny) : '—'} />
        </dl>
        {node.data.pinnedInputs && Object.keys(node.data.pinnedInputs).length > 0 && (
          <div className="mt-2 rounded border border-sodium-700/50 bg-sodium-500/5 px-2 py-1">
            <span className="font-mono text-[11.5px] text-sodium-500">已钉住输入（优先级最高）</span>
            {Object.entries(node.data.pinnedInputs).map(([port, art]) => (
              <div key={port} className="flex items-center justify-between">
                <span className="font-mono text-[12px] text-bone-300">{port}</span>
                <button
                  className="font-mono text-[11.5px] text-bone-400 hover:text-status-failed"
                  onClick={() => apply([{ op: 'pin_input', node_id: node.id, port_id: port, artifact_id: null }])}
                >
                  取消钉住
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 操作 */}
      <div className="mt-auto flex flex-wrap gap-1.5 border-t border-bay-800 px-3 py-2.5">
        <button className="btn" onClick={() => void runSingle(node.id)}>
          <Play className="size-3.5" /> 运行该节点
        </button>
        <button
          className="btn"
          onClick={() => {
            toggle(node.id, 'locked');
            useUi.getState().toast('info', node.data.locked ? '已解锁：Agent 可以修改它了' : '已锁定：Agent 不可修改该节点');
          }}
        >
          {node.data.locked ? '解锁' : '锁定'}
        </button>
        <button className="btn" onClick={() => toggle(node.id, 'enabled')}>
          {node.data.enabled ? '禁用' : '启用'}
        </button>
        <button className="btn" onClick={() => saveAsTemplate([node.id])}>
          <Save className="size-3.5" /> 存为模板
        </button>
        <button className="btn" onClick={() => apply([{ op: 'remove_node', node_id: node.id }], '删除节点')}>
          <Trash2 className="size-3.5" /> 删除
        </button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="contents">
      <dt className="font-mono text-[12.5px] text-bone-400">{label}</dt>
      <dd className="truncate font-mono text-[12.5px] text-bone-200">{value}</dd>
    </div>
  );
}

function Field({
  field,
  value,
  onChange,
}: {
  field: ParamField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = (
    <span className="eyebrow flex items-center gap-1">
      {field.label}
      {field.affectsCost && <span className="text-sodium-500">¥</span>}
    </span>
  );
  switch (field.kind) {
    case 'textarea':
      return (
        <label className="block space-y-1">
          {label}
          <textarea
            className="field h-[64px] resize-none"
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
          />
          {field.hint && <span className="block text-[12px] text-bone-400/70">{field.hint}</span>}
        </label>
      );
    case 'number':
      return (
        <label className="block space-y-1">
          {label}
          <input
            type="number"
            min={field.min}
            max={field.max}
            step={field.step ?? 1}
            className="field"
            value={Number(value ?? 0)}
            onChange={(e) => onChange(Number(e.target.value))}
          />
          {field.hint && <span className="block text-[12px] text-bone-400/70">{field.hint}</span>}
        </label>
      );
    case 'slider':
      return (
        <div className="space-y-1">
          {label}
          <Slider
            value={Number(value ?? 0)}
            min={field.min ?? 0}
            max={field.max ?? 1}
            step={field.step ?? 0.1}
            onChange={onChange}
          />
          {field.hint && <span className="block text-[12px] text-bone-400/70">{field.hint}</span>}
        </div>
      );
    case 'toggle':
      return (
        <div className="space-y-1">
          {label}
          <Segmented
            value={String(Boolean(value))}
            options={[
              { value: 'true', label: 'ON' },
              { value: 'false', label: 'OFF' },
            ]}
            onChange={(v) => onChange(v === 'true')}
          />
          {field.hint && <span className="block text-[12px] text-bone-400/70">{field.hint}</span>}
        </div>
      );
    case 'select':
      return (
        <label className="block space-y-1">
          {label}
          <select className="field" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
            {(field.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {field.hint && <span className="block text-[12px] text-bone-400/70">{field.hint}</span>}
        </label>
      );
    default:
      return (
        <label className="block space-y-1">
          {label}
          <input className="field" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
          {field.hint && <span className="block text-[12px] text-bone-400/70">{field.hint}</span>}
        </label>
      );
  }
}

function MultiSelect({ ids }: { ids: string[] }) {
  const apply = useGraph((s) => s.applyLocal);
  return (
    <div className="flex min-h-0 flex-1 flex-col p-3">
      <p className="eyebrow">已选中 {ids.length} 个节点</p>
      <ul className="mt-2 space-y-0.5">
        {ids.map((id) => (
          <li key={id} className="truncate font-mono text-[12.5px] text-bone-300">
            {id}
          </li>
        ))}
      </ul>
      <div className="mt-4 space-y-1.5">
        <button
          className="btn w-full justify-center"
          onClick={() => {
            const gid = `g_${Math.random().toString(36).slice(2, 7)}`;
            apply([{ op: 'group', group_id: gid, node_ids: ids, label: '分组' }], '打组');
            useUi.getState().toast('success', '已打组');
          }}
        >
          <Ungroup className="size-3.5" /> 打组（Cmd/Ctrl+G）
        </button>
        <button className="btn w-full justify-center" onClick={() => saveAsTemplate(ids)}>
          <Save className="size-3.5" /> 存为工作流模板
        </button>
        <button
          className="btn w-full justify-center"
          onClick={() => apply(ids.map((id) => ({ op: 'remove_node' as const, node_id: id })), '批量删除')}
        >
          <Trash2 className="size-3.5" /> 删除选中
        </button>
      </div>
      <p className="mt-3 text-[12.5px] leading-relaxed text-bone-400">
        模板是「可复用、可版本化的子图」；分组只影响画布组织。两者解耦。
      </p>
    </div>
  );
}

function GraphLevel() {
  const graph = useGraph((s) => s.graph);
  const runId = useRun((s) => s.runId);
  const plan = useMemo(() => {
    try {
      return buildPlan(graph, 'full', undefined);
    } catch {
      return null;
    }
  }, [graph]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
      <p className="eyebrow">workflow</p>
      <h2 className="mt-1 font-display text-[15px] font-semibold text-bone-100">{graph.name}</h2>
      <dl className="mt-2 grid grid-cols-[86px_1fr] gap-y-1">
        <Row label="版本" value={`v${graph.version}`} />
        <Row label="节点" value={String(graph.nodes.filter((n) => n.type !== 'group').length)} />
        <Row label="连线" value={String(graph.edges.length)} />
        <Row label="预算" value={`¥${graph.constraints.budgetLimitCny.toFixed(2)}`} />
        <Row label="run" value={runId ?? '—'} />
      </dl>

      <p className="eyebrow mb-1.5 mt-4">执行计划（分层 · 同层并行）</p>
      {plan ? (
        <div className="space-y-1.5">
          {plan.levels.map((level, i) => (
            <div key={i} className="rounded border border-bay-800 bg-bay-950 px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12px] text-sodium-500">L{i}</span>
                <span className="font-mono text-[12px] text-bone-400">{level.length} 个并行</span>
              </div>
              <ul className="mt-1 space-y-[2px]">
                {level.map((id) => {
                  const n = graph.nodes.find((x) => x.id === id);
                  return (
                    <li key={id} className="truncate font-mono text-[12px] text-bone-300">
                      {n?.data.label ?? id}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded border border-status-failed/40 bg-status-failed/10 px-2 py-1.5 text-[13px] text-[#ffb4ae]">
          检测到循环依赖，无法生成执行计划
        </p>
      )}

      <div className="mt-4 rounded border border-bay-800 bg-bay-950 px-2 py-2">
        <p className="eyebrow mb-1 flex items-center gap-1">
          <Boxes className="size-3" /> 从这里开始
        </p>
        <p className="text-[12.5px] leading-relaxed text-bone-400">
          双击画布空白处新建节点 · 从左侧拖入模板 · 或让右侧 Agent 一句话搭好整条流水线。
        </p>
      </div>
    </div>
  );
}

function toggle(id: string, key: 'locked' | 'enabled') {
  useGraph.setState((s) => {
    const n = s.graph.nodes.find((x) => x.id === id);
    if (n) n.data[key] = !n.data[key];
  });
}

function saveAsTemplate(ids: string[]) {
  const { graph } = useGraph.getState();
  const nodes = graph.nodes.filter((n) => ids.includes(n.id));
  const edges = graph.edges.filter((e) => ids.includes(e.source) && ids.includes(e.target));
  const payload = {
    kind: 'mva.template',
    schemaVersion: '1.0.0',
    exportedAt: new Date().toISOString(),
    template: { name: `${nodes[0]?.data.label ?? '子图'} 模板`, nodes, edges, variables: [] },
  };
  localStorage.setItem(`mva.tpl.${Date.now()}`, JSON.stringify(payload));
  useUi.getState().toast('success', `已存为模板（${nodes.length} 节点 / ${edges.length} 连线，可在下次实例化）`);
}

export { cn };
