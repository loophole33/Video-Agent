/**
 * MVA 工作流 DSL —— 前后端唯一真相源的同构类型定义
 * （此处为前端实现，字段与 docs/phase-5 §5.1 的 TS 定义逐字一致）
 */
import type { Node, Edge, Connection, XYPosition } from '@xyflow/react';

export type PortType = 'text' | 'image' | 'video' | 'audio' | 'json' | 'any';

export type NodeTypeId =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'script'
  | 'prompt_compile'
  | 'qa_check'
  | 'compose';

export type NodeStatus =
  | 'idle'
  | 'stale'
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'blocked';

export interface PortDef {
  id: string;
  label: string;
  type: PortType;
  required?: boolean;
  multi?: boolean;
  maxConnections?: number;
}

export interface ArtifactRef {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'text' | 'json' | 'report' | 'final';
  url: string;
  thumbUrl?: string;
  mime: string;
  width?: number;
  height?: number;
  durationMs?: number;
  digest: string;
  meta?: Record<string, unknown>;
}

export type PortValue =
  | { type: 'image' | 'video' | 'audio'; items: ArtifactRef[] }
  | { type: 'text'; text: string }
  | { type: 'json'; value: unknown };

export type ErrorClass =
  | 'transient'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'content_blocked'
  | 'invalid_request'
  | 'fatal'
  | 'policy_blocked';

export interface NodeError {
  class: ErrorClass;
  message: string;
  retryable: boolean;
  code?: string;
}

export interface NodeData extends Record<string, unknown> {
  type: NodeTypeId;
  label: string;
  params: Record<string, unknown>;
  status: NodeStatus;
  locked: boolean;
  enabled: boolean;
  createdBy: 'user' | 'agent' | 'template';
  groupId?: string;
  progress?: { pct: number; stage: 'queued' | 'submitted' | 'polling' | 'downloading' };
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
  /** 用户手动钉住的产物（优先级高于数据流），portId -> artifactId */
  pinnedInputs?: Record<string, string>;
  ui: { collapsed?: boolean; previewIndex?: number };
}

export type MvaNode = Node<NodeData, NodeTypeId | 'group'>;
export type MvaEdge = Edge<{ flow?: boolean; portType?: PortType }>;

export interface MvaGroup {
  id: string;
  label: string;
  nodeIds: string[];
  color: string;
}

export interface WorkflowGraph {
  schemaVersion: '1.0.0';
  id: string;
  name: string;
  version: number;
  viewport: { x: number; y: number; zoom: number };
  nodes: MvaNode[];
  edges: MvaEdge[];
  groups: MvaGroup[];
  constraints: { budgetLimitCny: number; platform: string; ratio: string };
}

/* ── 补丁（GraphPatch）── */

export type PatchOp =
  | { op: 'add_node'; node: MvaNode }
  | { op: 'remove_node'; node_id: string }
  | { op: 'update_node_params'; node_id: string; params: Record<string, unknown> }
  | { op: 'connect'; edge: MvaEdge }
  | { op: 'disconnect'; edge_id: string }
  | { op: 'move'; node_id: string; position: { x: number; y: number } }
  | { op: 'group'; group_id: string; node_ids: string[]; label?: string }
  | { op: 'ungroup'; group_id: string }
  | { op: 'pin_input'; node_id: string; port_id: string; artifact_id: string | null }
  | { op: 'set_status'; node_id: string; status: NodeStatus };

export interface GraphPatch {
  patch_id: string;
  base_version: number;
  rationale: string;
  author: 'user' | 'agent' | 'template';
  risk?: 'low' | 'medium' | 'high';
  ops: PatchOp[];
}

export interface Conflict {
  op: PatchOp;
  reason: string;
  kept?: string;
  field?: string;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  variables: { key: string; label: string; type: 'string' | 'string[]'; default: unknown }[];
  build: (vars: Record<string, unknown>, origin: { x: number; y: number }) => {
    nodes: MvaNode[];
    edges: MvaEdge[];
  };
}

export type { Node, Edge, Connection, XYPosition };
