/**
 * 真实视频片段：
 *   · 有视频模型适配器 → 走 i2v/t2v（异步 submit→轮询→回调，见 docs/phase-4 §4.8）
 *   · 没有视频模型     → 用 FFmpeg 把上游真实关键帧渲染成**真的 MP4 片段**（静图动效 T-C）
 * 两条路都产出真实视频文件；差别只在"画面运动是不是 AI 生成的"，日志里会写清楚。
 */
import { create } from 'zustand';
import type { ArtifactRef, MvaNode, PortValue } from '../types/graph';
import { rasterizeToPng, renderWithFFmpeg } from './ffmpegBridge';
import { gatewayHealth, generateVideo, listModels, resolveAssetUrl, type GatewayModel } from './modelGateway';

/* ── 网关能力（决定节点走真模型还是本地动效，也决定成本估算口径） ── */
interface ModelState {
  online: boolean;
  imageModels: GatewayModel[];
  videoModels: GatewayModel[];
  llmModels: GatewayModel[];
  ttsModels: GatewayModel[];
  videoAvailable: boolean;
  llmAvailable: boolean;
  ttsAvailable: boolean;
  skills: { key: string; version: string; title: string }[];
  refresh: () => Promise<void>;
}

export const useModelStore = create<ModelState>((set) => ({
  online: false,
  imageModels: [],
  videoModels: [],
  llmModels: [],
  ttsModels: [],
  videoAvailable: false,
  llmAvailable: false,
  ttsAvailable: false,
  skills: [],
  refresh: async () => {
    const health = await gatewayHealth(true);
    const models = health?.ok ? await listModels() : [];
    set({
      online: !!health?.ok,
      imageModels: models.filter((m) => m.capability === 'image'),
      videoModels: models.filter((m) => m.capability === 'video'),
      llmModels: models.filter((m) => m.capability === 'llm'),
      ttsModels: models.filter((m) => m.capability === 'tts'),
      videoAvailable: models.some((m) => m.capability === 'video' && m.available),
      llmAvailable: models.some((m) => m.capability === 'llm' && m.available),
      ttsAvailable: models.some((m) => m.capability === 'tts' && m.available),
      skills: health?.skills ?? [],
    });
  },
}));

/** 前端 URL → 网关内部路径（网关按 /assets/<path> 定位本地产物文件） */
export function backendPath(url: string): string {
  return url.replace(/^\/mva-api/, '');
}

function dashscopeResolution(resolution: string): string {
  const h = Number(String(resolution).split('x')[1] ?? 1080);
  return h >= 1080 ? '1080P' : '720P';
}

const MOTIONS = ['zoom_in', 'pan_right', 'zoom_out', 'pan_left'] as const;

function itemsOf(v: PortValue | undefined): ArtifactRef[] {
  return v && 'items' in v ? v.items : [];
}

export interface RealVideoResult {
  outputs: Record<string, PortValue>;
  actual: { costCny: number; adapter: string; model: string; latencyMs: number };
}

export async function renderRealClip(
  node: MvaNode,
  inputs: Record<string, PortValue | undefined>,
  ctx: { log: (msg: string, level?: 'info' | 'warn' | 'error') => void; runId: string },
): Promise<RealVideoResult | null> {
  const p = node.data.params;
  const mode = String(p.mode ?? 'i2v');
  const seconds = Number(p.durationS ?? 4);
  const [width, height] = String(p.resolution ?? '1080x1920').split('x').map(Number);

  const first = itemsOf(inputs.first)[0] ?? itemsOf(inputs.ref).find((a) => a.kind === 'image');
  const state = useModelStore.getState();

  // ── 1) 有视频模型：走真实 i2v/t2v（异步：网关内部完成 submit → 轮询 → 取片段 → 落盘） ──
  if (state.videoAvailable && (mode === 'i2v' || mode === 't2v')) {
    const prompt = String(p.prompt ?? '') || `镜头动效：${node.data.label}`;
    ctx.log(
      `真实 i2v：适配器=${state.videoModels.map((m) => `${m.adapter}/${m.model}`).join(',')} · ` +
        `${seconds}s · ${dashscopeResolution(String(p.resolution ?? '1080x1920'))}` +
        `${first ? ' · 首帧已提供' : ' · 无首帧（t2v）'}`,
    );
    const res = await generateVideo({
      prompt,
      firstFrameUrl: first ? backendPath(first.url) : undefined,
      durationS: seconds,
      resolution: dashscopeResolution(String(p.resolution ?? '1080x1920')),
      tier: String(p.tier ?? 'T-B'),
      nodeId: node.id,
      runId: ctx.runId,
    });
    if (res.ok && res.artifacts.length) {
      const a = res.artifacts[0];
      const meta = res.meta ?? {};
      const art: ArtifactRef = {
        id: a.id,
        kind: 'video',
        url: resolveAssetUrl(a.url),
        mime: 'video/mp4',
        width: a.width,
        height: a.height,
        durationMs: a.durationMs,
        digest: a.digest,
        meta: {
          ...(a.meta ?? {}),
          real: true,
          i2v: true,
          renderer: String(meta.adapter ?? 'video-model'),
          model: String(meta.model ?? ''),
          source: 'video-model(i2v)',
          size_bytes: a.size_bytes,
        },
      };
      const cost = Number(meta.cost_cny ?? 0);
      ctx.log(
        `i2v 完成：${a.width}×${a.height} · ${((a.durationMs ?? 0) / 1000).toFixed(1)}s · ` +
          `¥${cost.toFixed(2)} · ${String(meta.latency_ms ?? '?')}ms · 轮询 ${String(meta.polls ?? '?')} 次`,
      );
      if (meta.degraded) ctx.log(`⚠ 已降级到备用适配器 ${String(meta.adapter)}`, 'warn');
      const failed = ((meta.attempts ?? []) as { ok?: boolean; error?: string; adapter: string }[]).filter((x) => x.ok === false);
      if (failed.length) {
        ctx.log(`重试/降级轨迹：${failed.map((f) => `${f.adapter}✗${f.error ?? ''}`).join(' → ')}`, 'warn');
      }
      return {
        outputs: { out: { type: 'video', items: [art] } },
        actual: {
          costCny: cost,
          adapter: String(meta.adapter ?? 'video-model'),
          model: String(meta.model ?? '—'),
          latencyMs: Number(meta.latency_ms ?? 0),
        },
      };
    }
    ctx.log(
      `i2v 失败（${res.error?.class ?? 'error'}）：${res.error?.message ?? '未知'} → 回退本地静图动效（不产生视频模型费用）`,
      'error',
    );
  } else if (mode === 'i2v' || mode === 't2v') {
    ctx.log('未配置视频模型（i2v/t2v 需要视频生成 API）→ 回退为本地静图动效，实际花费 ¥0', 'warn');
  }

  // ── 2) 本地动效：上游关键帧 + Ken Burns → 真 MP4 片段 ──
  if (!first) {
    ctx.log('没有首帧输入，无法生成片段（i2v 需要上游图像节点的产出）', 'warn');
    return null;
  }

  let png: string;
  try {
    png = await rasterizeToPng(first.url, width, height);
  } catch (e) {
    ctx.log(`首帧栅格化失败：${(e as Error).message}`, 'error');
    return null;
  }

  const seed = Number(p.seed ?? 0) || node.id.length;
  const motion = MOTIONS[seed % MOTIONS.length];
  ctx.log(
    `本地动效渲染：${seconds}s · ${width}×${height} · motion=${motion}` +
      `${first.meta?.real ? '（首帧来自真实模型产物）' : '（首帧为占位图）'}`,
  );

  const res = await renderWithFFmpeg({
    runId: ctx.runId,
    resolution: `${width}x${height}`,
    fps: Number(p.fps ?? 30),
    transition: 'cut',
    subtitle: false,
    watermark: null,
    bgm: { mode: 'none' },
    segments: [{ kind: 'still', imagePng: png, durationS: seconds, motion }],
  });

  if (!res.ok) {
    ctx.log(`本地动效渲染失败：${res.error ?? '未知错误'}${res.logTail ? ` | ${res.logTail}` : ''}`, 'error');
    return null;
  }

  const art: ArtifactRef = {
    id: `art_clip_${Date.now().toString(36)}`,
    kind: 'video',
    url: res.url!,
    mime: 'video/mp4',
    width: res.width ?? width,
    height: res.height ?? height,
    durationMs: res.durationMs ?? Math.round(seconds * 1000),
    digest: `ffmpeg-clip-${res.sizeBytes ?? 0}`,
    meta: {
      real: true,
      renderer: 'ffmpeg(local)',
      motion,
      i2v: false,
      source: first.meta?.real ? 'keyframe(real-model)+kenburns' : 'keyframe(placeholder)+kenburns',
      size_bytes: res.sizeBytes,
      file: res.file,
    },
  };

  ctx.log(`片段完成：${res.file} · ${(art.durationMs! / 1000).toFixed(1)}s · ${art.width}×${art.height}`);
  return {
    outputs: { out: { type: 'video', items: [art] } },
    actual: { costCny: 0.05, adapter: 'ffmpeg(local)', model: `kenburns · ${motion}`, latencyMs: 0 },
  };
}

/** 供 compose 使用：视频节点 → 它对应的分镜序号（沿 first 入边回溯到图像节点，再按 x 排序定位） */
export function shotIndexByVideoNode(
  graph: { nodes: MvaNode[]; edges: { source: string; target: string; targetHandle?: string | null }[] },
): Map<string, number> {
  const images = graph.nodes
    .filter((n) => n.data.type === 'image')
    .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
  const indexByImage = new Map(images.map((n, i) => [n.id, i]));
  const out = new Map<string, number>();
  for (const v of graph.nodes.filter((n) => n.data.type === 'video')) {
    const edge = graph.edges.find(
      (e) => e.target === v.id && (e.targetHandle === 'in:first' || !e.targetHandle),
    );
    const idx = edge ? indexByImage.get(edge.source) : undefined;
    if (idx != null) out.set(v.id, idx);
  }
  return out;
}

export { resolveAssetUrl };
