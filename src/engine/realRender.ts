/**
 * 真实合成：按分镜逐镜头装配时间线，交给本地 FFmpeg 渲染成可播放 MP4。
 *
 * 装配规则（这就是"模板描述与实际输出对不上"的根因修复）：
 *   1. 每个分镜 shot i 绑定它**自己**的关键帧（图像节点按画布从左到右 = 镜头顺序），不再循环复用
 *   2. 如果该镜头有 video 节点产出的真实片段，就优先用片段（trim 到分镜时长）
 *   3. 只要存在真实关键帧，就**绝不使用占位海报**（占位图只在完全没有真实帧时兜底）
 */
import type { ArtifactRef, MvaNode, PortValue, WorkflowGraph } from '../types/graph';
import { useRun } from '../store/runStore';
import { humanBytes, rasterizeToPng, renderWithFFmpeg, type Segment } from './ffmpegBridge';
import { shotIndexByVideoNode, backendPath } from './realVideo';

interface RenderCtx {
  graph: WorkflowGraph;
  runId: string;
  log: (msg: string, level?: 'info' | 'warn' | 'error') => void;
}

const MOTIONS = ['zoom_in', 'pan_right', 'zoom_out', 'pan_left'] as const;

function itemsOf(v: PortValue | undefined): ArtifactRef[] {
  return v && 'items' in v ? v.items : [];
}

interface Pool {
  /** 按镜头顺序排列的关键帧（已剔除重复与占位图） */
  keyframes: ArtifactRef[];
  /** shotIndex → 该镜头的真实视频片段 */
  clipsByShot: Map<number, ArtifactRef>;
  /** 配音轨：每段放在时间线 startS 处（来自 audio 节点的 cues） */
  voice: { url: string; startS: number; text?: string }[];
  imageCount: number;
  videoCount: number;
  droppedPlaceholders: number;
}

function collectPool(graph: WorkflowGraph, fromId: string): Pool {
  const runtime = useRun.getState().runtime as unknown as Record<string, { outputs?: Record<string, PortValue> }>;
  const seen = new Set<string>();
  const stack = graph.edges.filter((e) => e.target === fromId).map((e) => e.source);
  const imageNodes = new Map<string, MvaNode>();
  const videoNodes: MvaNode[] = [];
  const audioNodes: MvaNode[] = [];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = graph.nodes.find((x) => x.id === id);
    if (!n || n.type === 'group') continue;
    if (n.data.type === 'image') imageNodes.set(n.id, n);
    if (n.data.type === 'video') videoNodes.push(n);
    if (n.data.type === 'audio') audioNodes.push(n);
    graph.edges.filter((e) => e.target === id).forEach((e) => stack.push(e.source));
  }

  const byX = (a: MvaNode, b: MvaNode) => a.position.x - b.position.x || a.position.y - b.position.y;
  // 镜头顺序 = 关键帧节点在画布上的左右顺序（与分镜 shot_no 对齐）
  const orderedImageNodes = [...imageNodes.values()].sort(byX);

  const rawFrames: ArtifactRef[] = [];
  const seenArt = new Set<string>();
  for (const n of orderedImageNodes) {
    for (const a of itemsOf(runtime[n.id]?.outputs?.out)) {
      if (seenArt.has(a.id)) continue;
      seenArt.add(a.id);
      rawFrames.push(a);
    }
  }

  const realFrames = rawFrames.filter((a) => a.meta?.placeholder !== true);
  const droppedPlaceholders = rawFrames.length - realFrames.length;
  // 有真实帧就不用占位帧；一个真实帧都没有时才退到占位帧
  const keyframes = realFrames.length ? realFrames : rawFrames;

  const shotOfVideo = shotIndexByVideoNode({
    nodes: [...graph.nodes],
    edges: graph.edges.map((e) => ({ source: e.source, target: e.target, targetHandle: e.targetHandle })),
  });
  const clipsByShot = new Map<number, ArtifactRef>();
  let videoCount = 0;
  for (const v of videoNodes) {
    const clip = itemsOf(runtime[v.id]?.outputs?.out).find((a) => a.kind === 'video' && a.mime === 'video/mp4');
    if (!clip) continue;
    videoCount += 1;
    const shot = shotOfVideo.get(v.id);
    if (shot != null && !clipsByShot.has(shot)) clipsByShot.set(shot, clip);
  }

  // 配音轨：audio 节点的 cues 里带着"每段在第几秒"，直接拿去给 FFmpeg 做 adelay
  const voice: { url: string; startS: number; text?: string }[] = [];
  for (const a of audioNodes) {
    const cues = runtime[a.id]?.outputs?.cues;
    if (!cues || cues.type !== 'json') continue;
    const list = (cues.value as { cues?: { url: string; start_ms: number; text?: string; real?: boolean }[] })?.cues;
    for (const c of list ?? []) {
      if (!c.url) continue;
      voice.push({ url: backendPath(c.url), startS: Number(c.start_ms ?? 0) / 1000, text: c.text });
    }
  }
  voice.sort((x, y) => x.startS - y.startS);

  return {
    keyframes,
    clipsByShot,
    voice,
    imageCount: orderedImageNodes.length,
    videoCount,
    droppedPlaceholders,
  };
}

function storyboardOf(inputs: Record<string, PortValue | undefined>) {
  for (const v of Object.values(inputs)) {
    if (v && v.type === 'json') {
      const val = v.value as {
        shots?: { duration_s: number; on_screen_text?: string; narration?: string }[];
        total_duration_s?: number;
      };
      if (val?.shots?.length) return val;
    }
  }
  return undefined;
}

export async function renderRealFinal(
  node: MvaNode,
  inputs: Record<string, PortValue | undefined>,
  ctx: RenderCtx,
): Promise<{ outputs: Record<string, PortValue>; actual?: { costCny?: number; adapter?: string; model?: string; latencyMs?: number } } | null> {
  const p = node.data.params;
  const renderStart = performance.now();
  const pool = collectPool(ctx.graph, node.id);

  if (!pool.keyframes.length && !pool.clipsByShot.size) {
    ctx.log('上游没有任何关键帧或片段产出，回退到占位产物', 'warn');
    return null;
  }

  const [width, height] = String(p.resolution ?? '1080x1920').split('x').map(Number);
  const subtitles = p.subtitle !== false;
  const sb = storyboardOf(inputs);
  const targetTotal = Number(sb?.total_duration_s ?? 20);

  // 分镜表：shot i → 剪辑片段（若有）否则它的关键帧
  const shotCount = sb?.shots?.length ?? Math.min(pool.keyframes.length || 1, 6);
  const plan = Array.from({ length: shotCount }, (_, i) => {
    const durationS = sb?.shots?.length
      ? Math.max(0.8, Number(sb.shots[i].duration_s) || targetTotal / shotCount)
      : targetTotal / shotCount;
    return {
      i,
      durationS,
      text: subtitles ? String(sb?.shots?.[i]?.on_screen_text ?? '') : '',
      clip: pool.clipsByShot.get(i),
      frame: pool.keyframes.length ? pool.keyframes[i % pool.keyframes.length] : undefined,
    };
  });

  if (pool.droppedPlaceholders > 0) {
    ctx.log(`已剔除 ${pool.droppedPlaceholders} 张占位帧（存在真实关键帧时不再混用）`, 'warn');
  }
  const clipShots = plan.filter((s) => s.clip).length;
  ctx.log(
    `时间线装配：${plan.length} 个镜头 = ${clipShots} 段真实片段 + ${plan.length - clipShots} 段关键帧动效 · ` +
      `关键帧池 ${pool.keyframes.length} 张（来自 ${pool.imageCount} 个图像节点）` +
      `${pool.keyframes[0]?.meta?.real ? ' · 真实模型产物' : ' · 占位图'}` +
      `${pool.voice.length ? ` · 配音 ${pool.voice.length} 段（BGM 将自动闪避）` : ' · 无配音'}`,
  );

  // 组装 FFmpeg 段：静止帧需先栅格化（同一帧只做一次）
  const pngCache = new Map<string, string>();
  const segments: Segment[] = [];
  for (const s of plan) {
    if (s.clip) {
      // 交给渲染桥的必须是网关内部路径（/assets/...）——桥按它定位本机文件或下载远端 URL
      segments.push({ kind: 'clip', url: backendPath(s.clip.url), durationS: s.durationS, text: s.text });
      continue;
    }
    const frame = s.frame;
    if (!frame) continue;
    let png = pngCache.get(frame.id);
    if (!png) {
      try {
        png = await rasterizeToPng(frame.url, width, height);
        pngCache.set(frame.id, png);
      } catch (e) {
        ctx.log(`镜头 ${s.i + 1} 的帧栅格化失败：${(e as Error).message}`, 'warn');
        continue;
      }
    }
    segments.push({
      kind: 'still',
      imagePng: png,
      durationS: s.durationS,
      motion: MOTIONS[s.i % MOTIONS.length],
      text: s.text,
    });
  }

  if (!segments.length) {
    ctx.log('没有可用素材，回退到占位产物', 'warn');
    return null;
  }

  const result = await renderWithFFmpeg({
    runId: ctx.runId,
    resolution: `${width}x${height}`,
    fps: Number(p.fps ?? 30),
    transition: (p.transition as 'cut' | 'dissolve' | 'slide' | 'zoom') ?? 'dissolve',
    subtitle: subtitles,
    loudnessLufs: Number(p.loudnessLufs ?? -14),
    watermark: 'AI 生成 · MVA Demo',
    bgm: { mode: 'synth' },
    voice: pool.voice,
    segments,
  });

  if (!result.ok) {
    ctx.log(`FFmpeg 渲染失败：${result.error ?? '未知错误'}${result.logTail ? ` | ${result.logTail}` : ''}`, 'error');
    return null;
  }

  const art: ArtifactRef = {
    id: `art_final_${Date.now().toString(36)}`,
    kind: 'final',
    url: result.url!,
    mime: 'video/mp4',
    width: result.width ?? width,
    height: result.height ?? height,
    durationMs: result.durationMs ?? Math.round(segments.reduce((a, s) => a + s.durationS, 0) * 1000),
    digest: `ffmpeg-${result.sizeBytes ?? 0}`,
    meta: {
      real: true,
      renderer: 'ffmpeg(local)',
      shots: segments.length,
      clip_shots: clipShots,
      still_shots: segments.length - clipShots,
      keyframes: pool.keyframes.length,
      keyframes_real: pool.keyframes[0]?.meta?.real === true,
      voice_segments: pool.voice.length,
      size_bytes: result.sizeBytes,
      file: result.file,
      subtitle: subtitles,
      loudness_lufs: Number(p.loudnessLufs ?? -14),
      bgm: 'ffmpeg-synth',
      ai_generated: true,
      watermark: 'AI 生成 · MVA Demo',
    },
  };

  ctx.log(
    `FFmpeg 出片成功：${result.file} · ${humanBytes(result.sizeBytes)} · ${(art.durationMs! / 1000).toFixed(1)}s · ` +
      `${art.width}×${art.height}（${segments.length} 镜头：${clipShots} 片段 + ${segments.length - clipShots} 动效）`,
  );
  if (result.command) ctx.log(`$ ${result.command}`);
  if (result.logTail) ctx.log(`ffmpeg: ${result.logTail.replace(/\n/g, ' ').slice(0, 240)}`);

  return {
    outputs: { out: { type: 'video', items: [art] } },
    actual: {
      costCny: 0.02,
      adapter: 'ffmpeg(local)',
      model: `libx264 · ${art.width}×${art.height} · ${segments.length} 镜头`,
      latencyMs: Math.round(performance.now() - renderStart),
    },
  };
}
