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

export interface Brief {
  product: string;
  subject: string;          // 用户真正要拍的内容（通用请求）；营销请求为空串
  isMarketing: boolean;
  needsClarify: boolean;    // 提取不到主体 → 反问澄清，而不是编占位内容
  explicitDuration: boolean;
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

const MARKET_KEYS =
  /种草|带货|卖点|转化|投放|推广|营销|商品|产品|品牌|价格|促销|优惠|折扣|销量|下单|购买|链接|优惠券/;
const MARKET_VERB = /(?:种草|带货|推广|营销|宣传)\s*(?:视频|短片|素材)/;

/** 显式产品名（无则为 null，不回落到哨兵字面量） */
export function extractProduct(text: string): string | null {
  const raw =
    text.match(/给(?:这款|这个|我的)?\s*([^\s，。,]{1,14}?)\s*(?:做|拍|来)/)?.[1] ??
    text.match(/(?:产品|商品)[：:]\s*([^\s，。,]{1,14})/)?.[1] ??
    null;
  if (!raw) return null;
  const t = raw.trim();
  // 仅在「整个捕获就是代词」时判空。不要做通用 replace ——
  // 否则「给我们的猫拍一个视频」会被削成「的猫」，反而把真实名字弄坏（Task 1 复审发现）
  if (/^(?:我|我们|你|您|他|她|它|们)+$/.test(t)) return null;
  // 用户自己说的占位词不算「提取到内容」，否则 sentinel 规则形同虚设（Task 1 复审发现）
  if (/^(?:这款|这个)?(?:产品|商品)$/.test(t)) return null;
  return t || null;
}

/**
 * 时长壳：标称「整个残余就是一个时长」—— 阿拉伯数字（单位可省）+ 无单位裸数字。
 * 刻意**不含中文数字分支**：中文数字时长必须带单位，而带单位的中文数字时长
 * 在紧随其前的 LEADING_DUR 剥壳处就已经被剥干净（剥完为空 → 走 `!out` 提前返回）。
 * 第三轮判定为**不可达死代码**并删除，依据两条：
 *   ① 结构性：DUR_SHELL 只在此处「已先跑过 LEADING_DUR」之后被调用，而原中文数字分支
 *      要求带单位（秒|分钟|分），正是 LEADING_DUR 中文数字分支的**真子集** → 先被剥空；
 *   ② 实证：删掉该分支（含「千万零」）后全量测试仍全绿。
 * 复合中文时长（两分半 / 一分半 / 一千分钟）统一由 LEADING_DUR 负责。
 * 保留的 `\d+` 无单位分支是**承重**的：「做条20视频」只剩「20」，靠它才判得出澄清。
 */
const DUR_SHELL = /^(?:\d+(?:\.\d+)?\s*(?:秒钟|分钟|秒|分|钟|min|s)?)$/i;

/**
 * 句首时长短语：从 subject 里剥掉，而不是让它变成画面内容（Task 1 复审发现）。
 * 第三轮补齐复合形：单位补「钟」与「秒钟」，中文数字分支补「X分半(钟)」。
 * 「秒钟」整形是**实测承重**的：集合若缺它，「10秒钟」会被吃成「10秒」+ 残留「钟」，
 * 残渣随即变成画面内容（Task 1 第三轮复审发现；且该残渣不再被 DUR_SHELL 兜住，
 * 因为 DUR_SHELL 已按 FIX 2 删除中文数字分支、且「钟」无阿拉伯数字前缀，故不过度吞噬有真实覆盖）。
 * 多字单位（分钟/秒钟）刻意写在单字（秒/分）之前，避免单字分支先命中；
 * 此顺序经实测与「分钟|秒钟|秒|分|钟」等价，保留只为消除读歧义。
 * 中文数字后仍强制要求单位：「一个猫」这类量词不得因「一」入类而被误剥。
 */
const LEADING_DUR =
  /^(?:\d+(?:\.\d+)?\s*(?:分钟|秒钟|秒|分|钟|min|s)|[一二两三四五六七八九十百千万零]+(?:分钟|秒钟|秒|分|钟)(?:半)?(?:钟)?)\s*(?:的)?/i;

/** 量词壳（剥掉后不构成主体）。刻意不含「只」——保守，宁可多留字 */
const LEADING_QUANT = /^(?:一个|一段|一条|一张|个|段|条|张)/;

/**
 * 从原话提取画面内容：锚定媒体名词，再逐层剥掉动词/量词壳。
 * 注意「做」也必须是合法动词 —— 第一版只允许「生成/拍」，实测漏掉「帮我做一段猫咪打哈欠的视频」。
 */
export function extractSubject(text: string): string | null {
  const m = text.match(/^(.*?)\s*(?:的)?\s*(?:视频|短片|图片|图像|画面|片段)/);
  const raw = m ? m[1] : '';
  const env = raw.match(/^(给\s*(?:我)?[^，。,\s]{0,16}?)\s*(?:做|拍|制作|来)(?=[\s一个段条张的]|$)/);

  let s: string;
  if (env) {
    // 动词前段：剥掉「给/这款/代词」，剩下的才是主体
    const head = env[1]
      .replace(/^给\s*/, '')
      .replace(/^(?:这款|这个|我的)/, '')
      .replace(/^(?:我|我们|你|您|他|她|它|们)/, '')
      .trim();
    // 动词后段：剥掉量词壳与时长短语后剩下的才是主体
    const tail = raw
      .slice(env[0].length)
      .replace(LEADING_QUANT, '')
      .replace(LEADING_DUR, '')
      .trim();
    // 两段都可能是主体 → **合并而不是丢弃**
    // 「给猫咪制作一个在雨中奔跑的视频」head='猫咪' tail='在雨中奔跑'，
    // 丢掉任一段都是静默丢内容（Task 1 复审发现的头号问题）
    s = head && tail ? `${head}${tail}` : head || tail;
  } else {
    s = raw;
  }

  s = s.replace(/^(?:帮我|请|麻烦|我要|我想|想要|来|给我)+/g, '');
  s = s.replace(/^给(?:这款|这个|我的)?/g, '');
  s = s.replace(/^(?:生成|做|制作|拍|出|画|来)+/g, '');
  s = s.replace(LEADING_QUANT, '');
  s = s.replace(LEADING_DUR, '');
  const out = s.trim();
  // 兜底：全程剥完壳只剩一个时长（阿拉伯数字/中文数字/无单位裸数字）= 用户根本没说要拍什么，
  // 必须返回 null 走 needsClarify，绝不能把时长当画面内容写进提示词。
  // 只在「整个残余就是一个时长」时命中，所以「3D动画」「24fps」这类真内容不受影响。
  if (!out || DUR_SHELL.test(out)) return null;
  // 兜底 2：「把…做成/拍成」整帧残留 = 提示词壳，不是画面内容。用户应当被反问，而不是收到
  // 「帮我把猫咪做成视频」→ subject='把猫咪做成' 这种把指令碎片写进图像提示词的损坏结果。
  // 刻意**只拒绝整段残余恰好是这一帧**（^…$ 锚定整串），故「把花做成美食」这类残余不会被误杀。
  // 已知边界：无法从词法上区分「把花做成」（菜名，可能是真内容）与「帮我把花做成视频」的同一残余
  // ——两者逐字相同、无任何词法信号；故这里选择「宁可澄清、不可损坏提示词」。
  // 不做递归再解析回填把字句宾语：那是新机制，且会引入新的静默丢内容路径（Task 1 第三轮复审决定）。
  if (/^把.+(?:做成|拍成|变成)$/.test(out)) return null;
  return out;
}

export function parseBrief(text: string): Brief {
  const duration = text.match(/(\d{1,3})\s*(?:s|秒)/i);
  const explicitDuration = !!duration;
  const productRaw = extractProduct(text);
  const isMarketing = MARKET_KEYS.test(text) || MARKET_VERB.test(text) || !!productRaw;

  const subject = isMarketing ? '' : (extractSubject(text) ?? '');
  // 哨兵修正：营销但拿不到 product 时不再回落到字面量 '产品'
  const product = productRaw ?? (isMarketing ? '' : (subject || ''));
  const needsClarify = !product && !subject;

  const uspRaw = text.match(/突出\s*([^，。,]{1,20})/)?.[1];
  const usp = uspRaw ? uspRaw.split(/[、和与,]/).map((s) => s.trim()).filter(Boolean) : [];
  const platform = PLATFORMS.find((p) => p.match.test(text))?.key ?? 'douyin';
  const tone = TONES.find((t) => text.includes(t)) ?? '清爽';
  const cheap = /便宜|省钱|低预算|成本低|抠一点/.test(text);

  // 时长与镜数：营销保持旧默认（20s / ≥3 镜）；通用按内容定（无时长 → 5s / 1 镜）
  const rawDur = duration ? Math.min(180, Math.max(5, Number(duration[1]))) : null;
  const dur = rawDur ?? (isMarketing ? 20 : 5);
  const shots = isMarketing
    ? Math.min(12, Math.max(3, Math.round(dur / 4.2)))
    : rawDur
      ? Math.min(12, Math.max(1, Math.round(dur / 4.2)))
      : 1;

  return {
    product,
    subject,
    isMarketing,
    needsClarify,
    explicitDuration,
    durationS: dur,
    platform,
    tone,
    // 通用请求不得携带哨兵词「高性价比」；营销路径 usp 非空，故行为不变（Task 1 复审发现）
    usp: usp.length ? usp : isMarketing ? ['高性价比'] : [],
    cheap,
    shots,
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

  // 澄清短路（Task 2 / Task 1 第三轮审查 Critical）：既没解析出产品、也没解析出主体时，
  // 绝不能继续往下走 —— 否则会写出一条占位工作流（5 张图 + 视频），提示词里全是空槽位与
  // 哨兵词：`痛点开场：，清爽，高性价比，竖屏特写`。用户为此付真金白银，却拿到自己没要的内容。
  // 此时唯一正确的动作是反问。ops 为空数组：不落任何节点。
  if (b.needsClarify) {
    return {
      reply:
        '这条我还判断不出要拍什么。请补充主体或产品，例如：\n' +
        '· 通用：「生成一个<主体在做什么>的视频，<时长>秒」\n' +
        '· 营销：「给这款<产品>做条<时长>秒<平台>种草视频，突出<卖点>」',
      patch: {
        patch_id: `p_${Math.random().toString(36).slice(2, 10)}`,
        base_version: graph.version,
        rationale: `「${utterance.slice(0, 28)}」缺少可提取的主体，已请求澄清`,
        author: 'agent',
        risk: 'low',
        ops: [],
      },
    };
  }

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
      brief: b.subject
        ? `${b.subject} / ${b.platform} / ${b.durationS}s / ${b.tone}`
        : `${b.product} / ${b.platform} / ${b.durationS}s / ${b.tone}${b.usp.length ? ` / 卖点：${b.usp.join('、')}` : ''}`,
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

  // 镜头标签二分：通用请求用影视语言，不得把营销话术写进用户没在卖货的片子里
  const shotLabels = b.isMarketing
    ? ['痛点开场', '产品特写', '使用场景', '卖点演示', '对比效果', 'CTA 收尾']
    : ['建立镜头', '中景', '跟拍', '特写', '全景', '收尾'];
  const imageNodes: MvaNode[] = [];
  // usp 槽位渲染：通用请求 usp 为空，若仍写 `${usp[0] ?? ''}，` 会留下双逗号
  // （`小男孩在雨中奔跑，清爽，，竖屏特写`）—— 空槽位残渣不得进提示词。
  // 营销路径 usp 非空，渲染结果与修复前逐字相同（红线）。
  // 注意：本常量是**纯防御性**的，通用请求下不可达 —— 其唯一消费者是图像提示词的
  // 非 subject 分支，而该分支仅在 b.subject 为空时运行，此时必为营销请求，营销路径
  // usp 恒非空（哨兵兜底）。故通用请求永远不会走这里，勿以为它被通用路径覆盖。
  const uspPart = b.usp[0] ? `${b.usp[0]}，` : '';
  for (let i = 0; i < b.shots; i++) {
    const label = shotLabels[i % shotLabels.length];
    const img = mkNode(
      'image',
      X.shot,
      20 + i * 300,
      {
        prompt: b.subject
          ? `${b.subject}，${label}，${b.tone}，竖屏特写`
          : `${label}：${b.product}，${b.tone}，${uspPart}竖屏特写`,
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
        prompt: b.subject
          ? `镜头 ${i + 1}：${b.subject}，${b.tone}，流畅运镜`
          : `镜头 ${i + 1} 动态：${b.tone}，流畅运镜`,
      },
      `视频 ${i + 1} · ${tiers[i]}`,
    );
    videoNodes.push(v);
    nodes.push(v);
    edges.push(edge(imageNodes[i].id, 'out:out', v.id, 'in:first', 'image'));
  }

  const tts = mkNode('audio', X.prompt, 560, { mode: 'tts', voiceId: 'Cherry', speed: 1, emotion: b.tone }, '配音');
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
    `我按「${b.subject || b.product} · ${b.platform} · ${b.durationS}s · ${b.tone}」搭了一条流水线：` +
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
          prompt: `镜头 ${idx + 1}：${next}${cam ? `，${cam}` : ''}，节奏加快，突出${parseBrief(utterance).usp[0] ?? ''}`,
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
