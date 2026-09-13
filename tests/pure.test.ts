/**
 * 纯核心单元测试 —— 这些函数是「前后端同构」的部分，必须与后端 Python 实现行为一致。
 * 运行：npm test
 */
import { describe, expect, it } from 'vitest';
import { applyPatch, invertOps, makePatch } from '../src/canvas/applyPatch';
import { buildPlan, CycleError, downstreamOf } from '../src/canvas/topo';
import { COMPAT, createsCycle, validateConnection, withUpstream } from '../src/canvas/validation';
import { editWorkflow, parseBrief, planWorkflow } from '../src/engine/mockAgent';
import { graphCost, patchDeltaCost } from '../src/lib/cost';
import { nodeRegistry } from '../src/registry';
import type { MvaEdge, MvaNode, PortType, WorkflowGraph } from '../src/types/graph';

/* ── 测试夹具 ── */
function mkNode(type: MvaNode['data']['type'], id: string, params: Record<string, unknown> = {}): MvaNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: {
      type,
      label: id,
      params: { ...nodeRegistry.get(type).defaultParams, ...params },
      status: 'idle',
      locked: false,
      enabled: true,
      createdBy: 'user',
      ui: {},
    },
  };
}
const mkEdge = (s: string, sh: string, t: string, th: string, portType: PortType = 'any'): MvaEdge => ({
  id: `e_${s}_${t}`,
  source: s,
  sourceHandle: sh,
  target: t,
  targetHandle: th,
  type: 'typed',
  data: { portType },
});
function graph(nodes: MvaNode[], edges: MvaEdge[] = []): WorkflowGraph {
  return {
    schemaVersion: '1.0.0',
    id: 'wf_test',
    name: 'test',
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes,
    edges,
    groups: [],
    constraints: { budgetLimitCny: 8, platform: 'douyin', ratio: '9:16' },
  };
}

/* ── applyPatch / invertOps ── */
describe('applyPatch', () => {
  it('应用后不改原图（纯函数）', () => {
    const g = graph([mkNode('text', 'n_a')]);
    const next = applyPatch(g, [{ op: 'add_node', node: mkNode('image', 'n_b') }]);
    expect(g.nodes).toHaveLength(1);
    expect(next.nodes).toHaveLength(2);
  });

  it('remove_node 同时清理相连的边与分组引用', () => {
    const g = graph([mkNode('text', 'n_a'), mkNode('image', 'n_b')], [mkEdge('n_a', 'out:out', 'n_b', 'in:prompt')]);
    g.groups = [{ id: 'g1', label: 'g', nodeIds: ['n_a', 'n_b'], color: 'slate' }];
    const next = applyPatch(g, [{ op: 'remove_node', node_id: 'n_a' }]);
    expect(next.edges).toHaveLength(0);
    expect(next.groups[0].nodeIds).toEqual(['n_b']);
  });

  it('invertOps 可精确还原上一次状态（撤销正确性）', () => {
    const g = graph([mkNode('text', 'n_a'), mkNode('image', 'n_b')], [mkEdge('n_a', 'out:out', 'n_b', 'in:prompt')]);
    const ops = [
      { op: 'update_node_params' as const, node_id: 'n_b', params: { tier: 'T-A' } },
      { op: 'move' as const, node_id: 'n_a', position: { x: 42, y: 24 } },
      { op: 'remove_node' as const, node_id: 'n_a' },
    ];
    const after = applyPatch(g, ops);
    const back = applyPatch(after, invertOps(g, ops));
    expect(back.nodes.map((n) => n.id).sort()).toEqual(['n_a', 'n_b']);
    expect(back.edges).toHaveLength(1);
    expect(back.nodes.find((n) => n.id === 'n_b')!.data.params.tier).toBe(nodeRegistry.get('image').defaultParams.tier);
    expect(back.nodes.find((n) => n.id === 'n_a')!.position).toEqual({ x: 0, y: 0 });
  });

  it('pin_input 可设置与清除', () => {
    const g = graph([mkNode('image', 'n_b')]);
    const pinned = applyPatch(g, [{ op: 'pin_input', node_id: 'n_b', port_id: 'ref', artifact_id: 'art_1' }]);
    expect(pinned.nodes[0].data.pinnedInputs).toEqual({ ref: 'art_1' });
    const cleared = applyPatch(pinned, [{ op: 'pin_input', node_id: 'n_b', port_id: 'ref', artifact_id: null }]);
    expect(cleared.nodes[0].data.pinnedInputs).toEqual({});
  });
});

/* ── 拓扑与分层 ── */
describe('buildPlan', () => {
  it('分层反映并行度：菱形图 → 1/2/1', () => {
    const g = graph(
      [mkNode('text', 'a'), mkNode('image', 'b'), mkNode('image', 'c'), mkNode('compose', 'd')],
      [mkEdge('a', 'out:out', 'b', 'in:prompt'), mkEdge('a', 'out:out', 'c', 'in:prompt'), mkEdge('b', 'out:out', 'd', 'in:videos'), mkEdge('c', 'out:out', 'd', 'in:videos')],
    );
    const plan = buildPlan(g, 'full');
    expect(plan.levels.map((l) => l.length)).toEqual([1, 2, 1]);
    expect(plan.deps['d'].sort()).toEqual(['b', 'c']);
  });

  it('检测环并抛 CycleError', () => {
    const g = graph([mkNode('text', 'a'), mkNode('text', 'b')], [mkEdge('a', 'out:out', 'b', 'in:in'), mkEdge('b', 'out:out', 'a', 'in:in')]);
    expect(() => buildPlan(g, 'full')).toThrow(CycleError);
  });

  it('子图模式自动补全上游，单点模式不补', () => {
    const g = graph([mkNode('text', 'a'), mkNode('image', 'b')], [mkEdge('a', 'out:out', 'b', 'in:prompt')]);
    expect(buildPlan(g, 'subgraph', ['b']).order.sort()).toEqual(['a', 'b']);
    expect(buildPlan(g, 'single', ['b']).order).toEqual(['b']);
  });

  it('withUpstream / downstreamOf 方向正确', () => {
    const g = graph([mkNode('text', 'a'), mkNode('image', 'b'), mkNode('compose', 'c')], [mkEdge('a', 'out:out', 'b', 'in:prompt'), mkEdge('b', 'out:out', 'c', 'in:videos')]);
    expect([...withUpstream(g, ['c'])].sort()).toEqual(['a', 'b', 'c']);
    expect(downstreamOf(g, ['a']).sort()).toEqual(['b', 'c']);
  });
});

/* ── 连线校验 ── */
describe('validateConnection', () => {
  /** 从图里取真实节点类型对应的端口定义（与画布上的 specOf 行为一致） */
  const specOfIn = (g: WorkflowGraph) => (nodeId: string) => {
    const n = g.nodes.find((x) => x.id === nodeId);
    return n && n.type !== 'group' ? nodeRegistry.get(n.data.type) : { inputs: [], outputs: [] };
  };

  it('拒绝类型不匹配（audio → image）', () => {
    const g = graph([mkNode('audio', 'aud'), mkNode('image', 'img'), mkNode('video', 'vid')]);
    const r = validateConnection(
      { source: 'aud', sourceHandle: 'out:out', target: 'img', targetHandle: 'in:prompt' },
      g,
      specOfIn(g),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('类型不匹配');
  });

  it('允许静图入视频（image → video.first，i2v 首帧）', () => {
    const g = graph([mkNode('audio', 'aud'), mkNode('image', 'img'), mkNode('video', 'vid')]);
    const r = validateConnection(
      { source: 'img', sourceHandle: 'out:out', target: 'vid', targetHandle: 'in:first' },
      g,
      specOfIn(g),
    );
    expect(r.ok).toBe(true);
  });

  it('拒绝成环', () => {
    const gr = graph([mkNode('text', 'a'), mkNode('text', 'b')], [mkEdge('a', 'out:out', 'b', 'in:in')]);
    expect(createsCycle(gr, 'b', 'a')).toBe(true);
    const r = validateConnection(
      { source: 'b', sourceHandle: 'out:out', target: 'a', targetHandle: 'in:in' },
      gr,
      specOfIn(gr),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('循环');
  });

  it('拒绝修改锁定节点的拓扑', () => {
    const gl = graph([mkNode('image', 'img'), mkNode('video', 'vid')]);
    gl.nodes[1].data.locked = true;
    const r = validateConnection(
      { source: 'img', sourceHandle: 'out:out', target: 'vid', targetHandle: 'in:first' },
      gl,
      specOfIn(gl),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('锁定');
  });

  it('端口已占用时给出 warn（会被替换）', () => {
    const go = graph(
      [mkNode('image', 'img'), mkNode('image', 'img2'), mkNode('video', 'vid')],
      [mkEdge('img', 'out:out', 'vid', 'in:first')],
    );
    const r = validateConnection(
      { source: 'img2', sourceHandle: 'out:out', target: 'vid', targetHandle: 'in:first' },
      go,
      specOfIn(go),
    );
    expect(r.ok).toBe(true);
    expect(r.severity).toBe('warn');
  });

  it('兼容矩阵：video 端口可接 image（静图动效）', () => {
    expect(COMPAT.video).toContain('image');
    expect(COMPAT.audio).not.toContain('video');
  });
});

/* ── Agent 规划 ── */
describe('mockAgent', () => {
  it('从一句话解析出 Brief 要素', () => {
    const b = parseBrief('给这款气泡水做条 20s 抖音种草视频，清爽夏日感，突出 0 糖');
    expect(b.product).toBe('气泡水');
    expect(b.durationS).toBe(20);
    expect(b.platform).toBe('douyin');
    expect(b.tone).toBe('清爽');
    expect(b.usp).toContain('0 糖');
  });

  it('生成的补丁只含合法 op，且不含环', () => {
    const g = graph([]);
    const res = planWorkflow(g, '给这款气泡水做条 20s 抖音种草视频，突出 0 糖');
    expect(res.patch).toBeDefined();
    const next = applyPatch(g, res.patch!.ops);
    expect(next.nodes.length).toBeGreaterThanOrEqual(6);
    expect(() => buildPlan(next, 'full')).not.toThrow(); // 无环
    // 所有边的端口都真实存在
    for (const e of next.edges) {
      const src = next.nodes.find((n) => n.id === e.source)!;
      const dst = next.nodes.find((n) => n.id === e.target)!;
      const sp = nodeRegistry.get(src.data.type).outputs.map((p) => `out:${p.id}`);
      const tp = nodeRegistry.get(dst.data.type).inputs.map((p) => `in:${p.id}`);
      expect(sp).toContain(e.sourceHandle);
      expect(tp).toContain(e.targetHandle);
    }
  });

  it('省钱模式全用 T-C 档', () => {
    // Task 2 修正夹具：原文案「做条 20s 视频，便宜点」**没有任何内容/产品**，
    // 属于 needsClarify 路径（已由澄清短路拦下，零节点）。这条测试想验证的是
    // 「便宜模式下档位配比」，必须用一条真实需求驱动它 —— 否则它验证的是占位工作流。
    const res = planWorkflow(graph([]), '给这款气泡水做条 20s 视频，便宜点');
    const next = applyPatch(graph([]), res.patch!.ops);
    const tiers = next.nodes.filter((n) => n.data.type === 'image').map((n) => n.data.params.tier);
    expect(new Set(tiers)).toEqual(new Set(['T-C']));
  });

  it('增量编辑只改必要节点，不重建整图', () => {
    const g = applyPatch(graph([]), planWorkflow(graph([]), '给这款气泡水做条 20s 抖音种草视频，突出 0 糖').patch!.ops);
    const before = g.nodes.length;
    const res = editWorkflow(g, '太贵了，便宜点');
    expect(res.patch).toBeDefined();
    const ops = res.patch!.ops;
    expect(ops.every((o) => o.op === 'update_node_params')).toBe(true);
    expect(applyPatch(g, ops).nodes.length).toBe(before);
  });

  it('无法识别的指令不产生补丁，而是提出澄清问题', () => {
    const g = applyPatch(graph([]), planWorkflow(graph([]), '给这款气泡水做条 20s 视频').patch!.ops);
    const res = editWorkflow(g, '随便弄一下');
    expect(res.patch).toBeUndefined();
    expect(res.questions?.length).toBeGreaterThan(0);
  });
  it('无内容的指令不再产出占位工作流：走澄清、零节点', () => {
    // Task 2：这条断言把「夹具修正」钉成契约。修复前「做条 20s 视频」会生成 5 张图，
    // 提示词是空槽位 + 哨兵词的 `痛点开场：，清爽，高性价比，竖屏特写`。
    // 现在它必须是零 ops 的澄清回复 —— 若有人回退澄清短路，本测试立刻变红。
    const res = planWorkflow(graph([]), '做条 20s 视频');
    expect(res.patch!.ops).toEqual([]);
    expect(res.reply).toContain('补充主体或产品');
  });
});

/* ── 成本模型 ── */
describe('cost', () => {
  it('默认配比（1×T-A + 2×T-B + 静图动效）落在 ¥8 预算内', () => {
    const g = applyPatch(graph([]), planWorkflow(graph([]), '给这款气泡水做条 20s 抖音种草视频，突出 0 糖').patch!.ops);
    const cost = graphCost(g);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThanOrEqual(8);
  });

  it('提案成本增量：图像降档为负、加节点为正', () => {
    const g = graph([mkNode('image', 'im', { tier: 'T-A', count: 2 })]);
    expect(
      patchDeltaCost(
        { ...makePatch(g, [], 'user'), ops: [{ op: 'update_node_params', node_id: 'im', params: { tier: 'T-C' } }] },
        g,
      ),
    ).toBeLessThan(0);
    expect(
      patchDeltaCost(
        { ...makePatch(g, [], 'user'), ops: [{ op: 'add_node', node: mkNode('image', 'x', { count: 2 }) }] },
        g,
      ),
    ).toBeGreaterThan(0);
  });

  it('没有视频模型适配器时，video 成本按"本地动效"计（不虚报厂商价）', () => {
    // 默认（测试环境未探测到视频模型）：档位不影响成本，且远低于 i2v 价位
    const cheap = nodeRegistry.get('video').estimateCost({ tier: 'T-A', durationS: 4, mode: 'i2v' });
    const cheapest = nodeRegistry.get('video').estimateCost({ tier: 'T-C', durationS: 4, mode: 'static_motion' });
    expect(cheap).toBeLessThan(0.5); // i2v 档位价 ≈ ¥3.6，这里必须明显更低
    expect(cheapest).toBeLessThanOrEqual(cheap);
  });

  it('省钱模式下成本显著低于默认配比', () => {
    const def = graphCost(applyPatch(graph([]), planWorkflow(graph([]), '给这款气泡水做条 20s 视频，突出 0 糖').patch!.ops));
    const cheap = graphCost(applyPatch(graph([]), planWorkflow(graph([]), '给这款气泡水做条 20s 视频，突出 0 糖，便宜点').patch!.ops));
    expect(cheap).toBeLessThan(def);
  });
});

/* ── 注册表扩展性（约束 8） ── */
describe('node registry', () => {
  it('8 类内置节点全部注册，端口与参数默认值齐备', () => {
    expect(nodeRegistry.list().length).toBeGreaterThanOrEqual(8);
    for (const spec of nodeRegistry.list()) {
      expect(spec.inputs.every((p) => p.id && p.type)).toBe(true);
      expect(spec.defaultParams).toBeTypeOf('object');
      expect(spec.estimateCost(spec.defaultParams)).toBeGreaterThanOrEqual(0);
    }
  });

  it('重复注册同一类型会报错（防止静默覆盖）', () => {
    expect(() => nodeRegistry.register(nodeRegistry.get('text'))).toThrow();
  });
});
