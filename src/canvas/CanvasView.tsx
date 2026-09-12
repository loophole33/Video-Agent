import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { MvaEdge, MvaNode, PortType } from '../types/graph';
import { nodeRegistry } from '../registry';
import { useGraph } from '../store/graphStore';
import { useRun } from '../store/runStore';
import { useUi } from '../store/uiStore';
import { useAgent } from '../store/agentStore';
import { useCanvas } from '../store/canvasStore';
import { BaseNode } from '../nodes/BaseNode';
import { TypedEdge } from '../edges/TypedEdge';
import { validateConnection } from '../canvas/validation';
import { replaceOnPort } from '../canvas/validation';
import { QuickCreate } from './QuickCreate';
import { PORT_COLOR } from '../canvas/validation';
import { cn } from '../lib/utils';

const nodeTypes = { text: BaseNode, image: BaseNode, video: BaseNode, audio: BaseNode, script: BaseNode, prompt_compile: BaseNode, qa_check: BaseNode, compose: BaseNode, group: GroupNodeView };
const edgeTypes = { typed: TypedEdge };

function GroupNodeView({ data }: NodeProps) {
  const label = String((data as { label?: string }).label ?? '分组');
  return (
    <div className="h-full w-full rounded-lg border border-dashed border-bone-400/25 bg-bone-100/[0.03]">
      <span className="absolute -top-[9px] left-3 rounded-sm border border-bay-700 bg-bay-900 px-1.5 py-[1px] font-mono text-[11.5px] tracking-wider text-bone-400">
        {label}
      </span>
    </div>
  );
}

function CanvasInner() {
  const graphNodes = useGraph((s) => s.graph.nodes);
  const graphEdges = useGraph((s) => s.graph.edges);
  const version = useGraph((s) => s.graph.version);
  const apply = useGraph((s) => s.applyLocal);
  const setSelection = useUi((s) => s.setSelection);
  const setGhost = useUi((s) => s.setGhostOps);
  const ghostOps = useUi((s) => s.ghostOps);
  const { screenToFlowPosition, fitView, getViewport } = useReactFlow();

  const [nodes, setNodes] = useState<MvaNode[]>(graphNodes);
  const [edges, setEdges] = useState<MvaEdge[]>(graphEdges);
  const dragging = useRef(false);

  // 结构性变更（含 Agent 应用、撤销）后重同步
  useEffect(() => {
    setNodes((prev) => graphNodes.map((n) => ({ ...n, selected: prev.find((p) => p.id === n.id)?.selected })));
    setEdges(graphEdges);
  }, [version, graphNodes, graphEdges]);

  // 首次有节点时定位到起始两列（保持可读字号），全图形态看右下角缩略图
  const didFit = useRef(false);
  useEffect(() => {
    if (didFit.current || !graphNodes.length) return;
    didFit.current = true;
    const firstTwo = [...graphNodes]
      .filter((n) => n.type !== 'group')
      .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y)
      .slice(0, 2)
      .map((n) => ({ id: n.id }));
    window.setTimeout(() => {
      if (firstTwo.length >= 2) fitView({ nodes: firstTwo, padding: 0.06, maxZoom: 1, duration: 420 });
      else fitView({ padding: 0.2, duration: 420 });
    }, 90);
  }, [graphNodes, fitView]);

  const onNodesChange = useCallback(
    (changes: NodeChange<MvaNode>[]) => {
      setNodes((prev) => {
        let next = prev;
        for (const c of changes) {
          if (c.type === 'add') {
            next = [...next, c.item];
            continue;
          }
          if (c.type === 'position' && c.position) {
            next = next.map((n) => (n.id === c.id ? { ...n, position: c.position! } : n));
            dragging.current = !!c.dragging;
            if (!c.dragging) {
              // 拖动结束提交一次 move 补丁（进 undo 栈）
              apply([{ op: 'move', node_id: c.id, position: c.position }], '移动节点');
            }
          } else if (c.type === 'select') {
            next = next.map((n) => (n.id === c.id ? { ...n, selected: c.selected } : n));
          } else if (c.type === 'remove') {
            next = next.filter((n) => n.id !== c.id);
            apply([{ op: 'remove_node', node_id: c.id }], '删除节点');
          }
        }
        return next;
      });
      if (changes.some((c) => c.type === 'select')) {
        const sel = changes
          .filter((c): c is Extract<NodeChange<MvaNode>, { type: 'select' }> => c.type === 'select' && c.selected)
          .map((c) => c.id);
        setSelection(sel);
      }
    },
    [apply, setSelection],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<MvaEdge>[]) => {
      for (const c of changes) {
        if (c.type === 'remove') apply([{ op: 'disconnect', edge_id: c.id }], '断开连线');
      }
      setEdges((prev) => {
        let next = prev;
        for (const c of changes) {
          if (c.type === 'select') next = next.map((e) => (e.id === c.id ? { ...e, selected: c.selected } : e));
          if (c.type === 'remove') next = next.filter((e) => e.id !== c.id);
        }
        return next;
      });
    },
    [apply],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      const graph = useGraph.getState().graph;
      const res = validateConnection(conn, graph, (id) => {
        const n = graph.nodes.find((x) => x.id === id);
        return n && n.type !== 'group' ? nodeRegistry.get(n.data.type) : { inputs: [], outputs: [] };
      });
      if (!res.ok) {
        useUi.getState().toast('error', res.reason ?? '连线被拒绝');
        return;
      }
      if (res.severity === 'warn') useUi.getState().toast('warn', res.reason!);

      const targetNode = graph.nodes.find((x) => x.id === conn.target);
      const spec = targetNode ? nodeRegistry.get(targetNode.data.type) : null;
      const port = spec?.inputs.find((p) => `in:${p.id}` === conn.targetHandle);
      const portType = (port?.type ?? 'any') as PortType;
      const newEdge: MvaEdge = {
        id: `e_${Math.random().toString(36).slice(2, 9)}`,
        source: conn.source!,
        sourceHandle: conn.sourceHandle ?? undefined,
        target: conn.target!,
        targetHandle: conn.targetHandle ?? undefined,
        type: 'typed',
        data: { portType },
      };
      const ops = [];
      const occupied = graph.edges.filter(
        (e) => e.target === conn.target && e.targetHandle === conn.targetHandle,
      );
      if (occupied.length && !port?.multi) {
        occupied.forEach((e) => ops.push({ op: 'disconnect' as const, edge_id: e.id }));
      }
      ops.push({ op: 'connect' as const, edge: newEdge });
      apply(ops, '连线');
      void replaceOnPort;
    },
    [apply],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const nodeType = event.dataTransfer.getData('application/mva-node');
      if (nodeType && nodeRegistry.has(nodeType)) {
        const base = screenToFlowPosition({ x: event.clientX, y: event.clientY });
        const spec = nodeRegistry.get(nodeType as MvaNode['data']['type']);
        const node: MvaNode = {
          id: `n_${Math.random().toString(36).slice(2, 9)}`,
          type: spec.id,
          position: { x: Math.round(base.x / 8) * 8, y: Math.round(base.y / 8) * 8 },
          data: {
            type: spec.id,
            label: spec.title,
            params: { ...spec.defaultParams },
            status: 'idle',
            locked: false,
            enabled: true,
            createdBy: 'user',
            ui: {},
          },
        };
        apply([{ op: 'add_node', node }], `拖入 ${spec.title}`);
        useUi.getState().setSelection([node.id]);
        return;
      }

      const files = Array.from(event.dataTransfer.files ?? []);
      if (!files.length) return;
      const base = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      files.forEach((file, i) => {
        const type: 'image' | 'video' | 'audio' = file.type.startsWith('video')
          ? 'video'
          : file.type.startsWith('audio')
            ? 'audio'
            : 'image';
        const spec = nodeRegistry.get(type);
        const url = URL.createObjectURL(file);
        const id = `n_${Math.random().toString(36).slice(2, 9)}`;
        const node: MvaNode = {
          id,
          type,
          position: { x: base.x + i * 40, y: base.y + i * 40 },
          data: {
            type,
            label: file.name.slice(0, 18),
            params: { ...spec.defaultParams },
            status: 'idle',
            locked: false,
            enabled: true,
            createdBy: 'user',
            ui: {},
          },
        };
        const kind = type === 'video' ? 'video' : type === 'audio' ? 'audio' : 'image';
        useRun.getState().patchRuntime(id, {
          status: 'success',
          outputs: {
            out: {
              type: kind,
              items: [
                {
                  id: `art_up_${id}`,
                  kind,
                  url,
                  thumbUrl: url,
                  mime: file.type || 'application/octet-stream',
                  digest: `local-${file.size}`,
                  meta: { uploaded: true, size: file.size, portrait: false },
                },
              ],
            },
          },
          runMeta: { attempt: 1, latencyMs: 0, costCny: 0, adapter: 'local-upload', model: '—' },
        });
        apply(
          [
            { op: 'add_node', node },
            { op: 'group', group_id: 'g_media', node_ids: [id], label: '我的素材' },
          ],
          '导入素材',
        );
        useUi.getState().toast('success', `已导入素材 ${file.name.slice(0, 20)}（L1 审核通过）`);
      });
    },
    [apply, screenToFlowPosition],
  );

  // 键盘快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA';
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? useGraph.getState().redo() : useGraph.getState().undo();
        return;
      }
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        const ids = useUi.getState().selectedIds;
        if (ids.length >= 2) {
          const gid = `g_${Math.random().toString(36).slice(2, 7)}`;
          apply([{ op: 'group', group_id: gid, node_ids: ids, label: '分组' }], '打组');
          useUi.getState().toast('success', `已打组 ${ids.length} 个节点`);
        } else useUi.getState().toast('warn', '至少选中两个节点才能打组');
        return;
      }
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        useCanvas.getState().saveActive();
        useGraph.getState().markSaved();
        useUi.getState().toast('success', '已保存（画布快照 + 本地持久化）');
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        useCanvas.getState().createCanvas({});
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const ids = useUi.getState().selectedIds;
        const g = useGraph.getState().graph;
        const ops = ids
          .map((id) => g.nodes.find((n) => n.id === id))
          .filter(Boolean)
          .map((n) => ({
            op: 'add_node' as const,
            node: {
              ...structuredClone(n!),
              id: `n_${Math.random().toString(36).slice(2, 9)}`,
              position: { x: n!.position.x + 40, y: n!.position.y + 60 },
            },
          }));
        if (ops.length) apply(ops, '复制节点');
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const ids = useUi.getState().selectedIds;
        if (ids.length) apply(ids.map((id) => ({ op: 'remove_node' as const, node_id: id })), '删除节点');
        return;
      }
      if (e.key === 'f' || e.key === 'F') fitView({ padding: 0.18, duration: 260 });
      if (e.key === 'Escape') setSelection([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [apply, fitView, setSelection]);

  // Agent 幽灵预览：把提案节点以半透明形式渲染（不落图）
  const ghostNodes = useMemo<MvaNode[]>(() => {
    if (!ghostOps) return [];
    return ghostOps
      .filter((o): o is Extract<typeof o, { op: 'add_node' }> => o.op === 'add_node')
      .map((o) => ({
        ...o.node,
        id: `ghost_${o.node.id}`,
        selectable: false,
        draggable: false,
        data: { ...o.node.data, label: `◌ ${o.node.data.label}` },
        style: { opacity: 0.45, pointerEvents: 'none' as const },
      }));
  }, [ghostOps]);

  const displayNodes = useMemo(() => [...nodes, ...ghostNodes], [nodes, ghostNodes]);

  return (
    <ReactFlow
      nodes={displayNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      isValidConnection={(c) =>
        validateConnection(c as Connection, useGraph.getState().graph, (id) => {
          const n = useGraph.getState().graph.nodes.find((x) => x.id === id);
          return n && n.type !== 'group' ? nodeRegistry.get(n.data.type) : { inputs: [], outputs: [] };
        }).ok
      }
      onDrop={onDrop}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDoubleClick={(e) => {
        const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        useUi.getState().openQuickCreate(flow, { x: e.clientX, y: e.clientY });
      }}
      onPaneClick={() => {
        setSelection([]);
        setGhost(null);
      }}
      onMoveEnd={() => useGraph.getState().setViewport(getViewport())}
      connectionMode={ConnectionMode.Strict}
      defaultEdgeOptions={{ type: 'typed' }}
      panOnScroll
      selectionOnDrag
      zoomOnDoubleClick={false}
      minZoom={0.12}
      maxZoom={2}
      snapToGrid
      snapGrid={[8, 8]}
      onlyRenderVisibleElements
      proOptions={{ hideAttribution: true }}
      className="bg-bay-950"
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#2C2724" />
      <Controls position="bottom-left" showInteractive={false} />
      <MiniMap
        position="bottom-right"
        pannable
        zoomable
        maskColor="rgba(14,12,11,0.72)"
        nodeColor={(n) => {
          const t = (n.data as { type?: string })?.type;
          return t && nodeRegistry.has(t) ? `#${'8A8578'}` : '#3A342F';
        }}
        nodeStrokeColor="#14110F"
      />
      <Panel position="top-left" className="!m-3">
        <PortLegend />
      </Panel>
      <QuickCreate />
    </ReactFlow>
  );
}

function PortLegend() {
  const items: { type: PortType; label: string }[] = [
    { type: 'text', label: 'text' },
    { type: 'image', label: 'image' },
    { type: 'video', label: 'video' },
    { type: 'audio', label: 'audio' },
    { type: 'json', label: 'json' },
    { type: 'any', label: 'any' },
  ];
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-md border border-bay-800 bg-bay-900/85 px-2 py-1.5 backdrop-blur">
      <button className="eyebrow flex items-center gap-1" onClick={() => setOpen((o) => !o)}>
        port types {open ? '▾' : '▸'}
      </button>
      {open && (
        <div className="mt-1 flex items-center gap-2">
          {items.map((i) => (
            <span key={i.type} className="flex items-center gap-1">
              <span className="size-2 rounded-[2px]" style={{ background: PORT_COLOR[i.type] }} />
              <span className={cn('font-mono text-[11.5px] text-bone-400')}>{i.label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function CanvasView() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}

export { useAgent };
