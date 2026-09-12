/**
 * 真实配音：按分镜逐段合成语音（音画对齐的可靠做法 —— 每段放在它自己镜头的起点，
 * 而不是"整段配音 + 事后猜对齐"）。
 *
 * 未配置 TTS 时返回 null，由调用方回退到合成波形占位。
 */
import type { ArtifactRef, MvaNode, PortValue } from '../types/graph';
import { gatewayHealth, resolveAssetUrl } from './modelGateway';

const API = '/mva-api';

export interface VoiceCue {
  shot_no: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  text: string;
  url: string;
  artifact_id: string;
}

interface ShotLike {
  shot_no: number;
  duration_s: number;
  narration?: string;
  on_screen_text?: string;
}

export interface VoiceResult {
  outputs: Record<string, PortValue>;
  actual: { costCny: number; adapter: string; model: string; latencyMs: number };
}

function itemsOf(v: PortValue | undefined): ArtifactRef[] {
  return v && 'items' in v ? v.items : [];
}

function storyboardOf(inputs: Record<string, PortValue | undefined>): { shots?: ShotLike[] } | undefined {
  for (const v of Object.values(inputs)) {
    if (v && v.type === 'json') {
      const val = v.value as { shots?: ShotLike[] };
      if (val?.shots?.length) return val;
    }
  }
  return undefined;
}

interface TtsResponse {
  ok: boolean;
  artifacts?: { id: string; url: string; mime: string; durationMs?: number; size_bytes?: number; digest: string; meta?: Record<string, unknown> }[];
  meta?: { adapter?: string; model?: string; voice?: string; cost_cny?: number; latency_ms?: number; segments?: number };
  detail?: { error?: { class?: string; message?: string } };
  error?: { class?: string; message?: string };
}

export async function renderRealVoice(
  node: MvaNode,
  inputs: Record<string, PortValue | undefined>,
  ctx: { log: (msg: string, level?: 'info' | 'warn' | 'error') => void; runId: string; ttsAvailable: boolean },
): Promise<VoiceResult | null> {
  const p = node.data.params;
  const mode = String(p.mode ?? 'tts');
  if (mode !== 'tts') {
    ctx.log(`音频模式 ${mode} 暂未接真实模型（仅 tts），走本地占位`, 'warn');
    return null;
  }
  if (!ctx.ttsAvailable) {
    ctx.log('未配置 TTS（MVA_TTS_PROVIDER=none）→ 使用合成波形占位', 'warn');
    return null;
  }

  const sb = storyboardOf(inputs);
  const health = await gatewayHealth();
  const shots: ShotLike[] = sb?.shots?.length
    ? sb.shots
    : (() => {
        // 没有分镜就退回单段：取节点内 text 或上游文本
        const text = String(p.text ?? '') || (inputs.text?.type === 'text' ? inputs.text.text : '');
        return text ? [{ shot_no: 1, duration_s: Number(p.targetDurationS ?? 20), narration: text }] : [];
      })();

  const segments = shots
    .map((s) => ({ shot_no: s.shot_no, text: (s.narration || s.on_screen_text || '').trim() }))
    .filter((s) => s.text.length > 0);
  if (!segments.length) {
    ctx.log('没有可配音的台词（分镜 narration 为空，且节点未填文本）', 'warn');
    return null;
  }

  const voice = String(p.voiceId ?? 'Cherry');
  ctx.log(`调用 TTS：${segments.length} 段 · 音色 ${voice} · 共 ${segments.reduce((a, s) => a + s.text.length, 0)} 字`);
  let res: TtsResponse;
  try {
    const r = await fetch(`${API}/api/v1/tts/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segments, voice, node_id: node.id, run_id: ctx.runId }),
    });
    res = (await r.json()) as TtsResponse;
    if (!r.ok) {
      const err = res.detail?.error ?? res.error;
      ctx.log(`TTS 失败（${err?.class ?? 'error'}）：${err?.message ?? `HTTP ${r.status}`} → 回退占位`, 'error');
      return null;
    }
  } catch (e) {
    ctx.log(`TTS 请求异常：${(e as Error).message} → 回退占位`, 'error');
    return null;
  }

  const arts = res.artifacts ?? [];
  if (!arts.length) return null;

  // 音画对齐：每段放在它自己镜头的起点（起始时间是"录制时就知道的"，不需要 ASR 反推）
  let cursor = 0;
  const cues: VoiceCue[] = [];
  const items: ArtifactRef[] = [];
  for (const a of arts) {
    const shotNo = Number(a.meta?.shot_no ?? cues.length + 1);
    const shot = shots.find((s) => s.shot_no === shotNo);
    const shotMs = Math.round(Number(shot?.duration_s ?? 3) * 1000);
    const dur = Number(a.durationMs ?? shotMs);
    const start = cursor;
    const end = start + dur;
    items.push({
      id: a.id,
      kind: 'audio',
      url: resolveAssetUrl(a.url),
      mime: a.mime || 'audio/wav',
      durationMs: dur,
      digest: a.digest,
      meta: { ...(a.meta ?? {}), real: true, adapter: res.meta?.adapter, model: res.meta?.model,
              voice, size_bytes: a.size_bytes, tts: true },
    });
    cues.push({ shot_no: shotNo, start_ms: start, end_ms: end, duration_ms: dur,
                text: String(a.meta?.text ?? ''), url: resolveAssetUrl(a.url), artifact_id: a.id });
    cursor = Math.max(end, start + Math.max(dur, shotMs)); // 镜头比语音长就留白
  }

  const meta = res.meta ?? {};
  const totalChars = segments.reduce((a, s) => a + s.text.length, 0);
  ctx.log(
    `配音完成：${arts.length} 段 · 总时长 ${(cursor / 1000).toFixed(1)}s · ` +
      `适配器=${String(meta.adapter)} · ¥${Number(meta.cost_cny ?? 0).toFixed(4)} · ${String(meta.latency_ms)}ms`,
  );

  return {
    outputs: {
      out: { type: 'audio', items },
      cues: { type: 'json', value: { cues, voice, total_ms: cursor, chars: totalChars } },
    },
    actual: {
      costCny: Number(meta.cost_cny ?? 0),
      adapter: String(meta.adapter ?? 'tts'),
      model: String(meta.model ?? '—'),
      latencyMs: Number(meta.latency_ms ?? 0),
    },
  };
}

export { itemsOf };
