/**
 * Mock Agent —— 本地规则版「一句话 → GraphPatch」规划器。
 * 与真实 Agent 的契约完全相同：只产出 GraphPatch + 解释，不改图（图由用户/提案应用）。
 * 真实实现见 docs/phase-3（主 Agent + CreativeAgent + PromptAgent + mva.plan.workflow）。
 */
import type { GraphPatch, MvaEdge, MvaNode, PatchOp, PortType, WorkflowGraph } from '../types/graph';
import { nodeRegistry } from '../registry';
import { stableSeed } from '../lib/utils';

export interface AgentResult {
  reply: string;
  questions?: string[];
  patch?: GraphPatch;
  action?: 'run';
}

interface Brief {
  product: string;
  durationS: number;
  platform: string;
  tone: string;
  usp: string[];
  cheap: boolean;
  shots: number;
}

const PLATFORMS = [
  { key: 'douyin', match: /抖音|douyin/i, label: '抖音' },
  { key: 'shipinhao', match: /视频号|朋友圈/, label: '视频号' },
  { key: 'xiaohongshu', match: /小红书|红书/, label: '小红书' },
];

const TONES = ['清爽', '高端', '温情', '热血', '幽默', '专业'];

export function parseBrief(text: string): Brief {
  const duration = text.match(/(\d{1,3})\s*(?:s|秒)/i);
  const product =
    text.match(/给(?:这款|这个|我的)?\s*([^\s，。,]{1,14}?)\s*(?:做|拍|来)/)?.[1] ??
    text.match(/(?:产品|商品)[：:]\s*([^\s，。,]{1,14})/)?.[1] ??
    '产品';
  const uspRaw = text.match(/突出\s*([^，。,]{1,20})/)?.[1];
  const usp = uspRaw ? uspRaw.split(/[、和与,]/).map((s) => s.trim()).filter(Boolean) : [];
  const platform = PLATFORMS.find((p) => p.match.test(text))?.key ?? 'douyin';
  const tone = TONES.find((t) => text.includes(t)) ?? '清爽';
  const cheap = /便宜|省钱|低预算|成本低|抠一点/.test(text);
  const dur = duration ? Math.min(180, Math.max(5, Number(duration[1]))) : 20;
  return {
    product,
    durationS: dur,
    platform,
    tone,
    usp: usp.length ? usp : ['高性价比'],
    cheap,
    shots: Math.min(12, Math.max(3, Math.round(dur / 4.2))),
  };
}

function mkNode(type: MvaNode['data']['type'], x: number, y: number, params: Record<string, unknown>, label: string): MvaNode {
  const spec = nodeRegistry.get(type);
  return {
    id: `n_${type.slice(0, 3)}${Math.random().toString(36).slice(2, 7)}`,
    type,
    position: { x, y },
    data: {
      type,
      label,
      params: { ...spec.defaultParams, ...params },
      status: 'idle',
      locked: false,
      enabled: true,
      createdBy: 'agent',
      ui: {},
    },
  };
}

const edge = (
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
  portType: PortType,
): MvaEdge => ({
  id: `e_${Math.random().toString(36).slice(2, 9)}`,
  source,
  sourceHandle,
  target,
  targetHandle,
  type: 'typed',
  data: { portType },
});

/** 一句话 → 生成整张工作流（提案用，不直接落图） */
export function planWorkflow(graph: WorkflowGraph, utterance: string): AgentResult {
  const b = parseBrief(utterance);
  const base = graph.nodes.filter((n) => n.type !== 'group').length;

  // 预算配比（docs/phase-4 §4.4）：便宜模式全 T-C，否则 hook 用 T-A、其余 T-B/T-C
  const tiers = b.cheap
    ? Array.from({ length: b.shots }, () => 'T-C')
    : Array.from({ length: b.shots }, (_, i) => (i === 0 ? 'T-A' : i < 3 ? 'T-B' : 'T-C'));

  const X = { script: 40, prompt: 380, shot: 720, vid: 1060, qa: 1400, mix: 1740 };
  const nodes: MvaNode[] = [];
  const edges: MvaEdge[] = [];

  const script = mkNode(
    'script',
    base ? X.script : X.script,
    180,
    {
      targetDurationS: b.durationS,
      shotCount: b.shots,
      style: b.tone,
      brief: `${b.product} / ${b.platform} / ${b.durationS}s / ${b.tone} / 卖点：${b.usp.join('、')}`,
    },
    '分镜脚本',
  );
  const prompt = mkNode(
    'prompt_compile',
    X.prompt,
    180,
    { target: 'video', stylePreset: b.tone, modelFamily: 'kling' },
    '提示词编译',
  );
  nodes.push(script, prompt);
  edges.push(edge(script.id, 'out:out', prompt.id, 'in:in', 'json'));

  const shotLabels = ['痛点开场', '产品特写', '使用场景', '卖点演示', '对比效果', 'CTA 收尾'];
  const imageNodes: MvaNode[] = [];
  for (let i = 0; i < b.shots; i++) {
    const label = shotLabels[i % shotLabels.length];
    const img = mkNode(
      'image',
      X.shot,
      20 + i * 300,
      {
        prompt: `${label}：${b.product}，${b.tone}，${b.usp[0]}，竖屏特写`,
        tier: tiers[i] === 'T-A' ? 'T-A' : tiers[i] === 'T-B' ? 'T-B' : 'T-C',
        count: i === 0 ? 2 : 1,
        seed: stableSeed(`${b.product}:${i}`),
      },
      `镜头 ${i + 1} · ${label}`,
    );
    imageNodes.push(img);
    nodes.push(img);
    edges.push(edge(prompt.id, 'out:text', img.id, 'in:prompt', 'text'));
  }

  const videoNodes: MvaNode[] = [];
  for (let i = 0; i < Math.min(3, b.shots); i++) {
    const v = mkNode(
      'video',
      X.vid,
      20 + i * 300,
      {
        mode: tiers[i] === 'T-C' ? 'static_motion' : 'i2v',
        tier: tiers[i],
        durationS: Math.max(3, Math.round(b.durationS / b.shots)),
        motionStrength: 0.6,
        prompt: `镜头 ${i + 1} 动态：${b.tone}，流畅运镜`,
      },
      `视频 ${i + 1} · ${tiers[i]}`,
    );
    videoNodes.push(v);
    nodes.push(v);
    edges.push(edge(imageNodes[i].id, 'out:out', v.id, 'in:first', 'image'));
  }

  const tts = mkNode('audio', X.prompt, 560, { mode: 'tts', voiceId: 'qingxin', speed: 1, emotion: b.tone }, '配音');
  const qa = mkNode('qa_check', X.qa, 200, { blockOnFail: true, adLawCheck: true }, '质检');
  const compose = mkNode('compose', X.mix, 220, { subtitle: true, ratio: '9:16', resolution: '1080x1920' }, '合成导出');
  nodes.push(tts, qa, compose);
  edges.push(edge(script.id, 'out:narration', tts.id, 'in:text', 'text'));
  for (const v of videoNodes) edges.push(edge(v.id, 'out:out', qa.id, 'in:in', 'video'));
  edges.push(edge(tts.id, 'out:out', qa.id, 'in:in', 'audio'));
  edges.push(edge(script.id, 'out:out', qa.id, 'in:in', 'json'));
  edges.push(edge(qa.id, 'out:pass', compose.id, 'in:videos', 'any'));
  edges.push(edge(tts.id, 'out:out', compose.id, 'in:audio', 'audio'));
  edges.push(edge(script.id, 'out:out', compose.id, 'in:storyboard', 'json'));

  const ops: PatchOp[] = [
    ...nodes.map<PatchOp>((n) => ({ op: 'add_node', node: n })),
    ...edges.map<PatchOp>((e) => ({ op: 'connect', edge: e })),
    {
      op: 'group',
      group_id: `g_${Math.random().toString(36).slice(2, 7)}`,
      node_ids: nodes.map((n) => n.id),
      label: '主流程',
    },
  ];

  const cost = nodes.reduce((sum, n) => sum + nodeRegistry.get(n.data.type).estimateCost(n.data.params), 0);
  const reply =
    `我按「${b.platform} · ${b.durationS}s · ${b.tone}」搭了一条流水线：` +
    `分镜 → 提示词编译 → ${b.shots} 个镜头（${tiers.filter((t) => t === 'T-A').length} 个 T-A / ` +
    `${tiers.filter((t) => t === 'T-B').length} 个 T-B / ${tiers.filter((t) => t === 'T-C').length} 个静图动效）` +
    ` → 配音 → 质检 → 合成。预估 ${'¥'}${cost.toFixed(2)}。` +
    (b.cheap ? '（已按省钱模式压到最低配比）' : '');

  return {
    reply,
    patch: {
      patch_id: `p_${Math.random().toString(36).slice(2, 10)}`,
      base_version: graph.version,
      rationale: `依据「${utterance.slice(0, 28)}」生成 ${nodes.length} 节点 / ${edges.length} 连线`,
      author: 'agent',
      risk: nodes.length > 8 ? 'medium' : 'low',
      ops,
    },
  };
}

/** 增量编辑意图（只改必要节点，不重建整图 —— 对齐 docs/phase-3 §3.8） */
export function editWorkflow(graph: WorkflowGraph, utterance: string): AgentResult {
  const ops: PatchOp[] = [];
  const notes: string[] = [];

  // 1) 删节点：n_xxxxx
  const del = utterance.match(/(n_[a-z0-9]+)/i);
  if (/删除|删了|去掉/.test(utterance) && del) {
    const id = del[1];
    if (graph.nodes.some((n) => n.id === id)) {
      ops.push({ op: 'remove_node', node_id: id });
      notes.push(`删除节点 ${id}`);
    }
  }

  // 2) 第 N 个镜头改运镜 / 换镜
  const shotIdx = utterance.match(/第\s*(\d{1,2})\s*(?:个)?\s*镜头/);
  if (shotIdx) {
    const idx = Number(shotIdx[1]) - 1;
    const images = graph.nodes.filter((n) => n.data.type === 'image');
    const target = images[idx];
    if (target) {
      const shotLabels = ['痛点开场', '产品特写', '使用场景', '卖点演示', '对比效果', 'CTA 收尾'];
      const next = shotLabels[(idx + 1) % shotLabels.length];
      const cam = /特写/.test(utterance) ? '特写' : /全景/.test(utterance) ? '全景' : /跟拍/.test(utterance) ? '跟拍' : null;
      ops.push({
        op: 'update_node_params',
        node_id: target.id,
        params: {
          prompt: `镜头 ${idx + 1}：${next}${cam ? `，${cam}` : ''}，节奏加快，突出${parseBrief(utterance).usp[0]}`,
        },
      });
      notes.push(`镜头 ${idx + 1} 改为「${next}${cam ? ` · ${cam}` : ''}」`);
    }
  }

  // 3) 降本：把高成本档位降一档
  if (/便宜|省钱|降本|成本|太贵|预算/.test(utterance)) {
    const expensive = graph.nodes.filter((n) => n.data.params.tier === 'T-A' || n.data.params.tier === 'T-B');
    for (const n of expensive.slice(0, 2)) {
      ops.push({
        op: 'update_node_params',
        node_id: n.id,
        params: { tier: n.data.params.tier === 'T-A' ? 'T-B' : 'T-C', mode: 'static_motion' },
      });
    }
    if (expensive.length) notes.push(`把 ${Math.min(2, expensive.length)} 个镜头的档位下调（T-A→T-B→静图动效）`);
  }

  // 4) 时长调整
  const dur = utterance.match(/(?:改成|调整到|变为)\s*(\d{1,3})\s*(?:s|秒)/);
  if (dur) {
    const script = graph.nodes.find((n) => n.data.type === 'script');
    if (script) {
      ops.push({ op: 'update_node_params', node_id: script.id, params: { targetDurationS: Number(dur[1]) } });
      notes.push(`目标时长改为 ${dur[1]}s`);
    }
  }

  // 5) 字幕/BGM
  if (/字幕/.test(utterance)) {
    const compose = graph.nodes.find((n) => n.data.type === 'compose');
    if (compose) {
      const on = !/去掉|关掉|不要/.test(utterance);
      ops.push({ op: 'update_node_params', node_id: compose.id, params: { subtitle: on } });
      notes.push(`${on ? '开启' : '关闭'}字幕`);
    }
  }

  if (ops.length === 0) {
    return {
      reply:
        '我可以改这些：把某个镜头换成特写 / 调时长（"改成 30 秒"）/ 降价（"太贵了便宜点"）/ 删节点（"删了 n_xxxxx"）/ 开关字幕。你想改哪一处？',
      questions: ['改成什么风格或运镜？', '目标时长要不要调整？'],
    };
  }

  const costDelta = ops.reduce((sum, op) => {
    if (op.op !== 'update_node_params') return sum;
    const n = graph.nodes.find((x) => x.id === op.node_id);
    if (!n) return sum;
    return sum + nodeRegistry.get(n.data.type).estimateCost({ ...n.data.params, ...op.params }) -
      nodeRegistry.get(n.data.type).estimateCost(n.data.params);
  }, 0);

  return {
    reply: `好的，我改这几处：${notes.join('；')}。预估成本变化 ${costDelta >= 0 ? '+' : '-'}¥${Math.abs(costDelta).toFixed(2)}。`,
    patch: {
      patch_id: `p_${Math.random().toString(36).slice(2, 10)}`,
      base_version: graph.version,
      rationale: notes.join('；'),
      author: 'agent',
      risk: ops.some((o) => o.op === 'remove_node') ? 'medium' : 'low',
      ops,
    },
  };
}

export function respond(graph: WorkflowGraph, utterance: string): AgentResult {
  if (/^(开始|运行|跑起来|生成吧|执行)/.test(utterance.trim()) || /开始生成|直接跑/.test(utterance)) {
    return { reply: '好，开始生成。画布上会实时显示每个节点的进度与花费。', action: 'run' };
  }
  const editing = graph.nodes.filter((n) => n.type !== 'group').length > 0;
  if (editing && /改|换|调|降|删|加|字幕|时长|运镜|镜头|便宜|贵/.test(utterance)) {
    return editWorkflow(graph, utterance);
  }
  if (/多少钱|成本|预算|贵不贵|花费/.test(utterance)) {
    const cost = graph.nodes
      .filter((n) => n.type !== 'group')
      .reduce((sum, n) => sum + nodeRegistry.get(n.data.type).estimateCost(n.data.params), 0);
    return {
      reply:
        `当前这张图预估 ${'¥'}${cost.toFixed(2)}。省钱的三招：①把非关键镜头降到静图动效（T-C）` +
        `②减少图像张数 ③复用你上传的素材。要我自动调一版吗？`,
    };
  }
  return planWorkflow(graph, utterance);
}
