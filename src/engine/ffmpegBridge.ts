/**
 * 前端 → FFmpeg 渲染桥的客户端。
 * 分工：浏览器把 SVG 帧栅格化成 PNG（浏览器天生会渲染 SVG），FFmpeg 负责运镜/转场/字幕/混音/编码。
 * 桥不可用时（生产构建、没装 ffmpeg）自动回退到 Mock 产物 —— 保证 Demo 在任何环境下都能演示。
 */

export type Motion = 'zoom_in' | 'zoom_out' | 'pan_right' | 'pan_left' | 'static';

/** 时间线上的一段：静帧（做 Ken Burns 动效）或已有视频片段（trim 后拼接） */
export type Segment =
  | { kind: 'still'; imagePng: string; durationS: number; motion?: Motion; text?: string }
  | { kind: 'clip'; url: string; durationS: number; text?: string };

export interface BridgeResult {
  ok: boolean;
  url?: string;
  file?: string;
  width?: number;
  height?: number;
  fps?: number;
  durationMs?: number;
  sizeBytes?: number;
  shots?: number;
  command?: string;
  logTail?: string;
  error?: string;
}

let healthCache: Promise<{ ok: boolean; ffmpeg: string }> | null = null;

export function bridgeHealth(force = false) {
  if (!healthCache || force) {
    healthCache = fetch('/api/render', { method: 'GET' })
      .then((r) => (r.ok ? r.json() : { ok: false, ffmpeg: 'unavailable' }))
      .catch(() => ({ ok: false, ffmpeg: 'unavailable' })) as Promise<{ ok: boolean; ffmpeg: string }>;
  }
  return healthCache;
}

/** SVG data URL → PNG data URL（在浏览器里栅格化，避免依赖 ffmpeg 的 SVG 支持） */
export async function rasterizeToPng(dataUrl: string, width: number, height: number): Promise<string> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('帧解码失败'));
    img.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 canvas 上下文');
  ctx.fillStyle = '#14110F';
  ctx.fillRect(0, 0, width, height);
  const scale = Math.max(width / img.width, height / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, (width - dw) / 2, (height - dh) / 2, dw, dh);
  return canvas.toDataURL('image/png');
}

export interface RenderOptions {
  runId?: string;
  resolution?: string;
  fps?: number;
  transition?: 'cut' | 'dissolve' | 'slide' | 'zoom';
  transitionDurS?: number;
  subtitle?: boolean;
  loudnessLufs?: number;
  watermark?: string | null;
  bgm?: { mode: 'synth' | 'none'; gainDb?: number };
  /** 配音轨：每段放在时间线 startS 处；BGM 会自动 sidechain 闪避 */
  voice?: { url: string; startS: number; text?: string }[];
  segments: Segment[];
}

export async function renderWithFFmpeg(opts: RenderOptions): Promise<BridgeResult> {
  try {
    const health = await bridgeHealth();
    if (!health.ok) return { ok: false, error: `渲染桥不可用（ffmpeg: ${health.ffmpeg}）` };
    const res = await fetch('/api/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    const body = (await res.json()) as BridgeResult;
    return res.ok ? body : { ok: false, error: body.error ?? `HTTP ${res.status}`, logTail: body.logTail };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function humanBytes(n?: number): string {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
