/**
 * 真实图像生成：把 image 节点接到模型网关（适配器层），拿到真实图片文件。
 * 网关不在线 / 全部适配器失败时返回 null，由调用方回退到 Mock 占位图。
 */
import type { ArtifactRef, MvaNode, PortValue } from '../types/graph';
import { generateImage, gatewayHealth, humanBytes, resolveAssetUrl } from './modelGateway';

interface ImageCtx {
  log: (msg: string, level?: 'info' | 'warn' | 'error') => void;
  runId: string;
  nodeId: string;
  budgetCny: number;
}

function upstreamText(inputs: Record<string, PortValue | undefined>, port: string): string {
  const v = inputs[port];
  return v && v.type === 'text' ? v.text : '';
}

export async function renderRealImages(
  node: MvaNode,
  inputs: Record<string, PortValue | undefined>,
  ctx: ImageCtx,
): Promise<{ outputs: Record<string, PortValue>; actual: { costCny: number; adapter: string; model: string; latencyMs: number } } | null> {
  const p = node.data.params;
  const health = await gatewayHealth();
  if (!health?.ok) {
    ctx.log('模型网关不在线（npm run api 未启动？），回退到占位产物', 'warn');
    return null;
  }

  // 提示词优先级：上游编译结果 > 节点内手写（与实际流水线一致）
  const compiled = upstreamText(inputs, 'prompt');
  const prompt = (compiled || String(p.prompt ?? '')).trim();
  if (!prompt) {
    ctx.log('提示词为空，跳过真实生成', 'warn');
    return null;
  }
  const negative = upstreamText(inputs, 'negative') || '低分辨率, 模糊, 畸变, 文字乱码, 水印';

  ctx.log(
    `调用模型网关：tier=${String(p.tier)} ${String(p.resolution)} ×${String(p.count ?? 1)} · ` +
      `prompt=${prompt.slice(0, 40)}${prompt.length > 40 ? '…' : ''}${compiled ? '（来自上游编译）' : ''}`,
  );

  const res = await generateImage({
    prompt,
    negativePrompt: negative,
    count: Number(p.count ?? 1),
    tier: String(p.tier ?? 'T-B'),
    ratio: String(p.ratio ?? '9:16'),
    resolution: String(p.resolution ?? '1080x1920'),
    seed: p.seed != null ? Number(p.seed) : undefined,
    nodeId: ctx.nodeId,
    runId: ctx.runId,
    model: p.model ? String(p.model) : undefined,
    budgetCny: ctx.budgetCny,
  });

  if (!res.ok || !res.artifacts.length) {
    const cls = res.error?.class ?? 'error';
    ctx.log(`真实生成失败（${cls}）：${res.error?.message ?? '未知原因'} → 回退占位产物`, 'error');
    return null;
  }

  const meta = res.meta ?? {};
  const attempts = (meta.attempts ?? []) as { adapter: string; ok?: boolean; error?: string; switched_from?: string }[];
  const retries = attempts.filter((a) => a.ok === false).length;
  if (retries > 0) {
    ctx.log(`重试/降级轨迹：${attempts.map((a) => `${a.adapter}${a.ok === false ? `✗${a.error ?? ''}` : '✓'}`).join(' → ')}`, 'warn');
  }
  if (meta.degraded) {
    ctx.log(`⚠ 已降级到备用适配器 ${String(meta.adapter)}（主适配器不可用或超配额），成本随之变化`, 'warn');
  }

  const artifacts: ArtifactRef[] = res.artifacts.map((a) => ({
    id: a.id,
    kind: 'image',
    url: resolveAssetUrl(a.url),
    thumbUrl: resolveAssetUrl(a.url),
    mime: a.mime || 'image/png',
    width: a.width,
    height: a.height,
    digest: a.digest,
    meta: {
      ...(a.meta ?? {}),
      real: true,
      adapter: meta.adapter,
      model: meta.model,
      ai_generated: meta.ai_generated ?? true,
      placeholder: meta.placeholder ?? false,
      size_bytes: a.size_bytes,
    },
  }));

  const total = Number(meta.cost_cny ?? 0);
  ctx.log(
    `真实生成完成：${artifacts.length} 张 · 适配器=${String(meta.adapter)} · 模型=${String(meta.model)} · ` +
      `¥${total.toFixed(4)} · ${String(meta.latency_ms ?? '?')}ms · ` +
      `${humanBytes(artifacts.reduce((s, a) => s + Number(a.meta?.size_bytes ?? 0), 0))}` +
      (meta.placeholder ? '（零 Key 占位画面，非 AI 生成）' : ''),
  );

  return {
    outputs: {
      out: { type: 'image', items: artifacts },
      meta: {
        type: 'json',
        value: {
          adapter: meta.adapter, model: meta.model, cost_cny: total, retries,
          degraded: meta.degraded ?? false, ai_generated: meta.ai_generated ?? true,
          placeholder: meta.placeholder ?? false, seed: p.seed,
        },
      },
    },
    actual: {
      costCny: total,
      adapter: String(meta.adapter ?? 'gateway'),
      model: String(meta.model ?? '—'),
      latencyMs: Number(meta.latency_ms ?? 0),
    },
  };
}
