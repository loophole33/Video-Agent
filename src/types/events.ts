/** WebSocket 事件信封（与 docs/phase-2 §2.7 协议一致） */
import type { ArtifactRef, NodeStatus, NodeError } from './graph';

export type EventType =
  | 'run.status'
  | 'node.status'
  | 'node.progress'
  | 'node.artifact'
  | 'node.log'
  | 'patch.proposed'
  | 'patch.applied'
  | 'graph.updated'
  | 'cost.warning'
  | 'policy.blocked';

export interface RunStatusPayload {
  run_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'paused';
  progress: { total: number; success: number; running: number; failed: number; skipped: number };
  spent_cny: number;
  final_artifact?: ArtifactRef | null;
  mode: 'full' | 'subgraph' | 'single';
}

export interface NodeStatusPayload {
  node_id: string;
  status: NodeStatus;
  attempt: number;
  latency_ms?: number;
  cost_cny?: number;
  adapter?: string;
  model?: string;
  error?: NodeError | null;
}

export interface NodeProgressPayload {
  node_id: string;
  pct: number;
  stage: 'queued' | 'submitted' | 'polling' | 'downloading';
}

export interface NodeArtifactPayload {
  node_id: string;
  artifact: ArtifactRef;
  port: string;
}

export interface NodeLogPayload {
  node_id: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface CostWarningPayload {
  spent_cny: number;
  limit_cny: number;
  pct: number;
}

export interface PolicyBlockedPayload {
  node_id: string;
  stage: 'L1' | 'L2' | 'L3';
  categories: string[];
  message: string;
}

export interface MvaEvent<T extends EventType = EventType> {
  event_id: string;
  seq: number;
  ts: string;
  workflow_id: string;
  run_id?: string;
  trace_id?: string;
  type: T;
  payload: unknown;
}

export interface PayloadMap {
  'run.status': RunStatusPayload;
  'node.status': NodeStatusPayload;
  'node.progress': NodeProgressPayload;
  'node.artifact': NodeArtifactPayload;
  'node.log': NodeLogPayload;
  'patch.proposed': { patch_id: string; rationale: string; risk: string; ops_count: number; cost_delta_cny: number };
  'patch.applied': { patch_id: string; version: number; changed_node_ids: string[] };
  'graph.updated': { version: number };
  'cost.warning': CostWarningPayload;
  'policy.blocked': PolicyBlockedPayload;
}
