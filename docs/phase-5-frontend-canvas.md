# 阶段 5：前端画布设计
> 项目：AI 营销视频智能体（MVA）｜技术栈：React 19 + TS + React Flow 12 + Zustand + Tailwind + shadcn/ui + Vite

---

## 5.0 目录结构

```
apps/web/src/features/canvas/
├── Canvas.tsx                     # 画布容器（ReactFlow 实例 + Provider）
├── store/
│   ├── graphStore.ts              # 节点/边/分组（唯一真相源，含 applyPatch）
│   ├── runStore.ts                # 节点与 run 运行态（WS 驱动）
│   ├── uiStore.ts                 # 选中/折叠/预览索引/面板开关（不持久化）
│   └── patchStore.ts              # 提案箱 + undo/redo 栈
├── registry/
│   ├── types.ts                   # NodeTypeSpec / PortDef / 类型契约
│   ├── nodeRegistry.ts            # 注册表（新增节点类型的唯一入口）
│   └── specs/{text,image,video,audio,script,promptCompile,qaCheck,compose}.tsx
├── nodes/BaseNode.tsx             # 通用外壳（状态环/工具栏/端口/预览区/折叠）
├── edges/{TypedEdge.tsx, validation.ts}
├── engine/{topo.ts, localScheduler.ts, stale.ts, planClient.ts}
├── panels/{Inspector.tsx, RunLogPanel.tsx, ProposalCard.tsx, TemplateLibrary.tsx, CostMeter.tsx}
├── interactions/{useUndoRedo.ts, useGrouping.ts, useDropExternal.ts, useSelectionToolbar.ts, useAlignment.ts}
├── io/{serialize.ts, validate.ts, importExport.ts, migrate.ts}
└── ws/{client.ts, events.ts, useWorkflowSocket.ts}
```

---

## 5.1 节点类型定义（TypeScript）

```ts
// registry/types.ts
export type PortType = 'text' | 'image' | 'video' | 'audio' | 'json' | 'any';

export type NodeTypeId =
  | 'text' | 'image' | 'video' | 'audio'
  | 'script' | 'prompt_compile' | 'qa_check' | 'compose';

export type NodeStatus =
  | 'idle' | 'stale' | 'queued' | 'running'
  | 'success' | 'failed' | 'skipped' | 'cancelled';

export interface PortDef {
  id: string;                 // 与后端端口表逐字一致
  label: string;
  type: PortType;
  required?: boolean;         // 缺失时禁止运行
  multi?: boolean;            // true = 聚合所有入边为数组
  maxConnections?: number;    // 默认: multi?Infinity:1
}

/** 后端下发的产物引用（预签名 URL 由后端刷新） */
export interface ArtifactRef {
  id: string; kind: 'image' | 'video' | 'audio' | 'text' | 'json' | 'report' | 'final';
  url: string; thumbUrl?: string; mime: string;
  width?: number; height?: number; durationMs?: number; sizeBytes?: number;
  digest: string;                 // md5，用于 stale 判定与幂等
  meta?: Record<string, unknown>; // portrait / licenseId / seed ...
  urlExpiresAt?: string;
}

export interface TextPayload { type: 'text'; text: string }
export interface JsonPayload { type: 'json'; value: unknown }
export type PortValue =
  | { type: 'image' | 'video' | 'audio'; items: ArtifactRef[] }
  | TextPayload | JsonPayload;

export interface NodeError {
  class: 'transient' | 'rate_limited' | 'quota_exceeded'
       | 'content_blocked' | 'invalid_request' | 'fatal' | 'policy_blocked';
  message: string; retryable: boolean; code?: string;
}

export interface NodeData<P = Record<string, unknown>> {
  type: NodeTypeId;
  label: string;
  params: P;
  status: NodeStatus;
  locked: boolean;                        // Agent 不得修改
  enabled: boolean;                       // 禁用则跳过（skipped）
  createdBy: 'user' | 'agent' | 'template';
  groupId?: string;
  progress?: { pct: number; stage: 'queued'|'submitted'|'polling'|'downloading' };
  outputs?: Partial<Record<string, PortValue>>;
  error?: NodeError;
  runMeta?: { nodeRunId?: string; attempt: number; latencyMs?: number;
              costCny?: number; startedAt?: string; adapter?: string; model?: string };
  pinnedInputs?: Record<string, string>;  // portId -> artifactId（用户手动钉住，优先级最高）
  ui: { collapsed?: boolean; previewIndex?: number; width?: number; height?: number };
}

export type MvaNode<P = Record<string, unknown>> = Node<NodeData<P>, NodeTypeId>;

/** 节点类型规范：新增一种节点 = 写一个 spec + register，画布核心零改动 */
export interface NodeTypeSpec<P extends object> {
  id: NodeTypeId;
  title: string;
  category: 'source' | 'generate' | 'process' | 'check' | 'output';
  icon: React.ComponentType<{ className?: string }>;
  accent: string;                        // Tailwind 色板 token，如 'sky' / 'violet'
  description: string;
  inputs: PortDef[];
  outputs: PortDef[];
  paramsSchema: ZodType<P>;              // ⭐ 单一真相源：默认值 + 校验 + Inspector 表单自动生成
  defaultParams: P;
  Component: React.ComponentType<NodeProps<MvaNode<P>>>;
  /** 本地粗估（<1ms，用于拖入节点时即时反馈成本条） */
  estimateCost?: (p: P, ctx: EstimateCtx) => number;
  /** 双击创建的智能默认值（可读取上游） */
  instantiate?: (ctx: InstantiateCtx) => Partial<P>;
  /** 该节点类型的 Skill 绑定默认值（可被节点 params 覆盖） */
  defaultSkill?: { key: string; version?: string };
  groupable: boolean;
  minSize?: { w: number; h: number };
}
```

---

## 5.2 注册表：新增节点类型只做两件事（约束 8）

```ts
// registry/nodeRegistry.ts
class NodeRegistry {
  private specs = new Map<NodeTypeId, NodeTypeSpec<any>>();
  register<P extends object>(spec: NodeTypeSpec<P>) {
    if (this.specs.has(spec.id)) throw new Error(`duplicate node type: ${spec.id}`);
    this.specs.set(spec.id, spec);
    return this;
  }
  get(id: NodeTypeId): NodeTypeSpec<any> {
    const s = this.specs.get(id);
    if (!s) throw new Error(`unregistered node type: ${id}`);   // 未知类型 → 渲染 UnknownNode 占位（不崩）
    return s;
  }
  list(): NodeTypeSpec<any>[] { return [...this.specs.values()]; }
  byCategory(c: string) { return this.list().filter(s => s.category === c); }
}
export const nodeRegistry = new NodeRegistry();

// ── 注册 8 个内置类型 ──
nodeRegistry.register(textSpec).register(imageSpec).register(videoSpec).register(audioSpec)
  .register(scriptSpec).register(promptCompileSpec).register(qaCheckSpec).register(composeSpec);
```

**示例：新增第 9 种节点 `upscale`（超分）—— 全部代码 20 行，不碰 Canvas/BaseNode/校验/调度**
```tsx
// registry/specs/upscale.tsx
const Params = z.object({
  model: z.enum(['realesrgan', 'topaz']).default('realesrgan'),
  scale: z.union([z.literal(2), z.literal(4)]).default(2),
});
type P = z.infer<typeof Params>;

export const upscaleSpec: NodeTypeSpec<P> = {
  id: 'upscale' as NodeTypeId,            // 后端同时注册一个 UpscaleExecutor（同名 type）
  title: '超分增强', category: 'process', icon: Sparkles, accent: 'amber',
  description: '对上游图像/视频做超分辨率增强',
  inputs:  [{ id: 'in', label: '输入', type: 'any', required: true }],
  outputs: [{ id: 'out', label: '输出', type: 'any' }],
  paramsSchema: Params, defaultParams: Params.parse({}),
  Component: UpscaleNode,                 // 只需画预览区，外壳由 BaseNode 提供
  estimateCost: (p) => (p.scale === 4 ? 0.12 : 0.05),
  groupable: true,
};
nodeRegistry.register(upscaleSpec);
```
> 后端对应只需新增 `UpscaleExecutor` 并 `EXECUTORS.register('upscale', ...)`。**前后端各加一处注册即完成扩展。**

---

## 5.3 八类节点的端口与参数（与阶段 4 流水线一一对应）

| 节点 | 输入端口 | 输出端口 | 关键参数 |
|---|---|---|---|
| `text` | `in?: text` | `out: text` | `content, mode(manual\|llm), skill, skillVersion, model, temperature` |
| `image` | `prompt?: text, ref?: image, refs?: image[]` | `out: image, meta: json` | `prompt, model, tier, ratio, resolution, count, seed, refStrength, stylePreset` |
| `video` | `first?: image, last?: image, prompt?: text, ref?: video, audio?: audio` | `out: video` | `mode(i2v\|t2v\|v2v\|static_motion), model, tier, durationS, ratio, fps, motionStrength, seed` |
| `audio` | `text?: text` | `out: audio, cues: json` | `mode(tts\|music\|sfx), voiceId, speed, emotion, model, musicId, loudnessLufs` |
| `script` | `brief?: text, copy?: text, assets?: json` | `out: json, narration: text` | `targetDurationS, shotCount, style, skill, skillVersion, model` |
| `prompt_compile` | `in: any, style?: json` | `out: text, negative: text, params: json` | `target(image\|video), stylePreset, modelFamily, includeCamera, seedWords, maxChars` |
| `qa_check` | `in: any` | `report: json, pass: any` | `rules[], thresholds, blockOnFail, adLawCheck, safeAreaCheck` |
| `compose` | `video?: video, videos?: video[], audio?: audio, image?: image, storyboard?: json` | `out: video` | `ratio, resolution, subtitle, transition, bgmId, brandKitId, loudnessLufs, watermark` |

**参数 Schema 示例（image）**
```ts
export const ImageParams = z.object({
  prompt: z.string().min(1).max(1200),
  model: z.string().optional(),                       // 空 = 走 ModelGateway 自动选型
  tier: z.enum(['T-A', 'T-B', 'T-C']).default('T-B'), // 对应阶段 4 §4.4
  ratio: z.enum(['9:16', '16:9', '1:1']).default('9:16'),
  resolution: z.enum(['720x1280', '1080x1920']).default('1080x1920'),
  count: z.number().int().min(1).max(4).default(1),
  seed: z.number().int().optional(),
  refStrength: z.number().min(0).max(1).default(0.5),
  stylePreset: z.string().optional(),
}).superRefine((v, ctx) => {                          // 跨字段校验 → Inspector 就地报错
  if (v.tier === 'T-A' && v.count > 2)
    ctx.addIssue({ code: 'custom', message: 'T-A 档建议 count ≤ 2（成本）' , path: ['count']});
});
```

---

## 5.4 节点数据流模型（上游数据怎么进来）

### 5.4.1 三条数据来源，优先级从高到低
```
1. pinnedInputs[portId]     用户手动钉住的产物（人工选择 → 最高优先，覆盖自动数据流）
2. runCache[runId:nodeId:portId]  本次 run 上游节点的成功产物（WS node.artifact 推送填充）
3. lastGoodOutputs[nodeId:port]   上一次成功执行的产物（跨 run 复用，支持离线预览）
```
无数据 → 端口显示灰色空心柄 + 节点徽标「缺少输入」，运行按钮 disabled。

### 5.4.2 解析函数（纯函数，可单测）
```ts
export function resolveInputs(
  nodeId: string, graph: WorkflowGraph,
  caches: { run: RunCache; lastGood: LastGoodCache },
): { values: Record<string, PortValue>; missing: string[] } {
  const node = graph.nodes[nodeId];
  const spec = nodeRegistry.get(node.data.type);
  const values: Record<string, PortValue> = {};
  const missing: string[] = [];

  for (const port of spec.inputs) {
    // ① 钉住值
    const pinned = node.data.pinnedInputs?.[port.id];
    if (pinned) { values[port.id] = fromArtifact(pinned, caches); continue; }

    // ② 入边（multi 聚合全部；非 multi 取“最新成功边”）
    const edges = graph.edges.filter(e => e.target === nodeId && e.targetHandle === `in:${port.id}`);
    const picked = port.multi ? edges : edges.filter(e => !isStaleNode(e.source, caches)).slice(-1);
    const collected: ArtifactRef[] = [];
    for (const e of picked) {
      const v = caches.run[`${e.source}:out:${e.sourceHandle.split(':')[1]}`]
             ?? caches.lastGood[`${e.source}:out:${e.sourceHandle.split(':')[1]}`];
      if (v) collected.push(...(('items' in v) ? v.items : []));
    }
    if (collected.length) values[port.id] = { type: port.type as any, items: dedupeByDigest(collected) };
    else if (port.required) missing.push(port.id);
  }
  return { values, missing };
}
```

### 5.4.3 单节点执行的输入快照
前端提交 `POST /runs {mode:'single', node_ids:[id]}` 时**不传数据**，只传节点 id —— 后端用同一套规则从 DB（`node_run.outputs`）解析输入。
> 关键决策：**数据流解析逻辑前后端同构**（共享契约测试），前端解析仅用于「预览/徽标/本地 Mock」，权威解析在后端，避免双真相。

---

## 5.5 连线与端口校验

### 5.5.1 类型兼容矩阵
```ts
const COMPAT: Record<PortType, readonly PortType[]> = {
  text:  ['text', 'any'],
  image: ['image', 'any'],
  video: ['video', 'image', 'any'],   // 静图可入视频节点（走 static_motion / i2v 首帧）
  audio: ['audio', 'any'],
  json:  ['json', 'any'],
  any:   ['text', 'image', 'video', 'audio', 'json'],
};
```

### 5.5.2 校验器（拖拽实时 + 落边双保险）
```ts
export function validateConnection(
  conn: Connection, graph: WorkflowGraph,
): { ok: boolean; reason?: string; severity?: 'error' | 'warn' } {
  const { source, target, sourceHandle, targetHandle } = conn;
  if (!source || !target) return { ok: false, reason: 'Invalid handle' };
  if (source === target) return { ok: false, reason: '不能连接自身' };

  const sSpec = spec(source, graph), tSpec = spec(target, graph);
  const sPort = sSpec.outputs.find(p => `out:${p.id}` === sourceHandle);
  const tPort = tSpec.inputs.find(p => `in:${p.id}` === targetHandle);
  if (!sPort || !tPort) return { ok: false, reason: '端口不存在' };

  if (!COMPAT[sPort.type].includes(tPort.type))
    return { ok: false, reason: `${sPort.type} → ${tPort.type} 类型不匹配` };

  // 容量：非 multi 输入只能一条入边
  const existing = graph.edges.filter(e => e.target === target && e.targetHandle === targetHandle);
  const warn = !tPort.multi && existing.length >= (tPort.maxConnections ?? 1)
    ? '将替换已有连线' : undefined;

  // 环检测（试连后 toposort）
  if (createsCycle(graph, conn)) return { ok: false, reason: '会产生循环依赖' };

  // 锁定节点
  if (isLocked(target, graph) || isLocked(source, graph))
    return { ok: false, reason: '节点已锁定' };

  // 肖像/授权风险：仅告警不阻断（运行期由 PolicyService 强制）
  if (tPort.type === 'image' && upstreamHasUnlicensedPortrait(conn, graph))
    return { ok: true, severity: 'warn', reason: '上游含未授权真人素材，导出将被阻断' };

  return { ok: true, ...(warn ? { severity: 'warn' as const, reason: warn } : {}) };
}
```
React Flow 挂载点：`isValidConnection={c => validateConnection(c, graph).ok}`，`onConnect` 内再校验一次（并写入 patch 走 undo 栈）。

### 5.5.3 端口视觉语言
| 状态 | 表现 |
|---|---|
| 类型匹配（拖拽中） | 端口放大 + 绿色脉冲 |
| 类型不匹配 | 端口变灰 + 光标 `not-allowed`，顶部 toast 说明原因 |
| 必填未连接 | 端口空心灰 + 节点左上角橙色徽标 |
| 已连接 | 端口实心填充（按 PortType 配色：text 灰 / image 蓝 / video 紫 / audio 绿 / json 琥珀） |
| 钉住值 | 端口右侧出现 📌 图标 + tooltip「已手动指定」 |
| stale 上游 | 边转为虚线 + 50% 透明，节点黄框 |

---

## 5.6 前端执行引擎

### 5.6.1 权威在后端（重要）
前端**不做生产调度**，只做：①拓扑校验 ②执行计划预览（分层可视化）③乐观状态 ④WS 事件归约 ⑤局部重跑引导。
`localScheduler.ts` 仅在 `VITE_USE_LOCAL_MOCK=true`（离线开发/Playwright 测试）时启用，接口与后端 `/runs` 完全一致，保证测试与生产同构。

### 5.6.2 拓扑排序（Kahn，含分层）
```ts
export interface ExecPlan { levels: string[][]; order: string[]; }

export function buildPlan(
  graph: WorkflowGraph,
  opts: { mode: 'full' | 'subgraph' | 'single'; nodeIds?: string[]; includeUpstream?: boolean },
): ExecPlan {
  let nodes = graph.nodes.map(n => n.id);
  if (opts.mode !== 'full') {
    let sel = new Set(opts.nodeIds ?? []);
    if (opts.mode === 'subgraph' && opts.includeUpstream !== false) sel = withUpstream(graph, sel);
    nodes = nodes.filter(id => sel.has(id));
  }
  const indeg = new Map(nodes.map(id => [id, 0]));
  const adj = new Map<string, string[]>(nodes.map(id => [id, []]));
  for (const e of graph.edges)
    if (indeg.has(e.target) && indeg.has(e.source)) {
      adj.get(e.source)!.push(e.target);
      indeg.set(e.target, indeg.get(e.target)! + 1);
    }
  const levels: string[][] = []; const order: string[] = [];
  let frontier = nodes.filter(id => indeg.get(id) === 0);
  while (frontier.length) {
    levels.push(frontier); order.push(...frontier);
    const next: string[] = [];
    for (const id of frontier)
      for (const t of adj.get(id)!) {
        indeg.set(t, indeg.get(t)! - 1);
        if (indeg.get(t) === 0) next.push(t);
      }
    frontier = next;
  }
  if (order.length !== nodes.length) throw new Error('CYCLE_DETECTED');
  return { levels, order };
}
```
**分层用途**：①UI 按 level 展示并行度 ②本地 Mock 逐层并发 ③后端按层做并发闸门。

### 5.6.3 stale 传播
```ts
export function markStale(graph: WorkflowGraph, changed: string[]): Set<string> {
  const out = new Set<string>(); const queue = [...changed];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of graph.edges.filter(e => e.source === id))
      if (!out.has(e.target)) { out.add(e.target); queue.push(e.target); }
  }
  return out;   // 只标状态，不清产物 → 用户可继续预览旧结果，重跑时按需刷新
}
```
触发点：①参数变更 ②入边增删 ③上游产物 digest 变化（WS `node.artifact`）④上游节点被重跑成功。

### 5.6.4 状态归约（WS → store）
```ts
const reducers: Record<EventType, (s: Stores, e: MvaEvent) => void> = {
  'run.status':    (s, e) => s.run.setRunStatus(e.payload),
  'node.status':   (s, e) => s.run.setNodeStatus(e.payload.node_id, e.payload.status, e.payload),
  'node.progress': (s, e) => s.run.setProgress(e.payload.node_id, e.payload.pct, e.payload.stage),
  'node.artifact': (s, e) => s.run.putArtifact(e.payload.node_id, e.payload.artifact),
  'node.log':      (s, e) => s.run.appendLog(e.payload.node_id, e.payload),
  'cost.warning':  (s, e) => s.ui.toast('warning', `已花费 ¥${e.payload.spent_cny} / ¥${e.payload.limit_cny}`),
  'policy.blocked':(s, e) => s.ui.openPolicyDialog(e.payload),
  'patch.proposed':(s, e) => s.patch.enqueueProposal(e.payload),
  'patch.applied': (s, e) => { s.graph.applyPatchRemote(e.payload); s.patch.pushUndo(e.payload); },
  'graph.updated': (s, e) => s.graph.reconcile(e.payload),
};
```

### 5.6.5 执行交互
| 动作 | 前端行为 |
|---|---|
| 单节点运行 | 该节点乐观置 `queued`；上游缺失 → toast 拦截；后端返回后由 WS 驱动 |
| 子图运行 | 框选后浮动工具栏「运行选中」；默认 `includeUpstream:true` 自动补全上游（可开关） |
| 全量运行 | 顶栏「运行全部」；先本地 `buildPlan` 校验环/必填，再弹「预估 ¥X / 约 Y 分钟」确认 |
| 取消 | 优雅取消，运行中节点等回调或超时；UI 显示「取消中…」 |
| 重试失败节点 | 节点上「重试」按钮 → `POST /runs/{id}/nodes/{id}/retry`；不阻塞其他节点 |
| 断线恢复 | 重连 → `GET /runs/{id}` 全量拉取 + WS `since` 补增量（先全量后增量，防漏） |

---

## 5.7 Undo/Redo：Patch 化（与前身同构）

```ts
export type PatchOp =
  | { op: 'add_node'; node: SerializedNode }
  | { op: 'remove_node'; node_id: string }
  | { op: 'update_node_params'; node_id: string; params: Record<string, unknown> }
  | { op: 'connect'; edge: SerializedEdge }
  | { op: 'disconnect'; edge_id: string }
  | { op: 'move'; node_id: string; position: XY }
  | { op: 'group'; group_id: string; node_ids: string[]; label?: string }
  | { op: 'ungroup'; group_id: string }
  | { op: 'pin_input'; node_id: string; port_id: string; artifact_id: string | null };

export interface GraphPatch {
  patch_id: string; base_version: number; rationale: string;
  author: 'user' | 'agent' | 'template';
  ops: PatchOp[];
}
```
- 本地操作 → 300ms 防抖合并同类 `move`/`update_node_params` → 入栈 + 乐观应用 + `POST /workflows/{id}/patches`。
- `patch.applied`（远端，含 Agent）→ 入栈并标记 `remote`，`Cmd+Z` 可整批撤销 Agent 的操作。
- `applyPatch(graph, patch)` 为**纯函数**（返回新 graph），前后端同构实现 + 契约测试（同一 `(graph, patch)` 输入产出同一结果）。
- 撤销栈上限 100；跨会话持久化最近 20 步到 IndexedDB（防刷新丢失）。

---

## 5.8 工作流 JSON Schema（持久化 / 模板导出）

```jsonc
{
  "$id": "mva.workflow.v1",
  "schemaVersion": "1.0.0",
  "id": "wf_01H...",
  "name": "气泡水 20s 种草",
  "version": 13,
  "viewport": { "x": 120, "y": 80, "zoom": 0.9 },
  "nodes": [
    { "id": "n_a1b2c3", "type": "script",
      "position": { "x": 0, "y": 0 },
      "label": "分镜脚本",
      "params": { "targetDurationS": 20, "shotCount": 6,
                  "skill": "mva.script.storyboard", "skillVersion": "1.3.0" },
      "locked": false, "enabled": true, "createdBy": "agent", "groupId": "g_main",
      "ui": { "collapsed": false, "width": 320, "height": 220 } }
  ],
  "edges": [
    { "id": "e_x1y2z3", "source": "n_a1b2c3", "sourceHandle": "out:json",
      "target": "n_d4e5f6", "targetHandle": "in:in", "data": { "pinned": false } }
  ],
  "groups": [ { "id": "g_main", "label": "主流程", "nodeIds": ["n_a1b2c3", "n_d4e5f6"], "color": "slate" } ],
  "pinnedInputs": { "n_g7h8i9:in:first": "art_9f8e7d" },
  "skillVersions": { "n_a1b2c3": "mva.script.storyboard@1.3.0" },
  "constraints": { "budgetLimitCny": 8.0, "platform": "douyin", "ratio": "9:16" }
}
```

**模板导出信封**
```jsonc
{
  "kind": "mva.template",
  "schemaVersion": "1.0.0",
  "exportedAt": "2026-01-01T10:00:00Z",
  "generator": "mva-web/0.1.0",
  "template": { "name": "产品图生视频（竖屏）", "category": "ecommerce",
                "variables": [
                  { "key": "product_name", "label": "产品名", "type": "string", "default": "" },
                  { "key": "usp", "label": "核心卖点", "type": "string[]", "default": [] } ],
                "graph": { /* 上面的 WorkflowGraph（去掉 id/version，位置相对化） */ } }
}
```
**版本迁移**：`migrate.ts` 维护 `migrators: Record<string, (doc:any)=>any>`（`1.0.0→1.1.0` 链式），导入时先 `schemaVersion` 升级再 Zod 校验；未知版本 → 明确报错并保留原文，不静默吞。
**变量实例化**：`instantiateTemplate(tpl, variables)` 遍历节点 params 做 `{{product_name}}` 插值（仅白名单字段），生成新 id 保证不与现有节点冲突。

---

## 5.9 通信协议（前端视角）

```ts
// ws/events.ts
export type EventType =
  | 'run.status' | 'node.status' | 'node.progress' | 'node.artifact' | 'node.log'
  | 'patch.proposed' | 'patch.applied' | 'graph.updated'
  | 'cost.warning' | 'policy.blocked';

export interface MvaEvent<T extends EventType = EventType> {
  event_id: string; seq: number; ts: string;
  workflow_id: string; run_id?: string; trace_id?: string;
  type: T; payload: PayloadOf<T>;
}
```

```ts
// ws/client.ts —— 重连 + 缺口检测 + 心跳 + 可见性降频
export function useWorkflowSocket(workflowId: string) {
  const lastSeq = useRef(0);
  useEffect(() => {
    let ws: WebSocket, retry = 0, timer: number;
    const connect = () => {
      ws = new WebSocket(`${WS_BASE}/ws/workflows/${workflowId}?token=${getToken()}&since=${lastSeq.current}`);
      ws.onopen = () => { retry = 0; void resyncFull(); };          // 先全量后增量，防漏
      ws.onmessage = (m) => {
        const evt = MvaEventSchema.parse(JSON.parse(m.data));        // Zod 校验，脏数据不崩 UI
        if (evt.seq !== lastSeq.current + 1) void resyncFull();      // 缺口 → 全量
        lastSeq.current = Math.max(lastSeq.current, evt.seq);
        dispatch(evt);
      };
      ws.onclose = () => {
        timer = window.setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000) + Math.random() * 500);
      };
    };
    connect();
    const hb = setInterval(() => ws?.readyState === 1 && ws.send('{"type":"ping"}'), 25_000);
    const onVis = () => document.hidden && ws?.close();              // 隐藏即断开，回前台重连
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(hb); clearTimeout(timer); ws?.close();
                   document.removeEventListener('visibilitychange', onVis); };
  }, [workflowId]);
}
```

**REST（前端调用的关键端点）**：`/workflows/{id}`(GET/PATCH)、`/workflows/{id}/patches`(+`:apply`/`:reject`)、`/workflows/{id}/undo|validate|export`、`/runs`(POST)、`/runs/{id}`、`/runs/{id}/nodes/{nid}/retry`、`/runs/{id}/resume`、`/assets/upload-url`、`/models`、`/costs/summary`、`/templates/{id}/instantiate`。

**Agent 对话**：`POST /agent/sessions/{id}/messages` 返回 `{reply, patch_id?}`；流式走 SSE `EventSource`（token 级输出 + 工具轨迹），与 WS 分离。

---

## 5.10 画布交互规格

| 交互 | 实现 |
|---|---|
| 无限画布 | React Flow `panOnScroll` `zoomOnDoubleClick={false}` `minZoom={0.1}` `maxZoom={2}` `onlyRenderVisibleElements` `nodeOrigin={[0,0]}` |
| 缩放平移 | 滚轮缩放 / 空格+拖拽 / 触控板双指 / `Cmd+0` 适配视图 / `F` 聚焦选中 |
| 双击空白 | 快捷创建菜单（搜索 + 最近使用 + 按 category 分组，回车即建，`instantiate()` 给智能默认值） |
| 拖入外部文件 | `useDropExternal`：识别 mime → 建对应节点 → 立即 `upload-url` 上传（节点内显示上传进度环）→ 成功后自动打标并填预览 |
| 框选 / 多选 | 内置 selection（`selectionOnDrag` 空格切换）；`Cmd+A` 全选；`Shift+点击` 加选 |
| 吸附 / 对齐 | `snapToGrid={[8,8]}`；拖动时计算 8px 内邻居边缘对齐线（`useAlignment`），显示洋红线 |
| 打组（视觉） | `Cmd+G` → 创建 group（React Flow 父节点 `parentId`+`extent:'parent'`，整体拖动）；`Cmd+Shift+G` 解组 |
| 打组为模板 | 选中节点 →「存为模板」→ 序列化子图 + 变量抽取（把文字/产品名等可变字段标为变量）→ `POST /templates` |
| 节点折叠 | 双击标题栏或点击 chevron → 只留标题+状态+端口（height 48px） |
| 浮动工具栏 | 选中时 `NodeToolbar`：运行 / 重试 / 复制 / 删除 / 打组 / 锁定 / 禁用 / 折叠 |
| 内联编辑 | 文本节点 `contentEditable`；图像/视频/音频参数在节点内直接调（Inspector 仅做批量与高级） |
| 键盘 | `Cmd+Z/Cmd+Shift+Z` 撤销重做 · `Cmd+D` 复制 · `Delete` 删除 · `Cmd+G` 打组 · `Cmd+S` 保存 · `Cmd+/` 命令面板 |
| 画布性能保护 | 拖动中禁用参数面板重算（`useDeferredValue`）；>80 节点自动折叠所有节点预览 |

---

## 5.11 实时预览

| 类型 | 内联表现 | 放大 |
|---|---|---|
| 图像 | 缩略图（`loading="lazy"`，320px 宽）+ 张数徽标「2/4」 | 点击 → Lightbox：多张对比网格、左右切换、**「选为下游输入」**按钮（写 `pinnedInputs`） |
| 视频 | `<video preload="metadata" muted playsInline>`，悬停自动播、移出暂停；显示时长/分辨率徽标 | 点击 → 大屏播放器 + 逐帧步进（`currentTime ± 1/30`） |
| 音频 | WebAudio 解码 → canvas 峰值波形（不引第三方库）+ 播放/暂停 + 时长 | 点击 → 波形放大 + 时间轴 + 字幕 cue 打点叠加 |
| 质检 | 分数条（5 维雷达/条形）+ 问题列表（点击问题定位到对应镜头节点） | 报告全屏 + 证据帧对比 |
| 文本/JSON | 折叠预览前 6 行，`Cmd+E` 展开全屏编辑器（JSON 可折叠树） |

**URL 生命周期**：产物 URL 为预签名（TTL 1h），前端记录 `urlExpiresAt`，到期前 5 分钟批量换新（`POST /artifacts/refresh-urls`）；图片/视频加载失败自动重试 1 次并刷新 URL。

---

## 5.12 性能预算与实现要点

| 指标 | 目标 | 手段 |
|---|---|---|
| 200 节点 / 300 边拖动 | ≥50fps | `onlyRenderVisibleElements`、节点 `memo`、Zustand 细粒度订阅（`useGraph(s => s.nodes[id].data.status)`）、拖拽只改 `position` 不触发数据流重算 |
| 首次渲染 | <1.5s（graph ≤100 节点） | 路由级 code split、React Flow 按需加载、缩略图懒加载 |
| WS 事件吞吐 | 200 evt/s 不卡顿 | 事件合批（`requestAnimationFrame` 内合并同节点事件）、日志面板虚拟化（react-window） |
| 内存 | <400MB | 大视频不预加载、离屏节点 `IntersectionObserver` 挂起、预览图走浏览器缓存 |
| 草稿保护 | 刷新不丢 | graph 变更 2s 防抖写 IndexedDB + 服务端已保存版本标记 |

---

## 5.13 与 Agent 融合的前端部分

### 提案卡（ProposalCard）
```tsx
<ProposalCard
  rationale="用户要求突出 0 糖，补充产品特写镜头"
  changes={[
    { kind: 'add',    label: '新增 图像节点「0糖标签特写」(T-B, ¥0.06)' },
    { kind: 'update', label: '分镜脚本：shot_03 运镜 中景 → 特写' },
    { kind: 'connect',label: '分镜 → 新图像节点' },
  ]}
  costDeltaCny={0.18}
  risk="medium"
  onAccept={() => applyPatch(patchId)}
  onAcceptPartial={(opIds) => applyPatch(patchId, { acceptedOpIds: opIds })}
  onReject={(reason) => rejectPatch(patchId, reason)}
  onPreview={() => setGhostOverlay(patch.ops)}   // 幽灵预览：不落图，虚线高亮
/>
```
### 协同细节
| 场景 | 前端行为 |
|---|---|
| 幽灵预览 | `patch.preview` 把 ops 渲染成半透明虚线节点/边（独立 overlay 层），不写 graphStore |
| 生成动画 | Agent 应用 patch 时节点 stagger 出现（80ms 间隔），可在设置关闭 |
| 冲突提示 | `conflict` 非空时在提案卡顶部黄条：「你在 n_3 的手改已保留，Agent 建议已放入提案箱」 |
| 锁定 | 锁定节点显示锁图标 + 边框变灰；Agent 尝试修改时该 op 在提案卡中被划掉并注明「已锁定，已跳过」 |
| 手动覆盖优先 | 用户手改产生 `author:'user'` patch；后端三方合并时用户值优先（阶段 1 §4.3） |
| 一键撤销 Agent | `Cmd+Z` 或提案卡「撤销」→ 整批回滚该 patch |

---

**下一步**：确认后进入 **阶段 6：后端 API 与执行引擎** —— 工作流 CRUD、节点/子图/全量执行 API、执行状态推送、模型适配器接口实现、PatchApplier 三方合并算法、调度器伪代码。
