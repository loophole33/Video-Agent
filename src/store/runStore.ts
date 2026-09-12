import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { ArtifactRef, NodeError, NodeStatus, PortValue } from '../types/graph';
import type { MvaEvent, RunStatusPayload } from '../types/events';

export interface NodeRuntime {
  status: NodeStatus;
  progress?: { pct: number; stage: string };
  outputs?: Partial<Record<string, PortValue>>;
  error?: NodeError;
  runMeta?: {
    nodeRunId?: string;
    attempt: number;
    latencyMs?: number;
    costCny?: number;
    adapter?: string;
    model?: string;
  };
}

export interface LogEntry {
  seq: number;
  ts: number;
  nodeId?: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

interface RunState {
  runId: string | null;
  status: RunStatusPayload['status'] | 'idle';
  mode: 'full' | 'subgraph' | 'single' | null;
  spentCny: number;
  progress: RunStatusPayload['progress'];
  startedAt: number | null;
  finishedAt: number | null;
  finalArtifact: ArtifactRef | null;
  runtime: Record<string, NodeRuntime>;
  logs: LogEntry[];
  wsOnline: boolean;
  wsSeq: number;
  wsReconnects: number;
  missedWhileOffline: number;

  // 运行时写入（不进 undo 栈）
  patchRuntime: (nodeId: string, patch: Partial<NodeRuntime>) => void;
  resetRuntime: () => void;
  markStale: (ids: string[]) => void;
  startRun: (args: { runId: string; mode: RunState['mode']; budget: number }) => void;
  clearNodeStatuses: () => void;
  ingest: (evt: MvaEvent) => void;
  pushLog: (e: Omit<LogEntry, 'seq' | 'ts'> & { ts?: number }) => void;
  setWsOnline: (b: boolean) => void;
}

export const useRun = create<RunState>()(
  immer((set, get) => ({
    runId: null,
    status: 'idle',
    mode: null,
    spentCny: 0,
    progress: { total: 0, success: 0, running: 0, failed: 0, skipped: 0 },
    startedAt: null,
    finishedAt: null,
    finalArtifact: null,
    runtime: {},
    logs: [],
    wsOnline: true,
    wsSeq: 0,
    wsReconnects: 0,
    missedWhileOffline: 0,

    patchRuntime: (nodeId, patch) =>
      set((s) => {
        s.runtime[nodeId] = { ...(s.runtime[nodeId] ?? { status: 'idle', runMeta: { attempt: 1 } }), ...patch };
      }),

    resetRuntime: () =>
      set((s) => {
        s.runId = null;
        s.status = 'idle';
        s.mode = null;
        s.spentCny = 0;
        s.progress = { total: 0, success: 0, running: 0, failed: 0, skipped: 0 };
        s.startedAt = null;
        s.finishedAt = null;
        s.finalArtifact = null;
        s.runtime = {};
        s.logs = [];
      }),

    markStale: (ids) =>
      set((s) => {
        for (const id of ids) {
          const cur = s.runtime[id];
          if (!cur) continue;
          if (cur.status === 'success' || cur.status === 'failed') cur.status = 'stale';
        }
      }),

    clearNodeStatuses: () =>
      set((s) => {
        s.runtime = {};
      }),

    startRun: ({ runId, mode, budget }) =>
      set((s) => {
        s.runId = runId;
        s.mode = mode;
        s.status = 'queued';
        s.spentCny = 0;
        s.startedAt = Date.now();
        s.finishedAt = null;
        s.finalArtifact = null;
        s.progress = { total: 0, success: 0, running: 0, failed: 0, skipped: 0 };
        s.runtime = {};
        s.logs = [];
        void budget;
      }),

    ingest: (evt) =>
      set((s) => {
        s.wsSeq = Math.max(s.wsSeq, evt.seq);
        switch (evt.type) {
          case 'run.status': {
            const p = evt.payload as RunStatusPayload;
            s.status = p.status;
            s.progress = p.progress;
            s.spentCny = p.spent_cny;
            if (p.final_artifact) s.finalArtifact = p.final_artifact;
            if (p.status === 'succeeded' || p.status === 'failed' || p.status === 'partial')
              s.finishedAt = Date.now();
            break;
          }
          case 'node.status': {
            const p = evt.payload as {
              node_id: string;
              status: NodeStatus;
              attempt: number;
              latency_ms?: number;
              cost_cny?: number;
              adapter?: string;
              model?: string;
              error?: NodeError | null;
            };
            const prev = s.runtime[p.node_id] ?? { status: 'idle', runMeta: { attempt: 1 } };
            s.runtime[p.node_id] = {
              ...prev,
              status: p.status,
              error: p.error ?? undefined,
              progress: p.status === 'running' ? prev.progress : undefined,
              runMeta: {
                attempt: p.attempt,
                latencyMs: p.latency_ms ?? prev.runMeta?.latencyMs,
                costCny: p.cost_cny ?? prev.runMeta?.costCny,
                adapter: p.adapter ?? prev.runMeta?.adapter,
                model: p.model ?? prev.runMeta?.model,
              },
            };
            break;
          }
          case 'node.progress': {
            const p = evt.payload as { node_id: string; pct: number; stage: string };
            const prev = s.runtime[p.node_id] ?? { status: 'running' as NodeStatus, runMeta: { attempt: 1 } };
            s.runtime[p.node_id] = { ...prev, status: 'running', progress: { pct: p.pct, stage: p.stage } };
            break;
          }
          case 'node.artifact': {
            const p = evt.payload as { node_id: string; artifact: ArtifactRef; port: string };
            const prev = s.runtime[p.node_id] ?? { status: 'running' as NodeStatus, runMeta: { attempt: 1 } };
            const existing = prev.outputs?.[p.port];
            const items =
              existing && 'items' in existing ? [...existing.items, p.artifact] : [p.artifact];
            // 'final' / 'report' 这类产物在端口上按 video / json 语义传递
            const portType =
              p.artifact.kind === 'final' ? 'video' : p.artifact.kind === 'report' ? 'json' : p.artifact.kind;
            s.runtime[p.node_id] = {
              ...prev,
              outputs: { ...(prev.outputs ?? {}), [p.port]: { type: portType as 'image', items } },
            };
            break;
          }
          case 'node.log': {
            const p = evt.payload as { node_id: string; level: LogEntry['level']; message: string };
            s.logs.push({ seq: evt.seq, ts: Date.parse(evt.ts), nodeId: p.node_id, level: p.level, message: p.message });
            break;
          }
        }
      }),

    pushLog: (e) =>
      set((s) => {
        s.logs.push({ seq: s.logs.length + 1, ts: e.ts ?? Date.now(), nodeId: e.nodeId, level: e.level, message: e.message });
        if (s.logs.length > 400) s.logs.splice(0, s.logs.length - 400);
      }),

    setWsOnline: (b) =>
      set((s) => {
        if (s.wsOnline && !b) s.wsReconnects += 1;
        s.wsOnline = b;
      }),
  })),
);

/** 便捷选择器：节点运行态（含图内默认值回退） */
export function runtimeOf(state: RunState, nodeId: string, fallback: NodeRuntime): NodeRuntime {
  return state.runtime[nodeId] ?? fallback;
}
