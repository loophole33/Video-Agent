import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { MvaNode, NodeData, PortDef, NodeTypeId, PortValue } from '../types/graph';

export type AccentKey = 'slate' | 'blue' | 'violet' | 'green' | 'amber' | 'rose' | 'cyan';

/** 声明式参数表单 —— 等价于设计稿里的 Zod schema：单一真相源，Inspector 与节点内联控件都由此生成 */
export interface ParamField {
  key: string;
  label: string;
  kind: 'text' | 'textarea' | 'number' | 'select' | 'toggle' | 'slider';
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  affectsCost?: boolean;
}

export interface NodeBodyProps {
  id: string;
  data: NodeData;
  outputs?: Partial<Record<string, PortValue>>;
  inputs: Record<string, PortValue | undefined>;
  /** 参数写回统一走 patch（可撤销）；由 BaseNode 注入，spec 不直接依赖 store */
  setParam: (key: string, value: unknown) => void;
  setParams: (patch: Record<string, unknown>) => void;
  /** 仅影响展示的 UI 状态（折叠、预览索引），不进 undo 栈 */
  setUi: (patch: Partial<NodeData['ui']>) => void;
}

export interface NodeTypeSpec {
  id: NodeTypeId;
  title: string;
  category: 'source' | 'generate' | 'process' | 'check' | 'output';
  icon: LucideIcon;
  accent: AccentKey;
  description: string;
  inputs: PortDef[];
  outputs: PortDef[];
  defaultParams: Record<string, unknown>;
  fields: ParamField[];
  Body: ComponentType<NodeBodyProps>;
  /** 本地粗估（<1ms），用于拖入节点/改档位时的即时成本反馈 */
  estimateCost: (params: Record<string, unknown>) => number;
  groupable: boolean;
}

export type { MvaNode };
