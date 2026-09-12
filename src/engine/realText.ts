/**
 * 真实文本能力：文案 / 分镜 / 提示词编译 走网关的版本化 Skill。
 * 未配置 LLM（或网关离线）时返回 null → 调用方回退到规则版兜底，Demo 不中断。
 */
import type { MvaNode, PortValue } from '../types/graph';
import { gatewayHealth, runSkill } from './modelGateway';

export interface TextCtx {
  log: (msg: string, level?: 'info' | 'warn' | 'error') => void;
  runId: string;
  llmAvailable: boolean;
}

export interface CopyVariant {
  style: string;
  hook: string;
  body: string;
  cta: string;
  estimated_read_s?: number;
}

export interface CopySet {
  variants: CopyVariant[];
  recommended_index: number;
  usp_coverage?: Record<string, boolean>;
}

export interface Shot {
  shot_no: number;
  duration_s: number;
  visual: string;
  camera: string;
  subject_ref?: string;
  narration?: string;
  on_screen_text?: string;
  transition_out?: string;
}

export interface Storyboard {
  total_duration_s: number;
  narration_full?: string;
  shots: Shot[];
  consistency_bible?: Record<string, unknown>;
}

export interface CompiledPrompt {
  prompt: string;
  negative_prompt: string;
  params_hint?: Record<string, unknown>;
  consistency_anchor_used?: string;
}

export interface TextResult<T> {
  outputs: Record<string, PortValue>;
  actual: { costCny: number; adapter: string; model: string; latencyMs: number };
  parsed: T;
}

function textOf(v: PortValue | undefined): string {
  return v && v.type === 'text' ? v.text : '';
}

function jsonOf<T>(v: PortValue | undefined): T | undefined {
  return v && v.type === 'json' ? (v.value as T) : undefined;
}

function briefOf(node: MvaNode, inputs: Record<string, PortValue | undefined>) {
  const p = node.data.params;
  const raw = String(p.brief ?? '') || textOf(inputs.brief) || textOf(inputs.in) || '';
  const product =
    String(p.product ?? '').trim() ||
    raw.split(/[·,，、]/)[0]?.trim() ||
    '产品';
  const usp =
    String(p.usp ?? '').trim() ||
    raw.match(/主打\s*([^·,，、]+)/)?.[1]?.trim() ||
    '高性价比';
  return {
    objective: String(p.objective ?? '种草'),
    product: { name: product, usp: usp.split(/[、和与,]/).map((s) => s.trim()).filter(Boolean) },
    platform: String(p.platform ?? 'douyin'),
    duration_s: Number(p.targetDurationS ?? p.durationS ?? 20),
    style: { tone: String(p.style ?? '清爽'), pace: '快' },
    constraints: { forbidden_words: ['最', '第一', '国家级', '100%'] },
  };
}

function summarizeSkill(meta: TextResult<unknown>['actual'] & { repairs?: number; promptFile?: string }, log: TextCtx['log']) {
  log(
    `Skill 调用成功：model=${meta.model} · 花费 ¥${meta.costCny.toFixed(4)} · ${meta.latencyMs}ms` +
      `${meta.promptFile ? ` · prompt=${meta.promptFile}` : ''}${meta.repairs ? ` · 结构修复 ${meta.repairs} 次` : ''}`,
  );
}

/* ── 文案：mva.copy.generate ── */
export async function runCopySkill(
  node: MvaNode,
  inputs: Record<string, PortValue | undefined>,
  ctx: TextCtx,
): Promise<TextResult<CopySet> | null> {
  if (!ctx.llmAvailable) {
    ctx.log('未配置 LLM（MVA_LLM_PROVIDER=none）→ 使用规则版文案兜底', 'warn');
    return null;
  }
  const brief = briefOf(node, inputs);
  ctx.log(`调用 Skill mva.copy.generate · ${brief.product.name} / ${brief.platform} / ${brief.duration_s}s`);
  const res = await runSkill<CopySet>('mva.copy.generate', { brief, max_chars: 90 }, { nodeId: node.id });
  if (!res.ok || !res.output) {
    ctx.log(`文案 Skill 失败（${res.error?.class ?? 'error'}）：${res.error?.message ?? '未知'} → 规则版兜底`, 'error');
    return null;
  }
  const meta = res.meta ?? {};
  const actual = {
    costCny: Number(meta.cost_cny ?? 0),
    adapter: String(meta.adapter ?? 'llm'),
    model: String(meta.model ?? '—'),
    latencyMs: Number(meta.latency_ms ?? 0),
  };
  summarizeSkill({ ...actual, repairs: meta.schema_repairs, promptFile: meta.prompt_file }, ctx.log);
  const picked = res.output.variants[res.output.recommended_index] ?? res.output.variants[0];
  const text = `${picked.hook}\n${picked.body}\n${picked.cta}`;
  return {
    parsed: res.output,
    outputs: { out: { type: 'text', text } },
    actual,
  };
}

/* ── 分镜：mva.script.storyboard ── */
export async function runStoryboardSkill(
  node: MvaNode,
  inputs: Record<string, PortValue | undefined>,
  ctx: TextCtx,
): Promise<TextResult<Storyboard> | null> {
  if (!ctx.llmAvailable) {
    ctx.log('未配置 LLM → 使用规则版分镜兜底（镜头名为占位字幕）', 'warn');
    return null;
  }
  const brief = briefOf(node, inputs);
  const copy = jsonOf<CopySet>(inputs.copy);
  ctx.log(`调用 Skill mva.script.storyboard · ${brief.duration_s}s / ${String(node.data.params.shotCount ?? 6)} 镜`);
  const res = await runSkill<Storyboard>('mva.script.storyboard', {
    brief,
    // 注意：必须给对象而不是 null —— 入参 Schema 里 copy 是 object，传 null 会被校验拦下
    copy: copy ?? { note: '未提供文案，请按 Brief 自行撰写' },
    target_duration_s: Number(node.data.params.targetDurationS ?? 20),
    shot_count: Number(node.data.params.shotCount ?? 6),
  }, { nodeId: node.id });
  if (!res.ok || !res.output) {
    ctx.log(`分镜 Skill 失败（${res.error?.class ?? 'error'}）：${res.error?.message ?? '未知'} → 规则版兜底`, 'error');
    return null;
  }
  const sb = res.output;
  const total = sb.shots.reduce((a, s) => a + Number(s.duration_s || 0), 0);
  const drift = Math.abs(total - Number(sb.total_duration_s || brief.duration_s));
  if (drift > Number(sb.total_duration_s || brief.duration_s) * 0.1) {
    ctx.log(`镜头总时长 ${total.toFixed(1)}s 与目标偏差 >10%，按比例配平`, 'warn');
    const scale = Number(sb.total_duration_s || brief.duration_s) / (total || 1);
    sb.shots.forEach((s) => {
      s.duration_s = Math.round(Math.min(6, Math.max(2.5, Number(s.duration_s) * scale)) * 10) / 10;
    });
  }
  const meta = res.meta ?? {};
  const actual = {
    costCny: Number(meta.cost_cny ?? 0),
    adapter: String(meta.adapter ?? 'llm'),
    model: String(meta.model ?? '—'),
    latencyMs: Number(meta.latency_ms ?? 0),
  };
  summarizeSkill({ ...actual, repairs: meta.schema_repairs, promptFile: meta.prompt_file }, ctx.log);
  const narration = sb.narration_full ?? sb.shots.map((s) => s.narration ?? '').join('');
  return {
    parsed: sb,
    outputs: {
      out: { type: 'json', value: sb },
      narration: { type: 'text', text: narration },
    },
    actual,
  };
}

/* ── 提示词编译：mva.prompt.compile.video ── */
export async function runCompileSkill(
  node: MvaNode,
  inputs: Record<string, PortValue | undefined>,
  ctx: TextCtx,
): Promise<TextResult<CompiledPrompt> | null> {
  if (!ctx.llmAvailable) {
    ctx.log('未配置 LLM → 使用本地模板拼装提示词', 'warn');
    return null;
  }
  const sb = jsonOf<Storyboard>(inputs.in);
  const shot = sb?.shots?.[0];
  if (!shot) {
    ctx.log('上游没有分镜数据，跳过 LLM 编译（先接分镜节点）', 'warn');
    return null;
  }
  ctx.log(`调用 Skill mva.prompt.compile.video · shot${shot.shot_no} · ${String(node.data.params.modelFamily ?? 'kling')}`);
  const res = await runSkill<CompiledPrompt>('mva.prompt.compile.video', {
    shot,
    style: { tone: String(node.data.params.stylePreset ?? '清爽') },
    consistency_bible: sb?.consistency_bible ?? {},
    target: String(node.data.params.target ?? 'video'),
    model_family: String(node.data.params.modelFamily ?? 'kling'),
    max_chars: Number(node.data.params.maxChars ?? 800),
  }, { nodeId: node.id });
  if (!res.ok || !res.output) {
    ctx.log(`提示词 Skill 失败（${res.error?.class ?? 'error'}）：${res.error?.message ?? '未知'} → 本地拼装兜底`, 'error');
    return null;
  }
  const meta = res.meta ?? {};
  const actual = {
    costCny: Number(meta.cost_cny ?? 0),
    adapter: String(meta.adapter ?? 'llm'),
    model: String(meta.model ?? '—'),
    latencyMs: Number(meta.latency_ms ?? 0),
  };
  summarizeSkill({ ...actual, repairs: meta.schema_repairs, promptFile: meta.prompt_file }, ctx.log);
  return {
    parsed: res.output,
    outputs: {
      out: { type: 'text', text: res.output.prompt },
      negative: { type: 'text', text: res.output.negative_prompt },
      params: { type: 'json', value: res.output.params_hint ?? {} },
    },
    actual,
  };
}

export async function llmReady(): Promise<boolean> {
  const health = await gatewayHealth();
  return !!(health?.ok && health.available?.some((m) => m.capability === 'llm'));
}
