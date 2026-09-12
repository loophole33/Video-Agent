import type { MvaEdge, MvaNode, PortType, WorkflowTemplate, XYPosition } from '../types/graph';
import { nodeRegistry } from '../registry';
import { stableSeed } from '../lib/utils';

function node(
  type: MvaNode['data']['type'],
  pos: XYPosition,
  params: Record<string, unknown>,
  label: string,
  createdBy: 'template' = 'template',
): MvaNode {
  const spec = nodeRegistry.get(type);
  return {
    id: `n_${Math.random().toString(36).slice(2, 9)}`,
    type,
    position: pos,
    data: {
      type,
      label,
      params: { ...spec.defaultParams, ...params },
      status: 'idle',
      locked: false,
      enabled: true,
      createdBy,
      ui: {},
    },
  };
}

function edge(s: string, sh: string, t: string, th: string, portType: PortType): MvaEdge {
  return {
    id: `e_${Math.random().toString(36).slice(2, 9)}`,
    source: s,
    sourceHandle: sh,
    target: t,
    targetHandle: th,
    type: 'typed',
    data: { portType },
  };
}

export const TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'tpl_ugc_20s',
    name: '标准 UGC 种草（20s 竖屏 · 6 镜）',
    category: '电商',
    description:
      '分镜 → 提示词 → 6 个镜头各一张关键帧 → 前 3 镜做动效/视频 → 配音 → 质检 → 合成。每个镜头用自己的关键帧，成片与分镜一一对应。',
    variables: [
      { key: 'product', label: '产品名', type: 'string', default: '气泡水' },
      { key: 'usp', label: '核心卖点', type: 'string', default: '0 糖' },
    ],
    build: (vars, origin) => {
      const product = String(vars.product ?? '产品');
      const usp = String(vars.usp ?? '卖点');
      const x = (dx: number) => origin.x + dx;
      const y = (dy: number) => origin.y + dy;

      // 与 mva.script.storyboard 的 6 段叙事模板一致：hook → 场景 → 产品 → 卖点 → 对比 → CTA
      const SHOTS = [
        { label: '01 痛点开场', visual: '通勤路上疲惫的年轻人，手中握着产品', camera: '中景', onScreen: '下午三点，撑不住了', tier: 'T-A' },
        { label: '02 产品特写', visual: `${product} 冰镇特写，水珠沿罐身滑落`, camera: '特写', onScreen: usp, tier: 'T-B' },
        { label: '03 使用场景', visual: `办公室桌面上打开${product}，气泡升腾`, camera: '缓慢推近', onScreen: '一口回魂', tier: 'T-B' },
        { label: '04 卖点演示', visual: `成分表特写，突出 ${usp}`, camera: '特写', onScreen: `${usp} 更安心`, tier: 'T-C' },
        { label: '05 对比效果', visual: `普通饮料与${product}并排对比`, camera: '俯拍', onScreen: '同样是快乐', tier: 'T-C' },
        { label: '06 CTA 收尾', visual: `${product} 与品牌 logo 同框，清爽夏日背景`, camera: '全景', onScreen: '左下角，囤一箱', tier: 'T-C' },
      ] as const;

      const script = node(
        'script',
        { x: x(0), y: y(320) },
        {
          targetDurationS: 20,
          shotCount: 6,
          style: '清爽',
          brief: `${product} · 主打 ${usp} · 6 镜分镜`,
          product,
          usp,
          platform: 'douyin',
        },
        '分镜脚本',
      );
      const prompt = node(
        'prompt_compile',
        { x: x(340), y: y(320) },
        { target: 'video', stylePreset: '清爽', modelFamily: 'kling' },
        '提示词编译',
      );

      const images = SHOTS.map((s, i) =>
        node(
          'image',
          { x: x(680), y: y(i * 300 - 120) },
          {
            prompt: `${s.visual}，${s.camera}，竖屏商业摄影，清爽夏日感，${usp}`,
            tier: s.tier,
            count: 1,
            seed: stableSeed(`${product}-shot${i + 1}`),
          },
          `${s.label} 关键帧`,
        ),
      );

      // 前 3 个镜头配视频节点（hook + 产品 + 场景 → 值得花预算的镜头）
      const videos = images.slice(0, 3).map((img, i) =>
        node(
          'video',
          { x: x(1020), y: y(i * 330 - 120) },
          { mode: 'i2v', tier: i === 0 ? 'T-A' : 'T-B', durationS: 4, motionStrength: 0.6 },
          `镜头 ${i + 1} 动效`,
        ),
      );

      const tts = node('audio', { x: x(340), y: y(700) }, { mode: 'tts', voiceId: 'Cherry' }, '配音');
      const qa = node('qa_check', { x: x(1400), y: y(-120) }, {}, '质检');
      const compose = node(
        'compose',
        { x: x(1740), y: y(-120) },
        { subtitle: true, resolution: '1080x1920', transition: 'dissolve' },
        '合成导出',
      );

      const nodes = [script, prompt, ...images, ...videos, tts, qa, compose];
      const edges: MvaEdge[] = [
        edge(script.id, 'out:out', prompt.id, 'in:in', 'json'),
        // 分镜同时接给配音节点：这样 TTS 能逐镜合成，每段语音落在自己镜头的起点（音画对齐）
        edge(script.id, 'out:out', tts.id, 'in:storyboard', 'json'),
        edge(script.id, 'out:narration', tts.id, 'in:text', 'text'),
        ...images.map((im) => edge(prompt.id, 'out:text', im.id, 'in:prompt', 'text' as PortType)),
        ...videos.map((v, i) => edge(images[i].id, 'out:out', v.id, 'in:first', 'image' as PortType)),
        ...images.map((im) => edge(im.id, 'out:out', qa.id, 'in:in', 'image' as PortType)),
        ...videos.map((v) => edge(v.id, 'out:out', qa.id, 'in:in', 'video' as PortType)),
        edge(tts.id, 'out:out', qa.id, 'in:in', 'audio'),
        edge(script.id, 'out:out', qa.id, 'in:in', 'json'),
        edge(qa.id, 'out:pass', compose.id, 'in:videos', 'any'),
        edge(tts.id, 'out:out', compose.id, 'in:audio', 'audio'),
        edge(script.id, 'out:out', compose.id, 'in:storyboard', 'json'),
      ];
      return { nodes, edges };
    },
  },
  {
    id: 'tpl_product_i2v',
    name: '产品图生视频（最省）',
    category: '电商',
    description: '上传产品图 → 图生视频 → 合成。只用 1 次模型调用，适合批量铺量。',
    variables: [{ key: 'product', label: '产品名', type: 'string', default: '新品' }],
    build: (vars, origin) => {
      const product = String(vars.product ?? '产品');
      const img = node('image', { x: origin.x, y: origin.y + 60 }, { prompt: `${product} 白底产品特写`, tier: 'T-C', count: 1 }, '产品图');
      const prompt = node('prompt_compile', { x: origin.x + 340, y: origin.y + 60 }, { target: 'video', modelFamily: 'jimeng' }, '提示词编译');
      const vid = node('video', { x: origin.x + 680, y: origin.y + 60 }, { mode: 'i2v', tier: 'T-B', durationS: 5, motionStrength: 0.4 }, '图生视频');
      const compose = node('compose', { x: origin.x + 1020, y: origin.y + 60 }, { subtitle: false, transition: 'zoom' }, '合成导出');
      return {
        nodes: [img, prompt, vid, compose],
        edges: [
          edge(img.id, 'out:out', prompt.id, 'in:in', 'image'),
          edge(prompt.id, 'out:text', vid.id, 'in:prompt', 'text'),
          edge(vid.id, 'out:out', compose.id, 'in:videos', 'video'),
        ],
      };
    },
  },
  {
    id: 'tpl_script_first',
    name: '脚本优先（多镜头批量）',
    category: '内容',
    description: '先出结构化分镜，再批量生成镜头首帧与视频，最后统一配音合成。适合需要严格剧本控制的品牌片。',
    variables: [
      { key: 'shots', label: '镜头数', type: 'string', default: '4' },
      { key: 'duration', label: '总时长(s)', type: 'string', default: '30' },
    ],
    build: (vars, origin) => {
      const shots = Math.min(6, Math.max(2, Number(vars.shots ?? 4)));
      const duration = Number(vars.duration ?? 30);
      const script = node('script', { x: origin.x, y: origin.y + 120 }, { targetDurationS: duration, shotCount: shots }, '分镜脚本');
      const copy = node('text', { x: origin.x, y: origin.y - 140 }, { mode: 'llm', skill: 'mva.copy.generate' }, '文案');
      const prompt = node('prompt_compile', { x: origin.x + 340, y: origin.y + 120 }, { target: 'image' }, '提示词编译');
      const imgs = Array.from({ length: shots }, (_, i) =>
        node('image', { x: origin.x + 680, y: origin.y + i * 300 - 100 }, { prompt: `镜头 ${i + 1}`, tier: 'T-B' }, `首帧 ${i + 1}`),
      );
      const qa = node('qa_check', { x: origin.x + 1020, y: origin.y + 160 }, {}, '质检');
      const compose = node('compose', { x: origin.x + 1360, y: origin.y + 160 }, { subtitle: true, resolution: '1080x1920', loudnessLufs: -14 }, '合成导出');
      return {
        nodes: [copy, script, prompt, ...imgs, qa, compose],
        edges: [
          edge(copy.id, 'out:out', script.id, 'in:copy', 'text'),
          edge(script.id, 'out:out', prompt.id, 'in:in', 'json'),
          ...imgs.map((im) => edge(prompt.id, 'out:text', im.id, 'in:prompt', 'text' as PortType)),
          ...imgs.map((im) => edge(im.id, 'out:out', qa.id, 'in:in', 'image' as PortType)),
          edge(qa.id, 'out:pass', compose.id, 'in:videos', 'any'),
        ],
      };
    },
  },
];
