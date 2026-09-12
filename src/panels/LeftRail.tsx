import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Layers, LayoutTemplate, Plus } from 'lucide-react';
import { TEMPLATES } from '../data/templates';
import { nodeRegistry } from '../registry';
import { useGraph } from '../store/graphStore';
import { useUi } from '../store/uiStore';
import { useCanvas } from '../store/canvasStore';
import { cn, download, formatCny } from '../lib/utils';
import { graphCost } from '../lib/cost';
import { gatewayHealth, listModels, type GatewayModel } from '../engine/modelGateway';

export function LeftRail({ width }: { width?: number }) {
  const apply = useGraph((s) => s.applyLocal);
  const graph = useGraph((s) => s.graph);
  const nodeCount = graph.nodes.filter((n) => n.type !== 'group').length;
  const [openTemplates, setOpenTemplates] = useState(true);
  const [openNodes, setOpenNodes] = useState(true);

  const instantiate = (id: string) => {
    const tpl = TEMPLATES.find((t) => t.id === id);
    if (!tpl) return;
    const vars: Record<string, unknown> = {};
    tpl.variables.forEach((v) => (vars[v.key] = v.default));
    const origin = { x: 80 + (nodeCount % 4) * 80, y: 120 + (nodeCount % 3) * 40 };
    const { nodes, edges } = tpl.build(vars, origin);
    const gid = `g_${Math.random().toString(36).slice(2, 7)}`;
    apply(
      [
        ...nodes.map((n) => ({ op: 'add_node' as const, node: n })),
        ...edges.map((e) => ({ op: 'connect' as const, edge: e })),
        { op: 'group' as const, group_id: gid, node_ids: nodes.map((n) => n.id), label: tpl.name },
      ],
      `实例化模板 ${tpl.name}`,
    );
    useUi.getState().setActiveTemplate(id);
    useUi.getState().toast('success', `已实例化模板「${tpl.name}」（${nodes.length} 节点，可整体拖动）`);
  };

  return (
    <aside className="flex shrink-0 flex-col border-r border-bay-800 bg-bay-900" style={{ width }}>
      {/* 画布列表（多画布切换） */}
      <CanvasList />

      {/* 模板库 */}
      <section className="border-b border-bay-800">
        <button
          className="flex w-full items-center gap-1.5 px-3 py-2 text-left"
          onClick={() => setOpenTemplates((o) => !o)}
        >
          <LayoutTemplate className="size-3.5 text-sodium-500" />
          <span className="eyebrow">模板库</span>
          {openTemplates ? <ChevronDown className="ml-auto size-3.5 text-bone-400" /> : <ChevronRight className="ml-auto size-3.5 text-bone-400" />}
        </button>
        {openTemplates && (
          <div className="space-y-1 px-2 pb-2">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                onClick={() => instantiate(t.id)}
                className="group w-full rounded-md border border-bay-800 bg-bay-850 px-2.5 py-2 text-left transition-colors hover:border-sodium-600 hover:bg-bay-800"
              >
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[14px] font-medium text-bone-200">{t.name}</span>
                  <span className="chip ml-auto shrink-0">{t.category}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-bone-400">{t.description}</p>
                <span className="mt-1 flex items-center gap-1 font-mono text-[11.5px] text-sodium-500 opacity-0 transition-opacity group-hover:opacity-100">
                  <Plus className="size-3" /> 点击实例化到画布
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* 节点面板 */}
      <section className="min-h-0 flex-1 overflow-y-auto">
        <button className="flex w-full items-center gap-1.5 px-3 py-2 text-left" onClick={() => setOpenNodes((o) => !o)}>
          <span className="eyebrow">节点</span>
          <span className="ml-1 font-mono text-[11.5px] text-bone-400">{nodeRegistry.list().length} 类</span>
          {openNodes ? <ChevronDown className="ml-auto size-3.5 text-bone-400" /> : <ChevronRight className="ml-auto size-3.5 text-bone-400" />}
        </button>
        {openNodes && (
          <div className="px-2 pb-3">
            {nodeRegistry.byGroup().map((g) => (
              <div key={g.category} className="mb-2">
                <p className="eyebrow px-1 py-1">{g.label}</p>
                <div className="grid grid-cols-2 gap-1">
                  {g.items.map((s) => (
                    <div
                      key={s.id}
                      draggable
                      data-testid={`palette-${s.id}`}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('application/mva-node', s.id);
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      onDoubleClick={() => {
                        const cnt = useGraph.getState().graph.nodes.filter((n) => n.type !== 'group').length;
                        const node = {
                          id: `n_${Math.random().toString(36).slice(2, 9)}`,
                          type: s.id,
                          position: { x: 120 + (cnt % 5) * 60, y: 160 + Math.floor(cnt / 5) * 120 },
                          data: {
                            type: s.id,
                            label: s.title,
                            params: { ...s.defaultParams },
                            status: 'idle' as const,
                            locked: false,
                            enabled: true,
                            createdBy: 'user' as const,
                            ui: {},
                          },
                        };
                        apply([{ op: 'add_node', node }], `新建 ${s.title}`);
                      }}
                      className={cn(
                        'cursor-grab rounded-md border border-bay-800 bg-bay-850 px-2 py-1.5 transition-colors',
                        'hover:border-sodium-600 hover:bg-bay-800 active:cursor-grabbing',
                      )}
                      title={`${s.description}\n拖到画布或双击创建`}
                    >
                      <s.icon className="mb-1 size-3.5 text-sodium-500" />
                      <span className="block truncate text-[13.5px] text-bone-200">{s.title}</span>
                      <span className="block font-mono text-[11px] text-bone-400">
                        {s.inputs.length}→{s.outputs.length}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 模型网关能力清单 */}
      <ModelPanel />

      {/* 当前图成本 */}
      <section className="border-t border-bay-800 px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="eyebrow">graph cost</span>
          <span className="font-mono text-[13px] text-bone-200">{formatCny(graphCost(graph))}</span>
        </div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-bone-400">
          档位越低越省：<span className="text-sodium-500">T-C 静图动效</span>几乎零成本，只把预算花在 hook 与 CTA 镜头上。
        </p>
      </section>
    </aside>
  );
}

/** 画布列表：多画布切换 / 新建 / 复制 / 重命名 / 删除 */
function CanvasList() {
  const canvases = useCanvas((s) => s.canvases);
  const activeId = useCanvas((s) => s.activeId);
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const commitRename = (id: string) => {
    const name = draft.trim();
    if (name) useCanvas.getState().renameCanvas(id, name);
    setEditing(null);
  };

  return (
    <section className="border-b border-bay-800">
      <div className="flex items-center gap-1.5 px-3 py-2.5">
        <button className="flex items-center gap-1.5" onClick={() => setOpen((o) => !o)}>
          <Layers className="size-4 text-sodium-500" />
          <span className="eyebrow">画布</span>
          <span className="font-mono text-[11.5px] text-bone-400">{canvases.length}</span>
          {open ? <ChevronDown className="size-4 text-bone-400" /> : <ChevronRight className="size-4 text-bone-400" />}
        </button>
        <div className="relative ml-auto">
          <button
            className="btn !px-1.5 !py-0.5"
            title="新建画布"
            onClick={() => setNewOpen((v) => !v)}
          >
            <Plus className="size-4" />
          </button>
          {newOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setNewOpen(false)} />
              <div className="absolute right-0 top-8 z-50 w-[220px] overflow-hidden rounded-md border border-bay-700 bg-bay-900 py-1 shadow-dock">
                <button
                  className="block w-full px-3 py-2 text-left text-[13px] text-bone-200 hover:bg-bay-800"
                  onClick={() => {
                    useCanvas.getState().createCanvas({});
                    setNewOpen(false);
                  }}
                >
                  空白画布
                </button>
                <p className="eyebrow px-3 pb-1 pt-1.5">从模板新建</p>
                {TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    className="block w-full truncate px-3 py-1.5 text-left text-[13px] text-bone-300 hover:bg-bay-800"
                    onClick={() => {
                      useCanvas.getState().createCanvas({ templateId: t.id });
                      setNewOpen(false);
                    }}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {open && (
        <div className="space-y-1 px-2 pb-2">
          {canvases.map((c) => {
            const active = c.id === activeId;
            const nodes = c.graph.nodes.filter((n) => n.type !== 'group').length;
            const runStatus = c.snapshot?.status ?? 'idle';
            return (
              <div
                key={c.id}
                className={cn(
                  'group flex items-center gap-1.5 rounded-md border px-2 py-1.5 transition-colors',
                  active
                    ? 'border-sodium-600 bg-sodium-500/10'
                    : 'border-bay-800 bg-bay-850 hover:border-bay-600 hover:bg-bay-800',
                )}
              >
                <span
                  className={cn(
                    'size-[7px] shrink-0 rounded-full',
                    runStatus === 'running'
                      ? 'animate-breathe bg-status-running'
                      : runStatus === 'succeeded'
                        ? 'bg-status-success'
                        : runStatus === 'failed' || runStatus === 'partial'
                          ? 'bg-status-failed'
                          : 'bg-status-idle',
                  )}
                  title={`最近状态：${runStatus}`}
                />
                {editing === c.id ? (
                  <input
                    autoFocus
                    className="field !py-0.5 text-[13px]"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitRename(c.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(c.id);
                      if (e.key === 'Escape') setEditing(null);
                    }}
                  />
                ) : (
                  <button
                    className="min-w-0 flex-1 truncate text-left text-[13.5px] text-bone-200"
                    onClick={() => useCanvas.getState().activateCanvas(c.id)}
                    onDoubleClick={() => {
                      setEditing(c.id);
                      setDraft(c.name);
                    }}
                    title={`${c.name}（双击重命名）`}
                  >
                    {c.name}
                  </button>
                )}
                <span className="shrink-0 font-mono text-[11px] text-bone-400">{nodes} 节点</span>
                <button
                  className="shrink-0 rounded px-1 text-bone-400 opacity-0 transition-opacity hover:text-sodium-400 group-hover:opacity-100"
                  title="更多操作"
                  onClick={() => setMenuFor(menuFor === c.id ? null : c.id)}
                >
                  ⋯
                </button>
                {menuFor === c.id && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setMenuFor(null)} />
                    <div className="absolute right-2 z-50 mt-16 w-[150px] rounded-md border border-bay-700 bg-bay-900 py-1 shadow-dock">
                      <MenuItem
                        label="复制画布"
                        onClick={() => {
                          useCanvas.getState().duplicateCanvas(c.id);
                          setMenuFor(null);
                        }}
                      />
                      <MenuItem
                        label="重命名"
                        onClick={() => {
                          setEditing(c.id);
                          setDraft(c.name);
                          setMenuFor(null);
                        }}
                      />
                      <MenuItem
                        label="导出 JSON"
                        onClick={() => {
                          download(`${c.name.replace(/\s+/g, '_')}.json`, useCanvas.getState().exportCanvas(c.id));
                          setMenuFor(null);
                        }}
                      />
                      <MenuItem
                        label="删除画布"
                        danger
                        onClick={() => {
                          useCanvas.getState().removeCanvas(c.id);
                          setMenuFor(null);
                        }}
                      />
                    </div>
                  </>
                )}
              </div>
            );
          })}
          <button
            className="w-full rounded-md border border-dashed border-bay-700 px-2 py-1.5 text-[13px] text-bone-400 transition-colors hover:border-sodium-600 hover:text-sodium-400"
            onClick={() => useCanvas.getState().createCanvas({})}
          >
            ＋ 新建画布
          </button>
        </div>
      )}
    </section>
  );
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      className={cn(
        'block w-full px-3 py-1.5 text-left text-[13px] hover:bg-bay-800',
        danger ? 'text-status-failed' : 'text-bone-200',
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** 从模型网关拉取能力清单：哪家适配器可用、什么价、什么档位 */
function ModelPanel() {
  const [models, setModels] = useState<GatewayModel[] | null>(null);
  const [skills, setSkills] = useState<{ key: string; version: string; title: string }[]>([]);
  const [providers, setProviders] = useState<{ image?: string; llm?: string; video?: string }>({});
  const [online, setOnline] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    const health = await gatewayHealth(true);
    setOnline(!!health?.ok);
    setProviders(health?.providers ?? { image: health?.image_provider });
    setSkills(health?.skills ?? []);
    setModels(health?.ok ? await listModels() : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="border-t border-bay-800 px-3 py-2">
      <div className="flex items-center gap-1.5">
        <span className="eyebrow">模型网关</span>
        <span
          className={cn(
            'size-[6px] rounded-full',
            online === null ? 'bg-status-idle' : online ? 'bg-status-success' : 'bg-status-failed',
          )}
          title={online ? '网关在线' : '网关离线（npm run api）'}
        />
        <span className="ml-auto font-mono text-[11.5px] text-bone-400">
          {online ? `img:${providers.image ?? '—'} llm:${providers.llm ?? '—'} vid:${providers.video ?? '—'}` : 'offline'}
        </span>
        <button className="font-mono text-[11.5px] text-bone-400 hover:text-sodium-400" onClick={() => void load()}>
          刷新
        </button>
      </div>
      {online === false && (
        <p className="mt-1 text-[12.5px] leading-relaxed text-bone-400">
          网关未启动 —— 图像/文案/视频都会回退到本地兜底。<span className="text-sodium-500">npm run api</span> 可启动。
        </p>
      )}
      {models?.map((m) => (
        <div key={`${m.capability}:${m.adapter}:${m.model}`} className="mt-1 flex items-center gap-1.5">
          <span className={cn('size-[5px] rounded-full', m.available ? 'bg-status-success' : 'bg-status-idle')} />
          <span className="truncate font-mono text-[12px] text-bone-300" title={m.note || m.model}>
            {m.adapter}
          </span>
          <span className="chip ml-auto shrink-0">{m.quality_tier}</span>
          <span className="shrink-0 font-mono text-[11.5px] text-bone-400">
            {m.price === 0 ? '免费' : `¥${m.price}/${m.price_unit.replace('per_', '')}`}
          </span>
        </div>
      ))}
      {skills.length > 0 && (
        <div className="mt-1.5 border-t border-bay-800 pt-1.5">
          <span className="eyebrow">skills</span>
          {skills.map((s) => (
            <div key={`${s.key}@${s.version}`} className="flex items-center gap-1.5">
              <span className="truncate font-mono text-[12px] text-bone-300">{s.key.replace('mva.', '')}</span>
              <span className="ml-auto shrink-0 font-mono text-[11.5px] text-sodium-500">v{s.version}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
