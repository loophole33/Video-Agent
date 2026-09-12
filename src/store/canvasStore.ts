/**
 * 多画布：每个画布 = 一份独立的 WorkflowGraph + 它自己的运行态快照。
 * 切换画布时先把当前图与运行态存回快照，再加载目标画布 —— 来回切换不丢进度。
 * 全部持久化到 localStorage（刷新后仍在）。
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { WorkflowGraph } from '../types/graph';
import type { LogEntry, NodeRuntime } from './runStore';
import { useGraph } from './graphStore';
import { useRun } from './runStore';
import { useUi } from './uiStore';
import { TEMPLATES } from '../data/templates';
import { nodeRegistry } from '../registry';

export interface RunSnapshot {
  runId: string | null;
  status: string;
  mode: 'full' | 'subgraph' | 'single' | null;
  spentCny: number;
  startedAt: number | null;
  finishedAt: number | null;
  progress: { total: number; success: number; running: number; failed: number; skipped: number };
  runtime: Record<string, NodeRuntime>;
  logs: LogEntry[];
}

export interface CanvasEntry {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  graph: WorkflowGraph;
  snapshot: RunSnapshot;
}

interface CanvasState {
  canvases: CanvasEntry[];
  activeId: string;
  /** 从模板创建新画布；不传模板则创建空画布 */
  createCanvas: (opts?: { name?: string; templateId?: string }) => string;
  /** 复制当前（或指定）画布 —— 常用于"在旧版基础上改一版" */
  duplicateCanvas: (id?: string) => string;
  renameCanvas: (id: string, name: string) => void;
  removeCanvas: (id: string) => void;
  activateCanvas: (id: string) => void;
  /** 把当前 store 状态写回快照（切换前/定时调用） */
  saveActive: () => void;
  /** 启动时把持久化的当前画布装载进 store */
  hydrate: () => void;
  importCanvas: (doc: unknown) => { ok: boolean; message: string };
  exportCanvas: (id?: string) => string;
}

const STORAGE_KEY = 'mva.canvases.v1';

const emptySnapshot = (): RunSnapshot => ({
  runId: null,
  status: 'idle',
  mode: null,
  spentCny: 0,
  startedAt: null,
  finishedAt: null,
  progress: { total: 0, success: 0, running: 0, failed: 0, skipped: 0 },
  runtime: {},
  logs: [],
});

function emptyGraph(name: string): WorkflowGraph {
  return {
    schemaVersion: '1.0.0',
    id: `wf_${Math.random().toString(36).slice(2, 9)}`,
    name,
    version: 1,
    viewport: { x: 0, y: 0, zoom: 0.85 },
    nodes: [],
    edges: [],
    groups: [],
    constraints: { budgetLimitCny: 8, platform: 'douyin', ratio: '9:16' },
  };
}

function templateGraph(templateId: string, name: string): WorkflowGraph {
  const tpl = TEMPLATES.find((t) => t.id === templateId) ?? TEMPLATES[0];
  const vars: Record<string, unknown> = {};
  tpl.variables.forEach((v) => (vars[v.key] = v.default));
  const { nodes, edges } = tpl.build(vars, { x: 40, y: 60 });
  return { ...emptyGraph(name), nodes, edges };
}

function currentSnapshot(): RunSnapshot {
  const r = useRun.getState();
  return {
    runId: r.runId,
    status: r.status,
    mode: r.mode,
    spentCny: r.spentCny,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    progress: { ...r.progress },
    runtime: structuredClone(r.runtime),
    logs: structuredClone(r.logs),
  };
}

function loadFromStorage(): { canvases: CanvasEntry[]; activeId: string } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { canvases: CanvasEntry[]; activeId: string };
    if (!parsed?.canvases?.length) return null;
    // 丢弃已不存在的节点类型（版本升级后老数据不至于崩）
    parsed.canvases.forEach((c) => {
      c.graph.nodes = c.graph.nodes.filter((n) => n.type === 'group' || nodeRegistry.has(n.data.type));
      c.snapshot = { ...emptySnapshot(), ...c.snapshot };
    });
    return parsed;
  } catch {
    return null;
  }
}

function persist(canvases: CanvasEntry[], activeId: string) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ canvases, activeId }));
  } catch {
    /* 容量/隐私模式等问题不影响使用 */
  }
}

function bootState(): { canvases: CanvasEntry[]; activeId: string } {
  const restored = loadFromStorage();
  if (restored) return restored;
  const g = templateGraph('tpl_ugc_20s', '气泡水 20s 抖音种草');
  const entry: CanvasEntry = {
    id: g.id,
    name: g.name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    graph: g,
    snapshot: emptySnapshot(),
  };
  return { canvases: [entry], activeId: entry.id };
}

export const useCanvas = create<CanvasState>()(
  immer((set, get) => ({
    ...bootState(),

    createCanvas: ({ name, templateId } = {}) => {
      get().saveActive();
      const label = name?.trim() || `未命名画布 ${get().canvases.length + 1}`;
      const graph = templateId ? templateGraph(templateId, label) : emptyGraph(label);
      const entry: CanvasEntry = {
        id: graph.id,
        name: graph.name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        graph,
        snapshot: emptySnapshot(),
      };
      set((s) => {
        s.canvases.push(entry);
        s.activeId = entry.id;
      });
      applyEntry(entry);
      persist(get().canvases, get().activeId);
      useUi.getState().toast('success', `已新建画布「${entry.name}」${templateId ? '（已套用模板）' : '（空白，双击画布加节点）'}`);
      return entry.id;
    },

    duplicateCanvas: (id) => {
      get().saveActive();
      const src = get().canvases.find((c) => c.id === (id ?? get().activeId));
      if (!src) return get().activeId;
      const graph = structuredClone(src.graph);
      graph.id = `wf_${Math.random().toString(36).slice(2, 9)}`;
      graph.name = `${src.name} 副本`;
      graph.version = 1;
      const entry: CanvasEntry = {
        id: graph.id,
        name: graph.name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        graph,
        snapshot: emptySnapshot(),
      };
      set((s) => {
        s.canvases.push(entry);
        s.activeId = entry.id;
      });
      applyEntry(entry);
      persist(get().canvases, get().activeId);
      useUi.getState().toast('success', `已复制为「${entry.name}」`);
      return entry.id;
    },

    renameCanvas: (id, name) => {
      set((s) => {
        const c = s.canvases.find((x) => x.id === id);
        if (c) {
          c.name = name;
          c.updatedAt = Date.now();
          if (c.id === s.activeId) c.graph.name = name;
        }
      });
      if (id === get().activeId) useGraph.setState((s) => { s.graph.name = name; });
      persist(get().canvases, get().activeId);
    },

    removeCanvas: (id) => {
      const { canvases } = get();
      if (canvases.length <= 1) {
        useUi.getState().toast('warn', '至少保留一个画布');
        return;
      }
      const idx = canvases.findIndex((c) => c.id === id);
      const wasActive = get().activeId === id;
      set((s) => {
        s.canvases = s.canvases.filter((c) => c.id !== id);
        if (wasActive) s.activeId = s.canvases[Math.max(0, idx - 1)].id;
      });
      if (wasActive) {
        const next = get().canvases.find((c) => c.id === get().activeId);
        if (next) applyEntry(next);
      }
      persist(get().canvases, get().activeId);
      useUi.getState().toast('info', '画布已删除');
    },

    activateCanvas: (id) => {
      if (id === get().activeId) return;
      // 运行中不让切换：执行引擎按节点 id 写运行态，中途换图会串台
      if (useRun.getState().status === 'running') {
        useUi.getState().toast('warn', '当前画布正在运行，等完成或取消后再切换');
        return;
      }
      get().saveActive();
      const next = get().canvases.find((c) => c.id === id);
      if (!next) return;
      set((s) => {
        s.activeId = id;
      });
      applyEntry(next);
      persist(get().canvases, get().activeId);
      useUi.getState().toast('info', `已切换到「${next.name}」`);
    },

    hydrate: () => {
      const c = get().canvases.find((x) => x.id === get().activeId) ?? get().canvases[0];
      if (c) applyEntry(c);
    },

    saveActive: () =>
      set((s) => {
        const c = s.canvases.find((x) => x.id === s.activeId);
        if (!c) return;
        c.graph = structuredClone(useGraph.getState().graph);
        c.name = c.graph.name;
        c.snapshot = currentSnapshot();
        c.updatedAt = Date.now();
        persist(s.canvases, s.activeId);
      }),

    importCanvas: (doc) => {
      try {
        const obj = doc as { kind?: string; payload?: unknown; nodes?: unknown; graph?: unknown };
        const graph = (obj?.graph ?? obj?.payload ?? obj) as WorkflowGraph;
        if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) {
          return { ok: false, message: '缺少 nodes / edges' };
        }
        get().saveActive();
        const g = structuredClone(graph);
        g.id = `wf_${Math.random().toString(36).slice(2, 9)}`;
        g.name = graph.name || '导入的画布';
        g.version = 1;
        g.nodes = g.nodes.filter((n) => n.type === 'group' || nodeRegistry.has(n.data?.type));
        const entry: CanvasEntry = {
          id: g.id, name: g.name, createdAt: Date.now(), updatedAt: Date.now(),
          graph: g, snapshot: emptySnapshot(),
        };
        set((s) => {
          s.canvases.push(entry);
          s.activeId = entry.id;
        });
        applyEntry(entry);
        persist(get().canvases, get().activeId);
        return { ok: true, message: `已导入 ${g.nodes.length} 节点 / ${g.edges.length} 连线` };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },

    exportCanvas: (id) => {
      const c = get().canvases.find((x) => x.id === (id ?? get().activeId));
      if (!c) return '{}';
      get().saveActive();
      const latest = get().canvases.find((x) => x.id === c.id) ?? c;
      return JSON.stringify({ kind: 'mva.canvas', schemaVersion: '1.0.0', exportedAt: new Date().toISOString(), graph: latest.graph }, null, 2);
    },
  })),
);

/** 把某个画布的图与运行态装载进 store */
function applyEntry(entry: CanvasEntry) {
  useGraph.getState().replaceGraph(structuredClone(entry.graph));
  const r = useRun.getState();
  r.resetRuntime();
  const snap = entry.snapshot;
  useRun.setState((s) => {
    s.runId = snap.runId;
    s.status = snap.status as typeof s.status;
    s.mode = snap.mode;
    s.spentCny = snap.spentCny;
    s.startedAt = snap.startedAt;
    s.finishedAt = snap.finishedAt;
    s.progress = { ...snap.progress };
    s.runtime = structuredClone(snap.runtime);
    s.logs = structuredClone(snap.logs);
  });
}

/** 自动保存：图或运行态变化后防抖写回当前画布快照 */
let saveTimer: number | undefined;
export function scheduleCanvasSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => useCanvas.getState().saveActive(), 800);
}
