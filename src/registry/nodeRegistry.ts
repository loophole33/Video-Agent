import type { NodeTypeId } from '../types/graph';
import type { NodeTypeSpec } from './types';

/**
 * 节点注册表 —— 新增一种节点类型只需两步：
 *   ① 写一个 NodeTypeSpec（端口 + 参数 + Body 组件）
 *   ② 在 registry/index.ts 里 register(spec)
 * 画布核心（CanvasView / BaseNode / 校验 / 调度 / Inspector）零改动。
 */
class NodeRegistry {
  private specs = new Map<NodeTypeId, NodeTypeSpec>();

  register(spec: NodeTypeSpec) {
    if (this.specs.has(spec.id)) throw new Error(`duplicate node type: ${spec.id}`);
    this.specs.set(spec.id, spec);
    return this;
  }

  has(id: string): boolean {
    return this.specs.has(id as NodeTypeId);
  }

  get(id: NodeTypeId): NodeTypeSpec {
    const spec = this.specs.get(id);
    if (!spec) throw new Error(`unregistered node type: ${id}`);
    return spec;
  }

  list(): NodeTypeSpec[] {
    return [...this.specs.values()];
  }

  byGroup(): { category: NodeTypeSpec['category']; label: string; items: NodeTypeSpec[] }[] {
    const order: { category: NodeTypeSpec['category']; label: string }[] = [
      { category: 'source', label: '素材与输入' },
      { category: 'generate', label: '生成' },
      { category: 'process', label: '处理' },
      { category: 'check', label: '检查' },
      { category: 'output', label: '输出' },
    ];
    return order.map(({ category, label }) => ({
      category,
      label,
      items: this.list().filter((s) => s.category === category),
    }));
  }
}

export const nodeRegistry = new NodeRegistry();
export { NodeRegistry };
