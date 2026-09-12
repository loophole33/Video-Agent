/**
 * 模型网关客户端（前端侧）。
 * 契约与后端 apps/api/mva/main.py 一一对应；网关不在线时所有调用优雅失败 →
 * 调用方回退到 Mock 产物，Demo 在任何环境下都能演示（这是刻意的可用性设计）。
 */

export interface GatewayModel {
  adapter: string;
  model: string;
  capability: string;
  price: number;
  price_unit: string;
  quality_tier: string;
  available: boolean;
  note?: string;
  region?: string;
}

export interface GatewayHealth {
  ok: boolean;
  version?: string;
  image_provider?: string;
  providers?: { image?: string; llm?: string; video?: string };
  available?: { adapter: string; model: string; capability?: string; tier?: string; price?: number }[];
  registered?: string[];
  storage?: { files: number; bytes: number };
  skills?: { key: string; version: string; title: string; capability: string }[];
  capabilities?: Record<string, GatewayModel[]>;
}

export interface GeneratedArtifact {
  id: string;
  kind: string;
  url: string;
  mime: string;
  width?: number;
  height?: number;
  durationMs?: number;
  digest: string;
  size_bytes?: number;
  meta?: Record<string, unknown>;
}

export interface GenerateResult {
  ok: boolean;
  artifacts: GeneratedArtifact[];
  meta: {
    adapter?: string;
    model?: string;
    cost_cny?: number;
    latency_ms?: number;
    retries?: number;
    degraded?: boolean;
    ai_generated?: boolean;
    placeholder?: boolean;
    attempts?: { adapter: string; attempt?: number; ok?: boolean; error?: string; switched_from?: string }[];
    [k: string]: unknown;
  };
  error?: { class?: string; message?: string; retryable?: boolean };
  httpStatus?: number;
}

const API = '/mva-api';

/** 后端返回的是后端相对路径（/assets/...），统一补上代理前缀 → 同源可用 */
export function resolveAssetUrl(url: string): string {
  if (!url) return url;
  if (/^(https?:|data:|blob:)/.test(url)) return url;
  return `${API}${url.startsWith('/') ? '' : '/'}${url}`;
}

let healthCache: Promise<GatewayHealth | null> | null = null;
let lastHealthAt = 0;

export async function gatewayHealth(force = false): Promise<GatewayHealth | null> {
  const now = Date.now();
  if (!force && healthCache && now - lastHealthAt < 15_000) return healthCache;
  lastHealthAt = now;
  healthCache = fetch(`${API}/healthz`)
    .then((r) => (r.ok ? (r.json() as Promise<GatewayHealth>) : null))
    .catch(() => null);
  return healthCache;
}

export async function listModels(): Promise<GatewayModel[]> {
  try {
    const r = await fetch(`${API}/api/v1/models`);
    if (!r.ok) return [];
    const body = (await r.json()) as { models?: GatewayModel[] };
    return body.models ?? [];
  } catch {
    return [];
  }
}

export interface GenerateImageOptions {
  prompt: string;
  negativePrompt?: string;
  count?: number;
  tier?: string;
  ratio?: string;
  resolution?: string;
  seed?: number;
  nodeId?: string;
  runId?: string;
  model?: string;
  budgetCny?: number;
}

export async function generateImage(opts: GenerateImageOptions): Promise<GenerateResult> {
  const fallbackMeta: GenerateResult['meta'] = {};
  try {
    const r = await fetch(`${API}/api/v1/images/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: opts.prompt,
        negative_prompt: opts.negativePrompt,
        params: {
          tier: opts.tier ?? 'T-B',
          ratio: opts.ratio ?? '9:16',
          resolution: opts.resolution ?? '1080x1920',
          count: opts.count ?? 1,
          ...(opts.seed != null ? { seed: opts.seed } : {}),
        },
        node_id: opts.nodeId,
        run_id: opts.runId,
        model: opts.model && opts.model !== 'auto' ? opts.model : undefined,
        budget_cny: opts.budgetCny,
      }),
    });
    const body = (await r.json()) as GenerateResult & { detail?: { error?: GenerateResult['error'] } };
    if (!r.ok) {
      return { ok: false, artifacts: [], meta: fallbackMeta,
               error: body.detail?.error ?? body.error ?? { message: `HTTP ${r.status}` },
               httpStatus: r.status };
    }
    return body;
  } catch (e) {
    return { ok: false, artifacts: [], meta: fallbackMeta, error: { message: (e as Error).message } };
  }
}

export async function costSummary(): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${API}/api/v1/costs/summary`);
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/* ── 技能（版本化 Prompt + 结构化输出）── */

export interface SkillResult<T = unknown> {
  ok: boolean;
  skill?: { key: string; version: string };
  output?: T;
  meta?: {
    model?: string;
    adapter?: string;
    tokens?: { in: number; out: number };
    cost_cny?: number;
    latency_ms?: number;
    schema_repairs?: number;
    prompt_file?: string;
    attempts?: { adapter: string; ok?: boolean; error?: string }[];
  };
  error?: { class?: string; message?: string };
  httpStatus?: number;
}

export async function runSkill<T = unknown>(
  key: string,
  input: Record<string, unknown>,
  opts: { version?: string; nodeId?: string } = {},
): Promise<SkillResult<T>> {
  try {
    const r = await fetch(`${API}/api/v1/skills/${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, version: opts.version, node_id: opts.nodeId }),
    });
    const body = (await r.json()) as SkillResult<T> & { detail?: { error?: SkillResult['error'] } };
    if (!r.ok) {
      return { ok: false, error: body.detail?.error ?? body.error ?? { message: `HTTP ${r.status}` }, httpStatus: r.status };
    }
    return body;
  } catch (e) {
    return { ok: false, error: { message: (e as Error).message } };
  }
}

/* ── 视频生成（异步 i2v/t2v，网关内部完成轮询）── */

export interface GenerateVideoOptions {
  prompt: string;
  firstFrameUrl?: string;
  negativePrompt?: string;
  durationS?: number;
  resolution?: string;
  tier?: string;
  nodeId?: string;
  runId?: string;
  model?: string;
  budgetCny?: number;
}

export async function generateVideo(opts: GenerateVideoOptions): Promise<GenerateResult> {
  try {
    const r = await fetch(`${API}/api/v1/videos/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: opts.prompt,
        first_frame_url: opts.firstFrameUrl,
        negative_prompt: opts.negativePrompt,
        duration_s: opts.durationS ?? 5,
        resolution: opts.resolution ?? '1080P',
        tier: opts.tier ?? 'T-B',
        node_id: opts.nodeId,
        run_id: opts.runId,
        model: opts.model && opts.model !== 'auto' ? opts.model : undefined,
        budget_cny: opts.budgetCny,
      }),
    });
    const body = (await r.json()) as GenerateResult & { detail?: { error?: GenerateResult['error'] } };
    if (!r.ok) {
      return { ok: false, artifacts: [], meta: {}, error: body.detail?.error ?? body.error ?? { message: `HTTP ${r.status}` }, httpStatus: r.status };
    }
    return body;
  } catch (e) {
    return { ok: false, artifacts: [], meta: {}, error: { message: (e as Error).message } };
  }
}

export function humanBytes(n?: number): string {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
