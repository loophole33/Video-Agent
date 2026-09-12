# 阶段 6：后端 API 与执行引擎
> 项目：AI 营销视频智能体（MVA）｜技术栈：Python 3.12 + FastAPI + Pydantic v2 + Postgres + Redis(arq) + MinIO

---

## 6.1 应用结构与装配

```
apps/api/
├── main.py                     # FastAPI 实例 + 中间件 + 路由挂载 + 生命周期
├── deps.py                     # 依赖注入（db session / repo / services / current_user）
├── core/
│   ├── config.py               # pydantic-settings（env 驱动，含模型价格表与预算默认值）
│   ├── errors.py               # MvaError 分类 + 异常处理器 + 统一错误响应
│   ├── security.py             # JWT / HMAC / 预签名 URL / 角色与权限矩阵
│   ├── ratelimit.py            # Redis 令牌桶依赖
│   └── obs.py                  # OTel + 结构化日志 + trace_id 透传
├── api/v1/
│   ├── projects.py  assets.py  workflows.py  patches.py
│   ├── runs.py      templates.py  agent.py  models.py
│   ├── qa.py        costs.py     evals.py   skills.py
│   ├── webhooks.py  ws.py        health.py
├── schemas/                    # Pydantic 请求/响应模型（与前端 TS 契约同源）
├── services/                   # workflow / agent / execution / asset / policy / cost / qa / render
├── engine/
│   ├── dag.py                  # build_plan / toposort / levels / subgraph 补全
│   ├── scheduler.py            # 依赖计数事件驱动调度器
│   ├── run_controller.py       # run 状态机 + 断点续跑 + 取消
│   ├── executors/{base.py, text.py, image.py, video.py, audio.py, script.py,
│   │              prompt_compile.py, qa_check.py, compose.py, registry.py}
│   ├── inputs.py               # resolve_inputs（与前端同构）
│   ├── idempotency.py          # input_hash / node_run 幂等
│   └── budget.py               # BudgetGuard
├── adapters/
│   ├── base.py  registry.py  gateway.py
│   ├── llm/{openai_compat.py, doubao.py, qwen.py}
│   ├── image/{doubao_image.py, jimeng.py, sd_webui.py, mock.py}
│   ├── video/{kling.py, jimeng_video.py, runway.py, pika.py, mock.py}
│   ├── audio/{tts_volc.py, tts_azure.py, asr_whisper.py, mock.py}
│   └── safety/{moderation_api.py, local_wordlist.py}
├── workers/{main.py, jobs.py, outbox.py, scheduler_cron.py}
└── db/{models.py, session.py, migrations/}
```

```python
# main.py
app = FastAPI(title="MVA API", version="1.0.0", openapi_url="/api/v1/openapi.json")

app.add_middleware(CORSMiddleware, allow_origins=settings.cors, allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])
app.middleware("http")(trace_middleware)        # 注入 trace_id，回写响应头 X-Trace-Id
app.middleware("http")(idempotency_middleware)  # Idempotency-Key 命中直接回放响应
app.add_exception_handler(MvaError, mva_error_handler)
app.add_exception_handler(RequestValidationError, validation_handler)

for r in (projects, assets, workflows, patches, runs, templates,
          agent, models, qa, costs, evals, skills, webhooks, health):
    app.include_router(r.router, prefix="/api/v1")
app.include_router(ws.router)                   # /ws/...（无 /api/v1 前缀）
```

---

## 6.2 统一约定

### 6.2.1 错误模型
```python
class MvaError(Exception):
    code: str; http_status: int; message: str; details: dict | None = None
```
```jsonc
// 响应体（所有非 2xx）
{ "error": { "code": "WORKFLOW_VERSION_CONFLICT",
             "message": "工作流已被修改",
             "details": { "expected_version": 12, "actual_version": 14, "conflicts": [...] },
             "trace_id": "tr_01H..." } }
```

| HTTP | code | 触发 |
|---|---|---|
| 400 | `VALIDATION_ERROR` / `CYCLE_DETECTED` / `PORT_TYPE_MISMATCH` | 请求或图非法 |
| 401/403 | `UNAUTHENTICATED` / `FORBIDDEN` / `NODE_LOCKED` | 鉴权与锁定 |
| 404 | `NOT_FOUND` | 资源不存在 |
| 409 | `WORKFLOW_VERSION_CONFLICT` / `RUN_ALREADY_ACTIVE` / `IDEMPOTENT_REPLAY` | 并发与幂等 |
| 402/429 | `BUDGET_EXCEEDED` / `RATE_LIMITED` / `QUOTA_EXCEEDED` | 成本与限流 |
| 422 | `POLICY_BLOCKED` / `CONSENT_REQUIRED` | 审核与授权 |
| 502/503 | `ADAPTER_UNAVAILABLE` / `DEPENDENCY_DOWN` | 上游模型/依赖 |
| 500 | `INTERNAL_ERROR` | 未分类（进 dead_letter + 告警） |

### 6.2.2 分页 / 鉴权 / 限流 / 幂等
| 约定 | 实现 |
|---|---|
| 分页 | `?limit=20&cursor=<opaque>` → `{items, next_cursor}`（游标基于 `(updated_at, id)`，不用 offset） |
| 鉴权 | `Authorization: Bearer <JWT>`；角色 `owner/admin/editor/viewer` 由 `require_role()` 依赖校验 |
| 限流 | `RateLimit(key="run:create", limit=30, window=60)` 依赖（Redis 令牌桶） |
| 幂等 | 请求头 `Idempotency-Key`：`INSERT ... ON CONFLICT DO NOTHING`，命中则回放存储的响应（TTL 24h） |
| 追踪 | 每请求生成 `trace_id`，写入日志/`node_run`/`cost_ledger`，响应头与错误体均返回 |
| 时间 | 一律 UTC ISO8601（`2026-01-01T10:00:00Z`） |

---

## 6.3 工作流 CRUD 与 Patch

### 6.3.1 端点
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/workflows` | 新建（`{project_id, name, template_id?, variables?}`） |
| GET | `/workflows/{id}` | `{id, name, graph, version, status, budget_limit_cny, spent_cny, updated_at}` |
| PATCH | `/workflows/{id}` | 元信息（`name` / `budget_limit_cny`） |
| DELETE | `/workflows/{id}` | 软删除（归档） |
| GET | `/workflows/{id}/versions?limit=` | 版本列表（不含 graph，除非 `?with_graph=true`） |
| POST | `/workflows/{id}/versions/{v}/restore` | 回滚 → 生成新版本 |
| POST | `/workflows/{id}/patches` | 提交 Patch（user/agent） |
| POST | `/workflows/{id}/patches/{pid}:apply` | 应用（支持 `accepted_op_ids` 部分接受） |
| POST | `/workflows/{id}/patches/{pid}:reject` | 拒绝（可带 reason） |
| POST | `/workflows/{id}/undo` | 撤销最近一次 patch |
| POST | `/workflows/{id}/validate` | DSL 校验（返回 errors/warnings 列表） |
| POST | `/workflows/{id}/export` · `POST /workflows/import` | 导出/导入 JSON |

```python
# schemas/workflow.py
class PatchSubmit(BaseModel):
    base_version: int = Field(ge=0)
    rationale: str = Field(default="", max_length=300)
    ops: list[PatchOp] = Field(min_length=1, max_length=40)
    author: Literal["user", "agent", "template"] = "user"
    auto_apply: bool = False          # 低风险时可跳过提案

class PatchSubmitOut(BaseModel):
    patch_id: str
    status: Literal["applied", "proposed", "partially_applied", "rejected"]
    result_version: int | None
    conflicts: list[Conflict] = []
    requires_approval: bool = False
    risk: Literal["low", "medium", "high"]
```

### 6.3.2 乐观锁 + 三方合并（核心算法）
```python
async def submit_patch(wf_id: str, body: PatchSubmit, actor: str) -> PatchSubmitOut:
    wf = await repo.get_for_update(wf_id)                      # SELECT ... FOR UPDATE
    patch_id = new_id("p_")
    risk = classify_risk(body.ops, wf)

    # ── 快路径：版本一致，直接应用 ──
    if body.base_version == wf.version:
        result = apply_ops(wf.graph, body.ops, actor=body.author, wf=wf)
        if result.hard_error:                                  # 环 / 端口非法 → 整批拒绝
            raise MvaError("VALIDATION_ERROR", 400, result.hard_error, result.details)
        await repo.save_graph(wf, result.graph, expect_version=wf.version)   # 带版本条件 UPDATE
        await repo.insert_version_snapshot(wf.id, wf.version + 1, result.graph, patch_id, body.author)
        await repo.insert_patch(patch_id, wf.id, body.base_version, wf.version + 1,
                                body.ops, body.rationale, body.author, "applied", result.conflicts)
        await bus.publish(wf.id, "patch.applied", {...}); await bus.publish(wf.id, "graph.updated", {...})
        return PatchSubmitOut(patch_id=patch_id, status="applied", result_version=wf.version + 1)

    # ── 慢路径：三方合并（base / current-user / incoming） ──
    base = await repo.get_version_graph(wf.id, body.base_version)
    merged, conflicts = three_way_merge(base, wf.graph, body.ops, incoming_author=body.author)
    status = "applied" if not conflicts else "partially_applied"
    if risk != "low" and not body.auto_apply and body.author == "agent":
        status = "proposed"                                    # 进提案箱，等用户批准
    await repo.insert_patch(patch_id, wf.id, body.base_version, None,
                            body.ops, body.rationale, body.author, status, conflicts)
    if status != "proposed":
        await repo.save_graph(wf, merged, expect_version=wf.version)
        await repo.insert_version_snapshot(wf.id, wf.version + 1, merged, patch_id, body.author)
        await bus.publish(wf.id, "patch.applied", {...})
    else:
        await bus.publish(wf.id, "patch.proposed", {...})
    return PatchSubmitOut(patch_id=patch_id, status=status, conflicts=conflicts, risk=risk)
```

```python
def three_way_merge(base: Graph, current: Graph, ops: list[Op], incoming_author: str) -> tuple[Graph, list[Conflict]]:
    """规则：用户手改优先；不可合并的 op 降级进提案箱（不静默丢弃）。"""
    out, conflicts = deepcopy(current), []
    base_nodes = idx(base.nodes)

    for op in ops:
        match op.op:
            case "add_node":
                if op.node.id in idx(out.nodes):
                    if node_equal(out_node, base_nodes.get(op.node.id)):
                        apply_add(out, op.node)                     # base 里没有且 current 也没有 → 正常加
                    else:
                        conflicts.append(Conflict(op, "ID_EXISTS", kept="current"))
                        apply_add(out, op.node.model_copy(update={"id": new_id("n_")}))  # 换 id 保双方
                else:
                    apply_add(out, op.node)

            case "update_node_params":
                cur, bas = find(out, op.node_id), find(base, op.node_id)
                if cur is None: conflicts.append(Conflict(op, "NODE_MISSING")); continue
                if cur.data.locked: conflicts.append(Conflict(op, "NODE_LOCKED", kept="current")); continue
                for k, v in op.params.items():
                    if bas and bas.data.params.get(k) != cur.data.params.get(k):
                        conflicts.append(Conflict(op, "FIELD_MODIFIED_BY_USER",
                                                  field=k, kept=cur.data.params.get(k), dropped=v))
                        continue                                        # ⭐ 用户值优先
                    cur.data.params[k] = v

            case "remove_node":
                cur = find(out, op.node_id)
                if cur is None: continue
                if cur.data.locked: conflicts.append(Conflict(op, "NODE_LOCKED", kept="current")); continue
                if connection_count(out, op.node_id) > 0 and incoming_author == "agent":
                    conflicts.append(Conflict(op, "HAS_CONNECTIONS", kept="current")); continue
                apply_remove(out, op.node_id)

            case "connect":
                port_edges = edges_into(out, op.edge.target, op.edge.targetHandle)
                if port_edges and not is_multi_port(out, op.edge.target, op.edge.targetHandle):
                    conflicts.append(Conflict(op, "PORT_OCCUPIED", kept="current")); continue
                if creates_cycle(out, op.edge): conflicts.append(Conflict(op, "CYCLE")); continue
                apply_connect(out, op.edge)

            case "disconnect":
                if edge_missing(out, op.edge_id): continue
                apply_disconnect(out, op.edge_id)

            case "move":
                nm = find(out, op.node_id)
                if nm and not near(nm.position, op.position, eps=1.0) and incoming_author == "agent":
                    conflicts.append(Conflict(op, "USER_MOVED", kept="current")); continue
                apply_move(out, op.node_id, op.position)

            case "group" | "ungroup" | "pin_input":
                apply_simple(out, op)
    return out, conflicts
```
**并发安全的落库**（防止 lost update）：
```sql
UPDATE workflow
   SET graph = $2::jsonb, version = version + 1, updated_at = now()
 WHERE id = $1 AND version = $3
RETURNING version;          -- 0 行 → 重试（≤3 次）或抛 WORKFLOW_VERSION_CONFLICT
```

---

## 6.4 执行 API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/runs` | 创建执行 |
| GET | `/runs/{id}` | 状态聚合（含 progress/spent/nodes 摘要/final_artifact） |
| GET | `/runs/{id}/nodes` | 节点级明细（分页） |
| GET | `/runs/{id}/nodes/{node_id}` | 单节点详情（inputs/outputs/resolved_params/model_call/log） |
| POST | `/runs/{id}/cancel` | 优雅取消 |
| POST | `/runs/{id}/resume` | 断点续跑 |
| POST | `/runs/{id}/nodes/{node_id}/retry` | 单点重试（`force` 忽略缓存） |
| GET | `/runs/{id}/estimate` | 成本/时长预估（不执行） |
| GET | `/runs/{id}/logs?node_id=&level=&cursor=` | 日志 |

```python
class RunCreate(BaseModel):
    workflow_id: str
    mode: Literal["full", "subgraph", "single"] = "full"
    node_ids: list[str] | None = None
    include_upstream: bool = True          # subgraph 时自动补全上游（复用缓存，不重复花钱）
    budget_limit_cny: Decimal | None = None
    force: bool = False                    # 忽略幂等缓存
    auto_run_downstream_on_retry: bool = False

@router.post("/runs", status_code=201)
async def create_run(body: RunCreate, user=Depends(current_user),
                     svc: ExecutionService = Depends(get_exec_service),
                     _=Depends(RateLimit("run:create", 30, 60))):
    wf = await svc.workflow.get(body.workflow_id)
    plan = svc.dag.build_plan(wf.graph, body.mode, body.node_ids, body.include_upstream)
    est = await svc.budget.estimate(wf, plan, body.force)
    limit = body.budget_limit_cny or wf.budget_limit_cny

    if est.cost_cny > limit:                       # 预算闸门（硬约束 7）
        raise MvaError("BUDGET_EXCEEDED", 402,
                       f"预估 ¥{est.cost_cny} 超出上限 ¥{limit}",
                       {"estimate": est.model_dump(), "suggestion": est.cheaper_plan})

    run = await svc.create_run(wf, body, plan, limit, est)
    await svc.outbox.enqueue_after_commit("drive_run", {"run_id": run.id})   # 事务性发件箱
    return {"run_id": run.id, "status": "queued",
            "estimate": {"cost_cny": float(est.cost_cny), "eta_s": est.eta_s,
                         "nodes": len(plan.order), "reused": est.reused_count}}
```

```python
@router.post("/runs/{run_id}/nodes/{node_id}/retry")
async def retry_node(run_id: str, node_id: str,
                     force: bool = Body(False), svc=Depends(get_exec_service)):
    run = await svc.get_run(run_id)
    if run.status in ("succeeded", "cancelled"):
        raise MvaError("INVALID_STATE", 409, "运行已结束，请对工作流重新发起运行")
    node = svc.dag.find(run.workflow_graph, node_id)
    est = await svc.budget.estimate_node(run, node, force)
    await svc.budget.assert_ok(run, est)                       # 单点重试也要过预算
    nr = await svc.enqueue_node(run, node, force=force, reset_downstream=True)
    return {"node_run_id": nr.id, "status": nr.status, "estimate": est.model_dump()}
```

---

## 6.5 执行引擎

### 6.5.1 DAG 构建（与前端同构）
```python
@dataclass
class ExecPlan:
    nodes: list[str]; order: list[str]; levels: list[list[str]]; deps: dict[str, set[str]]
    skipped: list[str]        # 未选中/禁用

def build_plan(graph, mode, node_ids, include_upstream=True) -> ExecPlan:
    sel = set(n.id for n in graph.nodes)
    if mode != "full":
        chosen = set(node_ids or [])
        if mode == "subgraph" and include_upstream:
            chosen = with_upstream(graph, chosen)
        sel &= chosen
    ...  # Kahn：degs + levels；order 长度 != sel 长度 → raise MvaError("CYCLE_DETECTED")
```
> `with_upstream()` 会**补全上游但按缓存复用**：上游若 `input_hash` 未变则不重新执行（成本 0），只保证数据可得。

### 6.5.2 依赖计数事件驱动调度器（生产实现）
```python
MAX_INFLIGHT = {"video": 6, "image": 12, "llm": 8, "render": 2, "default": 16}

async def drive_run(ctx: RunContext, run: Run):
    plan = build_plan(run.graph, run.mode, run.selected, run.include_upstream)
    state = await RunState.load(run.id, plan)          # 从 node_run 恢复（断点续跑）
    remaining = {n: set(plan.deps[n]) for n in plan.order if n not in state.finished}
    ready: asyncio.Queue[str] = asyncio.Queue()
    for n in plan.order:
        if n in state.finished: continue
        decision = decide(state, n)                    # REUSE / SKIP / EXECUTE
        if decision is REUSE:
            await state.mark_reused(n); await release_successors(n, remaining, ready)
        elif decision is SKIP:
            await state.mark_skipped(n); await release_successors(n, remaining, ready)
        elif not remaining[n]:
            await ready.put(n)

    inflight: dict[asyncio.Task, str] = {}
    try:
        while (not ready.empty()) or inflight:
            if await is_cancelled(run.id): raise RunCancelled
            while (not ready.empty()) and inflight_ok(inflight, ready):
                node_id = await ready.get()
                if await budget_blocks(run, node_id):          # 预算闸门（提交前）
                    await pause_for_budget(run); return
                task = asyncio.create_task(execute_node(ctx, run, node_id))
                inflight[task] = node_id

            done, _ = await asyncio.wait(inflight, timeout=1.0, return_when=FIRST_COMPLETED)
            for t in done:
                node_id = inflight.pop(t)
                res = await safe_result(t)                      # 异常也归一为 NodeResult(failed)
                await state.record(node_id, res)
                await bus.publish(run.workflow_id, "node.status", res.to_event())
                if res.status in ("success", "skipped"):
                    await release_successors(node_id, remaining, ready)
                else:
                    await handle_failure_policy(ctx, run, node_id, res, remaining, ready)

        run.status = finalize_status(state)                     # succeeded | partial | failed
        await finish_run(run, state)
    except RunCancelled:
        await cancel_run(run, state)
```

```python
def decide(state: RunState, node_id: str) -> Decision:
    nr = state.latest(node_id)
    node = state.node(node_id)
    if not node.enabled:                      return Decision.SKIP
    if nr is None:                            return Decision.EXECUTE
    if state.force:                           return Decision.EXECUTE
    if nr.status == "success" and nr.input_hash == input_hash(state, node_id):
        return Decision.REUSE                 # ⭐ 断点续跑与缓存复用（成本 0）
    return Decision.EXECUTE

def input_hash(state, node_id) -> str:
    node = state.node(node_id)
    upstream = [(e.source, state.output_digest(e.source, e.source_port))
                for e in state.graph.edges if e.target == node_id]
    payload = {"params": canonical_json(node.params),
               "pinned": node.pinned_inputs,
               "skill": state.resolved_skill_version(node_id),
               "upstream": sorted(upstream)}
    return sha256(canonical_json(payload))
```

**失败传播策略**（per-node 参数 `on_upstream_failure`: `fail`(默认) | `skip` | `wait`）：
```python
async def handle_failure_policy(ctx, run, node_id, res, remaining, ready):
    for succ in successors(node_id):
        policy = graph.node(succ).params.get("on_upstream_failure", "fail")
        if policy == "skip":
            await state.mark_skipped(succ); await release_successors(succ, remaining, ready)
        elif policy == "wait":
            pass                                  # 保持 blocked，等人修复后 resume
        else:
            await state.mark_blocked(succ, reason=f"upstream {node_id} failed")
    # 若失败节点在关键路径（通向 final_artifact）→ run 将 finalize 为 failed/partial
```

### 6.5.3 NodeExecutor（每个节点类型一个）
```python
class NodeResult(BaseModel):
    status: Literal["success", "failed", "skipped", "cancelled"]
    outputs: dict[str, Any] = {}
    artifacts: list[ArtifactRef] = []
    cost_cny: Decimal = Decimal("0")
    latency_ms: int = 0
    error: NodeError | None = None
    meta: dict = {}                       # adapter/model/seed/params_used/skill_version

class BaseNodeExecutor(ABC):
    node_type: str
    def validate(self, node, inputs) -> list[str]: ...          # 运行前参数与输入校验
    def estimate(self, node, inputs, ctx) -> Decimal: ...        # 成本预估
    @abstractmethod
    async def run(self, node, inputs, ctx: NodeExecContext) -> NodeResult: ...

class NodeExecContext(BaseModel):
    run_id: str; workflow_id: str; node_id: str; trace_id: str
    gateway: ModelGateway; policy: PolicyService; cost: CostService
    store: ObjectStore; qa: QAService; workspace: str; attempt: int
    publish: Callable[[str, dict], Awaitable[None]]             # 事件推送
    is_cancelled: Callable[[], Awaitable[bool]]

EXECUTORS: dict[str, BaseNodeExecutor] = {}
def register(node_type: str):
    def deco(cls): EXECUTORS[node_type] = cls(); return cls
    return deco
```
**示例：image 执行器骨架**
```python
@register("image")
class ImageExecutor(BaseNodeExecutor):
    node_type = "image"

    async def run(self, node, inputs, ctx) -> NodeResult:
        p = node.params
        await self._pre_checks(node, inputs, ctx)                    # L2 审核 + 授权校验
        if p.get("tier") == "T-C" and inputs.get("ref"):
            return await self._reuse_upload(node, inputs, ctx)       # 直接复用素材，零成本
        req = GenerationRequest(
            prompt=p["prompt"], negative_prompt=inputs.get("negative"),
            refs=[a.url for a in inputs.get("refs", [])],
            params={"ratio": p["ratio"], "resolution": p["resolution"],
                    "count": p["count"], "seed": p.get("seed") or stable_seed(node)},
            callback_url=ctx.callback_url("image"), idempotency_key=ctx.idempotency_key)
        spec = ctx.gateway.select("image", tier=p.get("tier"), model=p.get("model"), budget=ctx.remaining_budget)
        result = await ctx.gateway.generate(spec, req, ctx)          # 提交/轮询/回调归一 + 重试
        arts = await ctx.store.persist_all(result.artifacts, ctx.path("image"))
        await ctx.policy.check("L3", arts)                           # 输出审核
        best = await self._pick_best(arts, node, inputs, ctx)        # 合规→清晰度→一致性
        return NodeResult(status="success", outputs={"out": {"type": "image", "items": arts},
                                                    "meta": {"type": "json", "value": result.meta}},
                          artifacts=arts, cost_cny=result.cost_cny,
                          latency_ms=result.latency_ms, meta={"adapter": spec.adapter, "model": spec.model,
                          "seed": req.params["seed"], "chosen": best.id})
```

### 6.5.4 幂等（DB 级）
```python
async def ensure_node_run(session, run, node, attempt) -> tuple[NodeRun, bool]:
    key = node_run_key(run.id, node.id, input_hash(run, node.id))     # 不含 attempt：重试复用同一执行槽
    row = await session.execute(
        insert(NodeRun).values(id=new_id("nr_"), run_id=run.id, node_id=node.id,
                              node_type=node.type, attempt=attempt, status="queued",
                              idempotency_key=key, input_hash=input_hash(run, node.id))
        .on_conflict_do_nothing(index_elements=["idempotency_key"])
        .returning(NodeRun))
    created = row.scalar_one_or_none()
    if created: return created, True
    existing = await session.scalar(select(NodeRun).where(NodeRun.idempotency_key == key))
    return existing, False        # 已存在 → 直接复用其结果（Agent 重复提案 / 用户重复点击都安全）
```

### 6.5.5 断点续跑
```python
@router.post("/runs/{run_id}/resume")
async def resume(run_id: str, svc=Depends(get_exec_service)):
    run = await svc.get_run(run_id)
    if run.status not in ("failed", "partial", "paused"):
        raise MvaError("INVALID_STATE", 409, f"当前状态 {run.status} 不可续跑")
    # 1) 重新装载 worker 内未完成的任务（可能已丢失）
    await svc.reclaim_inflight(run_id)                 # status=running 但 worker 已死 → 标 failed(orphan)
    # 2) 决定每个节点的动作：复用 success 且 input_hash 未变者
    plan = svc.dag.build_plan(run.graph, "full", None, True)
    decisions = {n: decide(await RunState.load(run_id, plan), n) for n in plan.order}
    est = await svc.budget.estimate_decisions(run, decisions)
    await svc.budget.assert_ok(run, est)
    await svc.outbox.enqueue_after_commit("drive_run", {"run_id": run_id})
    return {"run_id": run_id, "resumed": True, "to_execute": sum(1 for d in decisions.values()
            if d is Decision.EXECUTE), "reused": sum(1 for d in decisions.values() if d is Decision.REUSE),
            "estimate": est.model_dump()}
```
**孤儿任务回收**（scheduler cron，每 60s）：
```sql
UPDATE node_run SET status='failed',
       error='{"class":"transient","message":"worker lost"}'
 WHERE status='running' AND started_at < now() - interval '30 minutes';

UPDATE run SET status='failed', error='{"code":"ORPHANED"}'
 WHERE status='running' AND updated_at < now() - interval '45 minutes';
```
> 超时阈值按节点类型配置（video 30min、image 10min、llm 3min、render 20min）。

### 6.5.6 预算闸门
```python
class BudgetGuard:
    async def assert_ok(self, run, est: Estimate, raise_on_exceed=True):
        spent = await self.cost.spent(run.id)
        if spent + est.cost_cny > run.budget_limit_cny:
            if raise_on_exceed: raise MvaError("BUDGET_EXCEEDED", 402, ...)
            return False
        if (spent + est.cost_cny) / run.budget_limit_cny >= 0.8:
            await bus.publish(run.workflow_id, "cost.warning", {...})       # 80% 预警
        return True

    async def on_call_settled(self, run, node_run, actual: Decimal):        # 每次真实花费后
        await self.cost.ledger.add(...); await self.run.add_spent(run.id, actual)
        if await self.cost.spent(run.id) >= run.budget_limit_cny:
            await self.pause_run(run, reason="budget_exhausted")            # 熔断：暂停并询问
```

---

## 6.6 队列与 Worker（arq + Redis）

```python
# workers/main.py
class WorkerSettings:
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    functions = [drive_run, execute_node_job, render_compose, run_eval, poll_task, dispatch_outbox]
    cron_jobs = [cron(dispatch_outbox, second={0, 10, 20, 30, 40, 50}),
                 cron(sweep_timeouts, minute=set(range(60)), second={5}),
                 cron(reconcile_costs, minute={0, 30}),
                 cron(cleanup_expired, hour={3})]
    max_jobs = 32
    job_timeout = 1800
    keep_result = 3600
    queue_name = "mva:default"
```
| 队列 | 用途 | 并发 | 说明 |
|---|---|---|---|
| `mva:agent` | Agent 会话处理 | 8 | 单会话串行（Redis 锁） |
| `mva:image` | 图像生成 | 12 | 快任务 |
| `mva:video` | 视频生成 | 6 | **独立队列**，防饿死短任务 |
| `mva:audio` | TTS/ASR | 8 | |
| `mva:render` | FFmpeg 合成 | 2 | CPU/IO 密集，限并发 |
| `mva:eval` | 评测 | 4 | 可抢占 |

**事务性发件箱**（保证「DB 提交 → 入队」不丢）：
```python
async def outbox_enqueue_after_commit(session, kind: str, payload: dict):
    session.add(JobOutbox(id=new_id("jo_"), kind=kind, payload=payload, status="pending"))

async def dispatch_outbox(ctx):                 # cron 每 10s
    async with db.transaction() as tx:
        rows = await tx.execute(select(JobOutbox).where(JobOutbox.status == "pending",
                                JobOutbox.next_retry_at <= now()).with_for_update(skip_locked=True).limit(200))
        for r in rows.scalars():
            await redis.enqueue_job(r.kind, **r.payload, _queue_name=queue_of(r.kind))
            r.status = "sent"
```
**按 adapter 限流**（在 ModelGateway 内）：
```python
class RateLimiter:                                   # Redis 令牌桶 + 并发信号量
    async def acquire(self, adapter: str, spec: ModelSpec):
        while True:
            ok = await self._token(adapter, spec.rpm)
            if ok and await self._sem(adapter, spec.concurrency): return
            await asyncio.sleep(0.2 + random.random() * 0.3)      # 429 时降速重排，不失败
```

---

## 6.7 模型回调

```python
@router.post("/webhooks/models/{adapter}")
async def model_callback(adapter: str, request: Request,
                         x_sig: str = Header(alias="X-MVA-Signature"),
                         x_ts: str = Header(alias="X-MVA-Timestamp")):
    raw = await request.body()
    verify_hmac(adapter, raw, x_sig, x_ts, tolerance_s=300)          # 防重放 + 防伪造
    body = json.loads(raw)
    dedupe_key = f"cb:{adapter}:{body.get('task_id')}:{sha256(raw)}"
    if not await redis.set(dedupe_key, "1", nx=True, ex=86400):
        return {"ok": True, "deduped": True}                          # 幂等：重复回调不重复推进
    status = REGISTRY.get(adapter).parse_callback(body)               # → 统一 TaskStatus
    await task_service.advance(adapter, body["task_id"], status)      # 唤醒等待中的 worker
    return {"ok": True}
```
**回调缺失时的兜底**：scheduler cron 扫描 `awaiting_callback` 且超过 `spec.expected_p95 * 2` 的任务 → 主动 `poll()` 一次；仍无结果 → 标 `timeout` 并按矩阵重试。

---

## 6.8 执行状态推送（WebSocket Hub）

```python
class EventBus:
    async def publish(self, workflow_id: str, type_: str, payload: dict,
                      run_id: str | None = None, trace_id: str | None = None) -> int:
        evt = {"event_id": new_id("evt_"), "ts": utcnow_iso(), "workflow_id": workflow_id,
               "run_id": run_id, "trace_id": trace_id, "type": type_, "payload": payload}
        seq = await redis.xadd(f"mva.events.{workflow_id}", {"data": json.dumps(evt)},
                               maxlen=10_000, approximate=True)
        evt["seq"] = seq
        await redis.publish(f"mva.pub.{workflow_id}", json.dumps(evt))     # 实时扇出
        return seq

    async def replay(self, workflow_id: str, since: int, limit: int = 2000) -> list[dict]:
        rows = await redis.xrange(f"mva.events.{workflow_id}", min=f"({since}", max="+", count=limit)
        return [json.loads(r[1]["data"]) | {"seq": int(r[0].split("-")[0])} for r in rows]
```

```python
# api/v1/ws.py
@router.websocket("/ws/workflows/{workflow_id}")
async def workflow_ws(ws: WebSocket, workflow_id: str, token: str, since: int = 0):
    user = decode_ws_token(token)                       # 鉴权失败 → close(4401)
    await ws.accept()
    try:
        for evt in await bus.replay(workflow_id, since):        # ① 补历史（断线重放）
            await ws.send_json(evt)
        pubsub = redis.pubsub(); await pubsub.subscribe(f"mva.pub.{workflow_id}")
        heartbeat = asyncio.create_task(ws_heartbeat(ws))       # ② 25s ping
        async for msg in pubsub.listen():                       # ③ 实时增量
            if msg["type"] != "message": continue
            await ws.send_text(msg["data"])
    except WebSocketDisconnect:
        pass
    finally:
        await pubsub.unsubscribe(f"mva.pub.{workflow_id}"); heartbeat.cancel()
```
**规模扩展**：多 API 实例时 pubsub 天然广播；单实例 >2000 连接 → 连接分组（按 workflow 分片到不同 Hub 进程）。

---

## 6.9 Agent 对话（SSE）

```python
@router.get("/agent/sessions/{sid}/stream")
async def agent_stream(sid: str, user=Depends(current_user)):
    async def gen():
        async for chunk in agent_service.stream(sid):        # LangGraph/自研状态机逐 token
            yield f"event: {chunk.type}\ndata: {json.dumps(chunk.data, ensure_ascii=False)}\n\n"
        yield "event: done\ndata: {}\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
```
`chunk.type ∈ {token, tool_call, tool_result, patch_proposed, question, done, error}`。

---

## 6.10 模型适配器实现

```python
# adapters/base.py
class BaseAdapter(ABC):
    spec: ModelSpec
    async def submit(self, req) -> TaskHandle: ...
    async def poll(self, handle) -> TaskStatus: ...
    async def fetch(self, handle) -> GenerationResult: ...
    def estimate_cost(self, req) -> Decimal: ...
    def normalize_error(self, exc) -> MvaError: ...
    def parse_callback(self, payload: dict) -> TaskStatus: ...
```

```python
# adapters/video/kling.py
ERROR_MAP = {  # 厂商错误码 → 统一分类（集中一处，便于新增厂商）
    1001: ("transient", "服务繁忙"), 1002: ("rate_limited", "超出频率限制"),
    1101: ("quota_exceeded", "余额不足"), 1200: ("content_blocked", "内容审核未通过"),
    1400: ("invalid_request", "参数错误"),
}

class KlingVideoAdapter(BaseAdapter):
    spec = ModelSpec(adapter="kling", model="kling-v2", capability=Capability.VIDEO,
                     price=Decimal("0.90"), price_unit="per_second", max_prompt_chars=1500,
                     ratios=("9:16","16:9","1:1"), resolutions=("1080x1920",), max_duration_s=5,
                     supports_callback=True, supports_seed=True, supports_first_frame=True,
                     supports_last_frame=True, supports_negative_prompt=True,
                     concurrency=3, rpm=30, quality_tier="A")

    async def submit(self, req) -> TaskHandle:
        payload = {"model_name": self.spec.model, "prompt": req.prompt,
                   "negative_prompt": req.negative_prompt,
                   "image": req.refs[0] if req.refs else None,
                   "image_tail": req.params.get("last_frame"),
                   "duration": str(int(req.params["duration_s"])),
                   "aspect_ratio": req.params["ratio"], "seed": req.params.get("seed"),
                   "callback_url": req.callback_url, "external_business_id": req.idempotency_key}
        r = await self._post("/v1/videos/text2video|image2video", payload, signed=True)
        return TaskHandle(adapter="kling", external_task_id=r["data"]["task_id"], submitted_at=utcnow())

    def estimate_cost(self, req) -> Decimal:
        return self.spec.price * Decimal(str(req.params["duration_s"]))

    def parse_callback(self, payload: dict) -> TaskStatus:
        st = payload["task_status"]
        if st == "succeed": return TaskStatus(state="succeeded", progress=1.0)
        if st == "failed":
            cls, msg = ERROR_MAP.get(payload.get("task_status_msg_code"), ("fatal", "未知错误"))
            return TaskStatus(state="failed", error=MvaError(cls, 502, msg))
        return TaskStatus(state="running", progress=payload.get("progress", 0) / 100)
```

```python
# adapters/gateway.py
class ModelGateway:
    def select(self, capability, *, tier=None, model=None, budget=None,
               exclude: set[str] = frozenset()) -> ModelSpec:
        cands = [s for s in REGISTRY.by_capability(capability)
                 if s.adapter not in exclude and (self._healthy(s.adapter))
                 and (model is None or s.model == model)]
        if tier: cands = sorted(cands, key=lambda s: (abs(tier_rank(s.quality_tier) - tier_rank(tier)),
                                                      s.price))
        if budget is not None: cands = [s for s in cands if s.price <= budget] or cands[:1]
        if not cands: raise MvaError("ADAPTER_UNAVAILABLE", 503, f"无可用 {capability} 适配器")
        return cands[0]

    async def generate(self, spec, req, ctx) -> GenerationResult:
        errors = []
        for attempt in range(1, settings.max_retries + 1):
            try:
                async with self.limiter.slot(spec):
                    handle = await self._adapter(spec).submit(req)
                status = await self._await_result(spec, handle, ctx)     # 回调等待 or 轮询
                if status.state == "succeeded":
                    return await self._fetch_and_persist(spec, handle, ctx)
                raise status.error or MvaError("INTERNAL", 500, "未知失败")
            except Exception as e:
                err = self._adapter(spec).normalize_error(e)
                await self._breaker.record(spec.adapter, err)
                errors.append(err)
                if err.code in ("content_blocked", "invalid_request", "fatal"): raise err
                if err.code == "quota_exceeded":
                    spec = self.select(spec.capability, tier=spec.quality_tier, exclude={spec.adapter})
                    continue                                                  # 自动切备用厂商
                await asyncio.sleep(min(2 ** attempt + random.random(), 60))  # transient/429
        raise MvaError("ADAPTER_UNAVAILABLE", 503, "重试耗尽", {"errors": [e.code for e in errors]})
```
**降级链与熔断**：`_breaker` 记录连续失败（≥5 次/60s → 熔断 60s）；熔断期间 `select()` 自动跳过该 adapter 并在成片账单里标注「已降级，成本变化 +¥X」。

---

## 6.11 事务与一致性要点

| 关注点 | 做法 |
|---|---|
| 图与补丁一致 | 同一事务内：`UPDATE workflow ... WHERE version=$old` + `INSERT workflow_version` + `INSERT graph_patch`；0 行 → 重试/报冲突 |
| DB→队列 | `job_outbox` 事务性发件箱 + cron 兜底投递（**绝不在事务内直接 enqueue**） |
| 幂等 | ①HTTP `Idempotency-Key` ②`node_run.idempotency_key` 唯一索引 ③回调去重键 ④`patch_id` 唯一 |
| 成本一致 | 每次 adapter 调用完成即写 `cost_ledger` + `UPDATE run SET spent_cny = spent_cny + $x`（同一事务） |
| 并发编辑 | `SELECT ... FOR UPDATE` + 版本条件 UPDATE；冲突走三方合并（用户优先） |
| 素材与产物 | 先写对象存储（幂等 key），再写 DB（失败则孤儿文件由 cleanup cron 清理） |
| 事务隔离 | Postgres 默认 Read Committed + 显式行锁；不需要 SERIALIZABLE |

---

## 6.12 权限与审计

| 端点组 | viewer | editor | admin | owner |
|---|---|---|---|---|
| GET 类 | ✅ | ✅ | ✅ | ✅ |
| 画布 patch / 运行 / 重试 | ❌ | ✅ | ✅ | ✅ |
| 删除工作流 / 发布模板 | ❌ | ❌ | ✅ | ✅ |
| 审核复核放行（`/qa/appeal`） | ❌ | ❌ | ✅ | ✅ |
| 成本上限 / 品牌套件配置 | ❌ | ❌ | ✅ | ✅ |
| 成员与计费 | ❌ | ❌ | ❌ | ✅ |

**审计**：所有写操作写 `audit_log`（`actor, action, target, before_digest, after_digest, ip, trace_id`）；审核命中、模板发布、预算修改额外告警。

---

**下一步**：确认后进入 **阶段 7：代码骨架** —— 完整目录树、关键类与函数签名、FastAPI 路由可运行代码、任务队列、适配器、前端组件骨架、docker-compose 与示例端到端片段。
