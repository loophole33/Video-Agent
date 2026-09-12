/**
 * 本地 Mock 执行引擎 + 事件总线
 * ─ 与真实后端同构：`POST /runs` → 拓扑调度 → WS 事件流（带 seq，可 since 重放）
 * ─ 断网/重连、单点失败隔离、单点重试、预算熔断都可在本地真实演示
 */
import type { ArtifactRef, MvaNode, NodeStatus, PortValue, WorkflowGraph } from '../types/graph';
import type { EventType, MvaEvent, RunStatusPayload } from '../types/events';
import { buildPlan } from '../canvas/topo';
import { uid } from '../lib/utils';
import { stableSeed } from '../lib/utils';
import { useRun } from '../store/runStore';
import {
  makeAudioArtifact,
  makeImageArtifact,
  makeJsonArtifact,
  makeReportArtifact,
  makeTextArtifact,
  makeVideoArtifact,
} from './mockArtifacts';
import { renderRealFinal } from './realRender';
import { renderRealImages } from './realImages';
import { renderRealClip, useModelStore } from './realVideo';
import { renderRealVoice } from './realAudio';
import { runCompileSkill, runCopySkill, runStoryboardSkill } from './realText';

type Listener = (evt: MvaEvent) => void;

export class BudgetPause extends Error {}

class MockRuntime {
  private seq = 0;
  private history: MvaEvent[] = [];
  private listeners = new Set<Listener>();
  private delivered = 0;
  online = true;
  missedWhileOffline = 0;
  private cancelled = false;
  private running = false;
  private injectedFailures = new Set<string>();
  private spent = 0;
  private curGraph: WorkflowGraph | null = null;
  private curBudget = 8;

  /* ── 事件总线 ── */
  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private publish<T extends EventType>(type: T, payload: unknown, runId?: string) {
    const evt: MvaEvent = {
      event_id: uid('evt', 6),
      seq: ++this.seq,
      ts: new Date().toISOString(),
      workflow_id: 'wf_demo',
      run_id: runId,
      trace_id: uid('tr', 8),
      type,
      payload,
    };
    this.history.push(evt);
    if (this.history.length > 2000) this.history.splice(0, this.history.length - 2000);
    if (this.online) {
      this.delivered = evt.seq;
      this.listeners.forEach((l) => l(evt));
    } else {
      this.missedWhileOffline += 1;
    }
    return evt;
  }

  goOffline() {
    this.online = false;
    this.missedWhileOffline = 0;
  }

  /** 重连：按 since 补发缺口事件（docs/phase-2 §2.7 断线重放） */
  goOnline(): { replayed: number; missed: number } {
    this.online = true;
    const missed = this.history.filter((e) => e.seq > this.delivered).length;
    const replay = this.history.filter((e) => e.seq > this.delivered);
    replay.forEach((e) => this.listeners.forEach((l) => l(e)));
    if (replay.length) this.delivered = replay[replay.length - 1].seq;
    const missedCount = this.missedWhileOffline;
    this.missedWhileOffline = 0;
    return { replayed: replay.length, missed: missedCount || missed };
  }

  injectFailure(nodeId: string, on = true) {
    if (on) this.injectedFailures.add(nodeId);
    else this.injectedFailures.delete(nodeId);
  }

  isFailing(nodeId: string) {
    return this.injectedFailures.has(nodeId);
  }

  cancel() {
    this.cancelled = true;
  }

  get isRunning() {
    return this.running;
  }

  /* ── 输入解析（与前端 resolveInputs / 后端权威解析同构） ── */
  private resolveInputs(graph: WorkflowGraph, node: MvaNode): Record<string, PortValue | undefined> {
    const runtime = useRun.getState().runtime;
    const spec = specOf(node);
    const out: Record<string, PortValue | undefined> = {};
    for (const port of spec.inputs) {
      const pinned = node.data.pinnedInputs?.[port.id];
      if (pinned) {
        const found = Object.values(runtime)
          .flatMap((r) => Object.values(r.outputs ?? {}))
          .flatMap((v) => (v && 'items' in v ? v.items : []))
          .find((a) => a.id === pinned);
        if (found) out[port.id] = { type: port.type as 'image', items: [found] };
        continue;
      }
      const edges = graph.edges.filter((e) => e.target === node.id && e.targetHandle === `in:${port.id}`);
      const items: ArtifactRef[] = [];
      const texts: string[] = [];
      const jsons: unknown[] = [];
      for (const e of edges) {
        const portId = (e.sourceHandle ?? '').split(':')[1];
        const v = runtime[e.source]?.outputs?.[portId];
        if (!v) continue;
        if ('items' in v) items.push(...v.items);
        else if (v.type === 'text') texts.push(v.text);
        else jsons.push(v.value);
      }
      if (items.length) out[port.id] = { type: port.type as 'image', items };
      else if (texts.length) out[port.id] = { type: 'text', text: texts.join('\n') };
      else if (jsons.length) out[port.id] = { type: 'json', value: jsons[0] };
    }
    return out;
  }

  private hasMissingRequired(graph: WorkflowGraph, node: MvaNode): string[] {
    const inputs = this.resolveInputs(graph, node);
    return specOf(node)
      .inputs.filter((p) => p.required && !inputs[p.id])
      .map((p) => p.id);
  }

  /* ── 运行 ── */
  async run(args: {
    graph: WorkflowGraph;
    mode: 'full' | 'subgraph' | 'single';
    nodeIds?: string[];
    budget: number;
  }): Promise<void> {
    if (this.running) return;
    const { graph, mode, nodeIds, budget } = args;
    const plan = buildPlan(graph, mode, nodeIds, true);
    const runId = uid('run', 8);
    this.running = true;
    this.cancelled = false;
    this.spent = 0;
    this.curGraph = graph;
    this.curBudget = budget;

    useRun.getState().startRun({ runId, mode, budget });
    useRun.getState().pushLog({ level: 'info', message: `run ${runId} 已创建 · mode=${mode} · 预算 ¥${budget}` });
    this.emitRun(runId, 'running', graph, budget);

    let failed = 0;
    try {
      for (const level of plan.levels) {
        if (this.cancelled) break;
        await Promise.all(level.map((id) => this.execNode(runId, graph, id, budget)));
      }
      const runtime = useRun.getState().runtime;
      failed = plan.order.filter((id) => runtime[id]?.status === 'failed').length;
    } catch (e) {
      if (e instanceof BudgetPause) {
        useRun.getState().pushLog({ level: 'warn', message: '预算闸门触发：已暂停，等待用户决定' });
        this.running = false;
        return;
      }
      throw e;
    }

    this.running = false;
    const status: RunStatusPayload['status'] = this.cancelled
      ? 'cancelled'
      : failed > 0
        ? plan.order.length - failed > 0
          ? 'partial'
          : 'failed'
        : 'succeeded';
    this.emitRun(runId, status, graph, budget);
    useRun.getState().pushLog({
      level: status === 'succeeded' ? 'info' : 'warn',
      message: `run ${runId} 结束：${status} · 花费 ¥${this.spent.toFixed(2)}`,
    });
  }

  async retryNode(graph: WorkflowGraph, nodeId: string, budget: number) {
    const runId = useRun.getState().runId ?? uid('run', 8);
    this.curGraph = graph;
    this.curBudget = budget;
    this.spent = useRun.getState().spentCny;
    this.injectedFailures.delete(nodeId);
    useRun.getState().pushLog({ level: 'info', nodeId, message: `单点重试 ${nodeId}（不影响其他分支）` });
    await this.execNode(runId, graph, nodeId, budget);
    const runtime = useRun.getState().runtime;
    const failed = Object.values(runtime).filter((r) => r.status === 'failed').length;
    this.emitRun(runId, failed > 0 ? 'partial' : 'succeeded', graph, budget);
  }

  private emitRun(
    runId: string,
    status: RunStatusPayload['status'],
    graph: WorkflowGraph,
    budget: number,
  ) {
    const runtime = useRun.getState().runtime;
    const nodes = graph.nodes.filter((n) => n.type !== 'group');
    const progress = {
      total: nodes.length,
      success: nodes.filter((n) => runtime[n.id]?.status === 'success').length,
      running: nodes.filter((n) => runtime[n.id]?.status === 'running').length,
      failed: nodes.filter((n) => runtime[n.id]?.status === 'failed').length,
      skipped: nodes.filter((n) => runtime[n.id]?.status === 'skipped').length,
    };
    const final = nodes.find((n) => n.data.type === 'compose');
    const finalArtifact =
      (final && (runtime[final.id]?.outputs?.out as { items?: ArtifactRef[] } | undefined)?.items?.[0]) ?? null;

    this.publish<EventType>(
      'run.status',
      {
        run_id: runId,
        status,
        progress,
        spent_cny: Number(this.spent.toFixed(4)),
        final_artifact: finalArtifact,
        mode: useRun.getState().mode ?? 'full',
      } satisfies RunStatusPayload,
      runId,
    );
    if (this.spent / budget >= 0.8 && status === 'running') {
      this.publish<EventType>(
        'cost.warning',
        { spent_cny: Number(this.spent.toFixed(2)), limit_cny: budget, pct: this.spent / budget },
        runId,
      );
    }
  }

  /* ── 单节点执行 ── */
  private async execNode(runId: string, graph: WorkflowGraph, nodeId: string, budget: number) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node || node.type === 'group') return;
    const spec = specOf(node);
    const run = useRun.getState();

    if (!node.data.enabled) {
      run.patchRuntime(nodeId, { status: 'skipped' });
      this.emitNode(runId, nodeId, 'skipped', { attempt: 1 });
      return;
    }

    const missing = this.hasMissingRequired(graph, node);
    if (missing.length) {
      run.patchRuntime(nodeId, {
        status: 'failed',
        error: { class: 'invalid_request', message: `缺少必需输入：${missing.join(', ')}`, retryable: false },
      });
      this.emitNode(runId, nodeId, 'failed', {
        attempt: 1,
        error: { class: 'invalid_request', message: `缺少必需输入：${missing.join(', ')}`, retryable: false },
      });
      this.log(nodeId, 'error', `缺少必需输入：${missing.join(', ')}`);
      return;
    }

    const estimate = spec.estimateCost(node.data.params);
    if (this.spent + estimate > budget) {
      run.patchRuntime(nodeId, { status: 'blocked' });
      this.emitNode(runId, nodeId, 'blocked', { attempt: 1 });
      this.publish<EventType>(
        'cost.warning',
        { spent_cny: Number(this.spent.toFixed(2)), limit_cny: budget, pct: 1 },
        runId,
      );
      throw new BudgetPause();
    }

    run.patchRuntime(nodeId, { status: 'queued', progress: { pct: 0, stage: 'queued' } });
    this.emitNode(runId, nodeId, 'queued', { attempt: 1 });
    await sleep(90);
    if (this.cancelled) return;

    run.patchRuntime(nodeId, { status: 'running', progress: { pct: 5, stage: 'submitted' } });
    this.emitNode(runId, nodeId, 'running', { attempt: 1 });
    // 图像节点会走真实模型网关，因此这里只报本地预估，实际计费以网关返回为准
    this.log(
      nodeId,
      'info',
      node.data.type === 'image'
        ? `${spec.title} 提交 · 本地预估 ¥${estimate.toFixed(3)}（真实成本以网关返回为准）`
        : `${spec.title} 提交至适配器(${adapterFor(node)}) · 预估 ¥${estimate.toFixed(3)}`,
    );

    const duration = durationFor(node);
    const started = Date.now();
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      await sleep(duration / steps);
      if (this.cancelled) {
        run.patchRuntime(nodeId, { status: 'skipped', progress: undefined });
        this.emitNode(runId, nodeId, 'skipped', { attempt: 1 });
        return;
      }
      const stage = i < 2 ? 'submitted' : i < steps - 1 ? 'polling' : 'downloading';
      this.publish<EventType>(
        'node.progress',
        { node_id: nodeId, pct: Math.round((i / steps) * 100), stage },
        runId,
      );
      run.patchRuntime(nodeId, { status: 'running', progress: { pct: Math.round((i / steps) * 100), stage } });
    }

    // 故障演练（仅演示：验证「单点失败不阻塞」「重试幂等」）
    if (this.isFailing(nodeId)) {
      const cls = node.data.type === 'image' ? 'content_blocked' : 'transient';
      const message =
        cls === 'content_blocked' ? 'L3 输出审核未通过：画面含敏感元素（已阻断，未计费）' : '适配器超时（已重试 3 次）';
      run.patchRuntime(nodeId, { status: 'failed', error: { class: cls, message, retryable: cls === 'transient' } });
      this.emitNode(runId, nodeId, 'failed', {
        attempt: 3,
        latency_ms: Date.now() - started,
        cost_cny: 0,
        error: { class: cls, message, retryable: cls === 'transient' },
      });
      this.publish<EventType>(
        'policy.blocked',
        { node_id: nodeId, stage: 'L3', categories: ['画面敏感'], message },
        runId,
      );
      this.log(nodeId, 'error', message);
      return;
    }

    const inputs = this.resolveInputs(graph, node);
    const built = await buildOutputs(node, inputs, {
      graph,
      runId,
      log: (msg, level = 'info') => this.log(nodeId, level, msg),
    });
    const artifacts = built.outputs;
    for (const [port, value] of Object.entries(artifacts)) {
      const items = 'items' in value ? value.items : [];
      if (items.length) {
        // 逐件推送：runStore 的 node.artifact reducer 负责累加，避免重复写入
        for (const art of items) {
          await sleep(60);
          this.publish<EventType>('node.artifact', { node_id: nodeId, artifact: art, port }, runId);
        }
      } else {
        const cur = useRun.getState().runtime[nodeId]?.outputs ?? {};
        run.patchRuntime(nodeId, { outputs: { ...cur, [port]: value } });
      }
    }

    const actualCost = built.actual?.costCny ?? estimate;
    const actualAdapter = built.actual?.adapter ?? adapterFor(node);
    const actualModel = built.actual?.model ?? modelFor(node);
    const actualLatency = built.actual?.latencyMs ?? Date.now() - started;
    this.spent += actualCost;
    run.patchRuntime(nodeId, {
      status: 'success',
      progress: undefined,
      error: undefined,
      runMeta: {
        attempt: 1,
        latencyMs: actualLatency,
        costCny: actualCost,
        adapter: actualAdapter,
        model: actualModel,
      },
    });
    this.emitNode(runId, nodeId, 'success', {
      attempt: 1,
      latency_ms: actualLatency,
      cost_cny: actualCost,
      adapter: actualAdapter,
      model: actualModel,
    });
    this.log(nodeId, 'info', `${spec.title} 完成 · ${actualLatency}ms · ¥${actualCost.toFixed(4)}`);
    if (node.data.type === 'qa_check') {
      const report = (artifacts.report as { value?: { scores?: Record<string, number>; verdict?: string } } | undefined)
        ?.value;
      if (report?.verdict) this.log(nodeId, report.verdict === 'pass' ? 'info' : 'warn', `质检结论：${report.verdict}`);
    }
  }

  private emitNode(
    runId: string,
    nodeId: string,
    status: NodeStatus,
    extra: {
      attempt: number;
      latency_ms?: number;
      cost_cny?: number;
      adapter?: string;
      model?: string;
      error?: { class: string; message: string; retryable: boolean } | null;
    },
  ) {
    this.publish<EventType>('node.status', { node_id: nodeId, status, ...extra }, runId);
    if (this.curGraph) this.emitRun(runId, 'running', this.curGraph, this.curBudget);
  }

  private log(nodeId: string, level: 'info' | 'warn' | 'error', message: string) {
    // 只发事件：在线时由 store 的 node.log reducer 落库（离线时进历史，重连后补发）
    this.publish<EventType>('node.log', { node_id: nodeId, level, message });
  }
}

/* ── 辅助 ── */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

import { nodeRegistry } from '../registry';
function specOf(node: MvaNode) {
  return nodeRegistry.get(node.data.type);
}

function durationFor(node: MvaNode): number {
  switch (node.data.type) {
    case 'text':
      return 420;
    case 'script':
      return 760;
    case 'prompt_compile':
      return 520;
    case 'image':
      return node.data.params.tier === 'T-A' ? 1300 : node.data.params.tier === 'T-B' ? 950 : 520;
    case 'video':
      return node.data.params.tier === 'T-C' ? 700 : node.data.params.tier === 'T-A' ? 1900 : 1400;
    case 'audio':
      return 640;
    case 'qa_check':
      return 820;
    case 'compose':
      return 1250;
    default:
      return 600;
  }
}

/** 兜底路径的"适配器"名 —— 必须如实标注，不能冒用真厂商名字 */
function adapterFor(node: MvaNode): string {
  const t = node.data.type;
  if (t === 'video') return 'ffmpeg(local)';
  if (t === 'image') return 'fallback-svg';
  if (t === 'audio') return 'fallback-synth';
  if (t === 'text' || t === 'script' || t === 'prompt_compile') return 'fallback-rules';
  if (t === 'qa_check') return 'rules';
  return 'ffmpeg(local)';
}

function modelFor(node: MvaNode): string {
  const t = node.data.type;
  if (t === 'video') return 'kenburns(placeholder-frame)';
  if (t === 'image') return 'svg-placeholder';
  if (t === 'audio') return 'sine-synth';
  if (t === 'qa_check') return 'rules+vlm(mock)';
  if (t === 'compose') return 'ffmpeg';
  return 'rule-based';
}

function textOfInputs(inputs: Record<string, PortValue | undefined>): string {
  for (const v of Object.values(inputs)) {
    if (v && v.type === 'text') return v.text;
  }
  return '';
}

function firstJson(inputs: Record<string, PortValue | undefined>): unknown {
  for (const v of Object.values(inputs)) {
    if (v && v.type === 'json') return v.value;
  }
  return undefined;
}

export interface BuildResult {
  outputs: Record<string, PortValue>;
  /** 真实调用返回的实际成本/适配器/模型（Mock 产物不填，由本地估算兜底） */
  actual?: { costCny?: number; adapter?: string; model?: string; latencyMs?: number };
}

async function buildOutputs(
  node: MvaNode,
  inputs: Record<string, PortValue | undefined>,
  ctx: { graph: WorkflowGraph; runId: string; log: (msg: string, level?: 'info' | 'warn' | 'error') => void },
): Promise<BuildResult> {
  const p = node.data.params;
  // 稳定性来源：同一节点（同一 subject_ref）永远同种子 —— 一致性策略 L3
  const seed = Number(p.seed ?? stableSeed(node.id));
  switch (node.data.type) {
    case 'text': {
      const upstream = textOfInputs(inputs);
      const manual = String(p.content ?? '');
      // mode=llm 且网关有 LLM → 走版本化 Skill（mva.copy.generate）；否则透传/兜底
      if (String(p.mode ?? 'manual') === 'llm' && !manual) {
        const real = await runCopySkill(node, inputs, {
          log: ctx.log, runId: ctx.runId, llmAvailable: useModelStore.getState().llmAvailable,
        });
        if (real) return { outputs: real.outputs, actual: real.actual };
      }
      const text = manual || upstream || '（空）';
      return { outputs: { out: { type: 'text', text } } };
    }

    case 'script': {
      // ── 真实分镜：走版本化 Skill（mva.script.storyboard）──
      const real = await runStoryboardSkill(node, inputs, {
        log: ctx.log, runId: ctx.runId, llmAvailable: useModelStore.getState().llmAvailable,
      });
      if (real) return { outputs: real.outputs, actual: real.actual };

      // ── 回退：规则版分镜（镜头名当占位字幕） ──
      const shots = Number(p.shotCount ?? 6);
      const total = Number(p.targetDurationS ?? 20);
      const per = Math.round((total / shots) * 10) / 10;
      const labels = ['痛点开场', '产品特写', '使用场景', '卖点演示', '对比效果', 'CTA 收尾', '细节特写', '用户反馈'];
      const narration = Array.from({ length: shots }, (_, i) => `镜头${i + 1}台词占位`).join('');
      const storyboard = {
        total_duration_s: total,
        narration_full: `这是一条 ${total}s 的竖屏营销短视频文案（Mock）。`,
        shots: Array.from({ length: shots }, (_, i) => ({
          shot_no: i + 1,
          duration_s: per,
          visual: labels[i % labels.length],
          camera: i === 0 ? '特写' : i % 3 === 0 ? '缓慢推近' : '中景',
          subject_ref: `subject_${(i % 2) + 1}`,
          narration: `镜头 ${i + 1} 台词`,
          on_screen_text: labels[i % labels.length].slice(0, 8),
          transition_out: i % 2 ? 'dissolve' : 'cut',
        })),
        consistency_bible: {
          props: ['产品主体（颜色/形态固定）'],
          lighting: '自然柔光 + 冷调高光',
        },
      };
      return {
        outputs: { out: { type: 'json', value: storyboard }, narration: { type: 'text', text: narration } },
      };
    }

    case 'prompt_compile': {
      // ── 真实编译：走版本化 Skill（mva.prompt.compile.video）──
      const real = await runCompileSkill(node, inputs, {
        log: ctx.log, runId: ctx.runId, llmAvailable: useModelStore.getState().llmAvailable,
      });
      if (real) return { outputs: real.outputs, actual: real.actual };

      // ── 回退：本地模板拼装 ──
      const sb = firstJson(inputs);
      const shot = (sb as { shots?: { shot_no: number; visual: string; camera: string }[] } | undefined)?.shots?.[0];
      const brief = String(p.brief ?? '');
      const prompt = `主体特写，${shot?.visual ?? brief}，${p.stylePreset ?? '清爽'}，镜头：${shot?.camera ?? '缓慢推近'}，4k，商业摄影，自然柔光`;
      const negative = '低分辨率, 模糊, 畸变, 文字乱码, 水印, 过曝, 塑料感';
      return {
        outputs: {
          out: { type: 'text', text: prompt },
          negative: { type: 'text', text: negative },
          params: { type: 'json', value: { ratio: '9:16', resolution: '1080x1920', model_family: p.modelFamily } },
        },
      };
    }

    case 'image': {
      // ── 真实生成：走模型网关（适配器层）──
      const real = await renderRealImages(node, inputs, {
        log: ctx.log, runId: ctx.runId, nodeId: node.id, budgetCny: 8,
      });
      if (real) return real;

      // ── 回退：Mock 占位关键帧 ──
      const count = Number(p.count ?? 1);
      const items = Array.from({ length: count }, (_, i) =>
        makeImageArtifact({
          prompt: String(p.prompt ?? ''),
          seed,
          index: i,
          label: node.data.label,
          subject: String(p.tier),
        }),
      );
      return {
        outputs: {
          out: { type: 'image', items },
          meta: { type: 'json', value: { adapter: adapterFor(node), seed, tier: p.tier, count, mock: true } },
        },
      };
    }

    case 'video': {
      // ── 真实片段：有视频模型走 i2v；否则用 FFmpeg 把上游关键帧渲染成真 MP4（静图动效）──
      const real = await renderRealClip(node, inputs, { log: ctx.log, runId: ctx.runId });
      if (real) return real;

      // ── 回退：占位海报（没有可用的首帧时）──
      const seconds = Number(p.durationS ?? 4);
      const art = makeVideoArtifact({
        prompt: String(p.prompt ?? ''),
        seed,
        seconds,
        label: node.data.label,
        tier: String(p.tier ?? 'T-B'),
      });
      return { outputs: { out: { type: 'video', items: [art] } } };
    }

    case 'audio': {
      // ── 真实配音：按分镜逐段 TTS（音画对齐靠"每段放在自己镜头起点"）──
      const real = await renderRealVoice(node, inputs, {
        log: ctx.log, runId: ctx.runId, ttsAvailable: useModelStore.getState().ttsAvailable,
      });
      if (real) return { outputs: real.outputs, actual: real.actual };

      // ── 回退：合成波形占位 ──
      const text = String(p.text ?? '') || textOfInputs(inputs) || '气泡水 0 糖，冰爽一夏。';
      const durationMs = Math.round((text.length / 4.5) * 1000) + 400;
      return {
        outputs: {
          out: {
            type: 'audio',
            items: [
              makeAudioArtifact({
                text,
                seed,
                durationMs,
                label: 'TTS',
                voice: String(p.voiceId ?? 'qingxin'),
              }),
            ],
          },
          cues: {
            type: 'json',
            value: Array.from({ length: Math.max(1, Math.ceil(text.length / 14)) }, (_, i) => ({
              index: i,
              start_ms: i * 1400,
              end_ms: i * 1400 + 1300,
            })),
          },
        },
      };
    }

    case 'qa_check': {
      const shotNo = 1 + (seed % 3);
      const base = 0.78 + ((seed % 17) / 100);
      const scores = {
        consistency: Math.min(0.98, base),
        quality: Math.min(0.99, base + 0.06),
        text_accuracy: Math.min(0.99, base + 0.04),
        av_sync: Math.min(0.99, base + 0.08),
        compliance: 1,
      };
      const total = Number(
        (0.25 * scores.consistency + 0.25 * scores.quality + 0.2 * scores.text_accuracy + 0.15 * scores.av_sync + 0.15 * scores.compliance).toFixed(3),
      );
      const verdict = total >= 0.88 ? 'pass' : total >= 0.8 ? 'warn' : 'block';
      const report = {
        shot_no: shotNo,
        scores,
        total,
        verdict,
        detail: verdict === 'pass' ? '全部规则通过' : '建议提高参考强度后重跑',
        issues:
          verdict === 'pass'
            ? []
            : [{ code: 'CONSISTENCY_DRIFT', severity: 'medium', detail: '标签颜色与参考帧存在轻微差异' }],
      };
      const passthrough = Object.values(inputs).find((v) => v && 'items' in v);
      return {
        outputs: {
          report: { type: 'json', value: report },
          pass: passthrough ?? { type: 'json', value: report },
        },
      };
    }

    case 'compose': {
      // ── 真实合成：把静态帧交给本地 FFmpeg，产出可播放的 MP4 ──
      const real = await renderRealFinal(node, inputs, ctx);
      if (real) return real;

      // ── 回退：Mock 占位产物（桥不可用 / 无可用帧）──
      const raw = (inputs.videos && 'items' in inputs.videos ? inputs.videos.items : []).concat(
        inputs.video && 'items' in inputs.video ? inputs.video.items : [],
      );
      const seen = new Set<string>();
      const videos = raw.filter((a) => {
        if (seen.has(a.id)) return false;
        seen.add(a.id);
        return a.kind === 'video';
      });
      const storyboard = firstJson(inputs) as { total_duration_s?: number } | undefined;
      const clipsMs = videos.reduce((s, a) => s + (a.durationMs ?? 0), 0);
      const totalMs = (storyboard?.total_duration_s ?? 0) * 1000 || clipsMs || 20000;
      const art: ArtifactRef = {
        ...makeVideoArtifact({
          prompt: '成片（含字幕 · 混音 · 转场）',
          seed: 99,
          seconds: Math.round(totalMs / 1000),
          label: 'FINAL',
          tier: 'OUT',
        }),
        id: 'art_final',
        kind: 'final',
        meta: {
          clips: videos.length,
          clips_duration_s: Math.round(clipsMs / 1000),
          target_duration_s: storyboard?.total_duration_s ?? null,
          resolution: p.resolution ?? '1080x1920',
          subtitle: p.subtitle ?? true,
          bgm_license: p.bgmId ?? null,
          ai_generated: true,
        },
      };
      return { outputs: { out: { type: 'video', items: [art] } } };
    }

    default:
      return { outputs: {} };
  }
}

export const mockRuntime = new MockRuntime();

// 端口值 → 文本（供 spec Body 使用）
export { textOfInputs };
