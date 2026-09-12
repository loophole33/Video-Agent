# 阶段 7：代码骨架
> 项目：AI 营销视频智能体（MVA）｜目标：**clone 后 3 条命令起全栈，无外部 API Key 也能跑通「一句话 → 成片」（Mock 适配器）**

---

## 7.1 仓库总览

```
mva/
├── docker-compose.yml
├── Makefile
├── .env.example
├── README.md
├── apps/
│   ├── api/                        # FastAPI 后端（见阶段 6 结构）
│   ├── worker/                     # arq worker（复用 api 的包）
│   └── web/                        # React 19 + Vite 前端
├── packages/
│   ├── contracts/                  # ⭐ 前后端共享契约
│   │   ├── workflow.schema.json    # mva.workflow.v1
│   │   ├── patch.schema.json       # mva.graph_patch.v1
│   │   ├── brief.schema.json / storyboard.schema.json / qa.schema.json
│   │   ├── events.schema.json      # WS 事件
│   │   ├── node_catalog.json       # 节点类型 + 端口 + 参数（前后端唯一来源）
│   │   └── fixtures/               # 契约测试用例（graph+patch → 期望 graph）
│   └── skills/                     # 版本化 Skill（见阶段 3）
│       ├── mva.copy.generate/{1.3.0/{manifest.yaml,prompt.jinja,*.schema.json,examples/,tests/}}
│       └── ...
├── scripts/{seed.py, e2e_demo.sh, export_contracts.py}
└── docs/                           # 阶段 1–9 文档
```

**契约单一来源**：`packages/contracts/node_catalog.json` 生成 ①后端 `EXECUTORS` 校验表 ②前端 `nodeRegistry` 的端口/参数默认值 ③Agent 的 `NODE_CATALOG` 注入文本。**改一处，三端同步**（`make contracts` 重新生成并跑契约测试）。

---

## 7.2 一键启动

```yaml
# docker-compose.yml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment: { POSTGRES_DB: mva, POSTGRES_USER: mva, POSTGRES_PASSWORD: mva }
    ports: ["5432:5432"]
    volumes: ["pg:/var/lib/postgresql/data"]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U mva"], interval: 5s, retries: 10 }
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    ports: ["6379:6379"]
  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment: { MINIO_ROOT_USER: minio, MINIO_ROOT_PASSWORD: minio123 }
    ports: ["9000:9000", "9001:9001"]
  api:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    command: uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
    env_file: .env
    volumes: [".:/srv"]
    ports: ["8000:8000"]
    depends_on: { postgres: { condition: service_healthy }, redis: { condition: service_started } }
  worker:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    command: arq app.workers.main.WorkerSettings
    env_file: .env
    volumes: [".:/srv"]
    depends_on: [api]
  web:
    build: { context: ., dockerfile: apps/web/Dockerfile }
    command: npm run dev -- --host
    volumes: [".:/srv", "/srv/node_modules"]
    ports: ["5173:5173"]
    environment: { VITE_API_BASE: "http://localhost:8000", VITE_USE_LOCAL_MOCK: "false" }
volumes: { pg: {} }
```

```makefile
# Makefile
up:        ; docker compose up -d --build
down:      ; docker compose down
migrate:   ; docker compose exec api alembic upgrade head
seed:      ; docker compose exec api python scripts/seed.py        # 建演示项目+素材+模板
contracts: ; python scripts/export_contracts.py && pytest packages/contracts -q
logs:      ; docker compose logs -f api worker
psql:      ; docker compose exec postgres psql -U mva -d mva
demo:      ; bash scripts/e2e_demo.sh                              # 一句话 → 成片（MOCK 模式）
```

```bash
# .env.example
DATABASE_URL=postgresql+asyncpg://mva:mva@postgres:5432/mva
REDIS_URL=redis://redis:6379/0
S3_ENDPOINT=http://minio:9000
S3_BUCKET=mva
S3_ACCESS_KEY=minio
S3_SECRET_KEY=minio123
JWT_SECRET=change-me
MODEL_MODE=mock                # mock | live   ← 关键：mock 无需任何外部 Key
DEFAULT_BUDGET_CNY=8.0
MAX_RETRIES=3
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
```

---

## 7.3 后端骨架

### 7.3.1 配置
```python
# apps/api/app/core/config.py
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    database_url: str; redis_url: str
    s3_endpoint: str; s3_bucket: str; s3_access_key: str; s3_secret_key: str
    jwt_secret: str; jwt_ttl_min: int = 30
    model_mode: str = "mock"                 # mock | live
    default_budget_cny: float = 8.0
    max_retries: int = 3
    callback_base_url: str = "http://localhost:8000"
    cors: list[str] = ["http://localhost:5173"]
    model_prices: dict = {}                  # 覆盖适配器默认价（热更新）

settings = Settings()
```

### 7.3.2 数据模型（SQLAlchemy 2.0）
```python
# apps/api/app/db/models.py
class Base(DeclarativeBase): pass

class Workflow(Base):
    __tablename__ = "workflow"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    graph: Mapped[dict] = mapped_column(JSONB)
    version: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(20), default="draft")
    budget_limit_cny: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("8.00"))
    spent_cny: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0.00"))
    template_id: Mapped[str | None]; template_version: Mapped[int | None]
    locked_node_ids: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    created_at: Mapped[datetime]; updated_at: Mapped[datetime]
    __table_args__ = (Index("ix_wf_project_updated", "project_id", desc("updated_at")),)

class GraphPatchRow(Base):
    __tablename__ = "graph_patch"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    workflow_id: Mapped[str] = mapped_column(ForeignKey("workflow.id"), index=True)
    base_version: Mapped[int]; result_version: Mapped[int | None]
    ops: Mapped[list] = mapped_column(JSONB); rationale: Mapped[str]
    author: Mapped[str]; status: Mapped[str]; conflict: Mapped[list] = mapped_column(JSONB, default=list)
    created_at: Mapped[datetime]

class Run(Base):
    __tablename__ = "run"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    workflow_id: Mapped[str] = mapped_column(ForeignKey("workflow.id"), index=True)
    workflow_version: Mapped[int]
    mode: Mapped[str]; selected_node_ids: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True)
    budget_limit_cny: Mapped[Decimal]; spent_cny: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    final_artifact_id: Mapped[str | None]; error: Mapped[dict | None] = mapped_column(JSONB)
    trace_id: Mapped[str]; started_at: Mapped[datetime | None]; finished_at: Mapped[datetime | None]

class NodeRun(Base):
    __tablename__ = "node_run"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("run.id"), index=True)
    node_id: Mapped[str]; node_type: Mapped[str]; attempt: Mapped[int] = mapped_column(default=1)
    status: Mapped[str] = mapped_column(String(20), default="queued")
    idempotency_key: Mapped[str] = mapped_column(String(64), unique=True)   # ⭐ 断点续跑 + 幂等
    input_hash: Mapped[str] = mapped_column(String(64))
    inputs: Mapped[dict] = mapped_column(JSONB, default=dict)
    outputs: Mapped[dict] = mapped_column(JSONB, default=dict)
    resolved_params: Mapped[dict] = mapped_column(JSONB, default=dict)
    cost_cny: Mapped[Decimal] = mapped_column(Numeric(10, 4), default=Decimal("0"))
    latency_ms: Mapped[int | None]; error: Mapped[dict | None] = mapped_column(JSONB)
    model_call_id: Mapped[str | None]
    started_at: Mapped[datetime | None]; finished_at: Mapped[datetime | None]
    __table_args__ = (Index("ix_nr_run_node", "run_id", "node_id", desc("attempt")),)

class Artifact(Base):
    __tablename__ = "artifact"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    run_id: Mapped[str | None]; node_id: Mapped[str | None]; node_run_id: Mapped[str | None]
    kind: Mapped[str]; storage_key: Mapped[str] = mapped_column(unique=True)
    mime: Mapped[str]; width: Mapped[int | None]; height: Mapped[int | None]
    duration_ms: Mapped[int | None]; size_bytes: Mapped[int | None]
    md5: Mapped[str] = mapped_column(index=True); meta: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime]

class Asset(Base):
    __tablename__ = "asset"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    workspace_id: Mapped[str]; project_id: Mapped[str | None]
    kind: Mapped[str]; storage_key: Mapped[str]; mime: Mapped[str]
    md5: Mapped[str]; source: Mapped[str] = mapped_column(default="upload")
    tags: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    portrait: Mapped[bool] = mapped_column(default=False)
    license_status: Mapped[str] = mapped_column(default="declared")
    embedding: Mapped[Any | None] = mapped_column(Vector(1024))          # pgvector
    created_at: Mapped[datetime]
    __table_args__ = (UniqueConstraint("workspace_id", "md5", name="uk_asset_ws_md5"),
                      Index("ix_asset_tags", "tags", postgresql_using="gin"))

# 其余：ConsentRecord / CostLedger / AuditLog / ModelCall / JobOutbox / IdempotencyKey
#      / WorkflowVersion / WorkflowTemplate / TemplateVersion / Skill / SkillVersion
#      / PromptTemplate / PromptVersion / AgentSession / AgentMessage
#      / EvalSet / EvalCase / EvalRun / EvalResult   （字段见阶段 2 §2.5）
```

### 7.3.3 应用装配
```python
# apps/api/app/main.py
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_pool()
    await store.ensure_bucket()
    registry.load(settings.model_mode)      # mock 模式只注册 Mock 适配器
    yield
    await db.close_pool()

app = FastAPI(title="MVA API", version="1.0.0", lifespan=lifespan)
app.middleware("http")(trace_middleware)
app.middleware("http")(idempotency_middleware)
app.add_exception_handler(MvaError, mva_error_handler)
for r in ALL_ROUTERS:
    app.include_router(r.router, prefix="/api/v1")
app.include_router(ws.router)
```

### 7.3.4 路由：workflows / patches / runs（可运行代码）
```python
# apps/api/app/api/v1/workflows.py
router = APIRouter(prefix="/workflows", tags=["workflows"])

@router.post("", status_code=201, response_model=WorkflowOut)
async def create_workflow(body: WorkflowCreate, user=Depends(require_role("editor")),
                          svc: WorkflowService = Depends(get_workflow_service)):
    return await svc.create(user, body)

@router.get("/{wf_id}", response_model=WorkflowOut)
async def get_workflow(wf_id: str, user=Depends(current_user), svc=Depends(get_workflow_service)):
    return await svc.get_or_404(wf_id)

@router.post("/{wf_id}/patches", response_model=PatchSubmitOut)
async def submit_patch(wf_id: str, body: PatchSubmit, user=Depends(require_role("editor")),
                       svc: WorkflowService = Depends(get_workflow_service)):
    return await svc.submit_patch(wf_id, body, actor=user.id)

@router.post("/{wf_id}/patches/{pid}:apply", response_model=PatchSubmitOut)
async def apply_patch(wf_id: str, pid: str, body: PatchApply | None = None,
                      user=Depends(require_role("editor")), svc=Depends(get_workflow_service)):
    return await svc.apply_proposed(wf_id, pid, accepted_op_ids=body.accepted_op_ids if body else None)

@router.post("/{wf_id}/undo", response_model=WorkflowOut)
async def undo(wf_id: str, user=Depends(require_role("editor")), svc=Depends(get_workflow_service)):
    return await svc.undo_last(wf_id, actor=user.id)

@router.post("/{wf_id}/validate", response_model=ValidationOut)
async def validate(wf_id: str, svc=Depends(get_workflow_service)):
    return await svc.validate(wf_id)

@router.post("/{wf_id}/export", response_model=TemplateEnvelope)
async def export_wf(wf_id: str, svc=Depends(get_workflow_service)):
    return await svc.export(wf_id)
```

```python
# apps/api/app/api/v1/runs.py
@router.post("", status_code=201, response_model=RunCreateOut)
async def create_run(body: RunCreate, user=Depends(require_role("editor")),
                     svc: ExecutionService = Depends(get_exec_service),
                     _=Depends(RateLimit("run:create", 30, 60))):
    return await svc.create_run(body)

@router.get("/{run_id}", response_model=RunDetailOut)
async def get_run(run_id: str, svc: ExecutionService = Depends(get_exec_service)):
    return await svc.detail(run_id)

@router.post("/{run_id}/nodes/{node_id}/retry", response_model=NodeRetryOut)
async def retry(run_id: str, node_id: str, force: bool = Body(False, embed=True),
                user=Depends(require_role("editor")), svc=Depends(get_exec_service)):
    return await svc.retry_node(run_id, node_id, force)

@router.post("/{run_id}/resume", response_model=RunResumeOut)
async def resume(run_id: str, user=Depends(require_role("editor")),
                 svc: ExecutionService = Depends(get_exec_service)):
    return await svc.resume(run_id)

@router.post("/{run_id}/cancel", response_model=RunDetailOut)
async def cancel(run_id: str, svc: ExecutionService = Depends(get_exec_service)):
    return await svc.cancel(run_id)
```

### 7.3.5 DAG / 幂等 / 预算
```python
# apps/api/app/engine/dag.py
def build_plan(graph: dict, mode: str, node_ids: list[str] | None,
               include_upstream: bool = True) -> ExecPlan:
    nodes = {n["id"]: n for n in graph["nodes"]}
    sel = set(nodes)
    if mode != "full":
        chosen = set(node_ids or [])
        if mode == "subgraph" and include_upstream:
            chosen = with_upstream(graph, chosen)
        sel &= chosen
    deps = {nid: {e["source"] for e in graph["edges"]
                  if e["target"] == nid and e["source"] in sel} for nid in sel}
    indeg = {nid: len(deps[nid]) for nid in sel}
    levels, order = [], []
    frontier = [n for n in sel if indeg[n] == 0]
    while frontier:
        levels.append(frontier); order += frontier
        nxt = []
        for nid in frontier:
            for e in graph["edges"]:
                if e["source"] == nid and e["target"] in sel:
                    indeg[e["target"]] -= 1
                    if indeg[e["target"]] == 0: nxt.append(e["target"])
        frontier = nxt
    if len(order) != len(sel):
        raise MvaError("CYCLE_DETECTED", 400, "工作流存在循环依赖")
    return ExecPlan(nodes=list(sel), order=order, levels=levels, deps=deps, skipped=[])

# apps/api/app/engine/idempotency.py
def canonical(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

def input_hash(graph: dict, node: dict, output_digests: dict[str, str]) -> str:
    up = sorted((e["source"], output_digests.get(e["source"], ""))
                for e in graph["edges"] if e["target"] == node["id"])
    payload = {"params": canonical(node.get("params", {})),
               "pinned": canonical(node.get("pinnedInputs", {})),
               "skill": node.get("skillVersions", ""), "upstream": up}
    return hashlib.sha256(canonical(payload).encode()).hexdigest()

# apps/api/app/engine/budget.py
class BudgetGuard:
    def __init__(self, cost_svc): self.cost = cost_svc

    async def estimate(self, run, plan, force=False) -> Estimate:
        total, reused, detail = Decimal("0"), 0, []
        for nid in plan.order:
            node = plan.nodes[nid]
            if not force and await self._is_reusable(run, nid):
                reused += 1; continue
            c = EXECUTORS[node["type"]].estimate(node, await resolve_inputs(run, nid))
            total += c; detail.append({"node_id": nid, "cost_cny": float(c)})
        return Estimate(cost_cny=total, reused_count=reused, eta_s=estimate_eta(plan),
                        detail=detail, cheaper_plan=suggest_cheaper(plan, total))

    async def assert_ok(self, run, est) -> bool:
        spent = await self.cost.spent(run.id)
        if spent + est.cost_cny > run.budget_limit_cny:
            raise MvaError("BUDGET_EXCEEDED", 402,
                           f"预估 ¥{est.cost_cny} + 已花 ¥{spent} 超过上限 ¥{run.budget_limit_cny}",
                           {"estimate": est.model_dump(), "suggestion": est.cheaper_plan})
        if (spent + est.cost_cny) / run.budget_limit_cny >= Decimal("0.8"):
            await bus.publish(run.workflow_id, "cost.warning",
                              {"spent_cny": float(spent), "limit_cny": float(run.budget_limit_cny),
                               "pct": float((spent + est.cost_cny) / run.budget_limit_cny)})
        return True
```

### 7.3.6 执行器：基类 + 注册表 + 两个真实实现
```python
# apps/api/app/engine/executors/base.py
class NodeExecContext(BaseModel):
    run_id: str; workflow_id: str; node_id: str; trace_id: str; attempt: int = 1
    gateway: Any; policy: Any; cost: Any; store: Any; qa: Any
    workspace: str
    publish: Callable[..., Awaitable[None]]
    is_cancelled: Callable[[], Awaitable[bool]]
    remaining_budget: Decimal = Decimal("8.00")

    def path(self, kind: str) -> str:
        return f"{self.workspace}/{self.workflow_id}/{self.run_id}/{self.node_id}/{kind}"

    def callback_url(self, capability: str) -> str:
        return f"{settings.callback_base_url}/api/v1/webhooks/models/{{adapter}}?node_run={self.node_id}"

class BaseNodeExecutor(ABC):
    node_type: str = ""
    def validate(self, node: dict, inputs: dict) -> list[str]: return []
    def estimate(self, node: dict, inputs: dict) -> Decimal: return Decimal("0")
    @abstractmethod
    async def run(self, node: dict, inputs: dict, ctx: NodeExecContext) -> NodeResult: ...

EXECUTORS: dict[str, BaseNodeExecutor] = {}
def register(t: str):
    def deco(cls): EXECUTORS[t] = cls(); cls.node_type = t; return cls
    return deco

# apps/api/app/engine/executors/registry.py
import app.engine.executors.{text, image, video, audio, script, prompt_compile, qa_check, compose}  # noqa
def load(mode: str):
    missing = set(CATALOG_NODE_TYPES) - set(EXECUTORS)
    if missing: raise RuntimeError(f"缺少执行器: {missing}")     # 启动即失败，别等运行时
```

```python
# apps/api/app/engine/executors/text.py
@register("text")
class TextExecutor(BaseNodeExecutor):
    """手动内容直接透传；LLM 模式调用版本化 Skill —— 与 Agent 走同一条路径（约束：单一能力单元）"""
    async def run(self, node, inputs, ctx):
        p = node["params"]
        if p.get("mode", "manual") == "manual" or p.get("content"):
            text = p.get("content") or _join_text(inputs.get("in"))
            return NodeResult(status="success",
                              outputs={"out": {"type": "text", "text": text}}, latency_ms=0)
        spec = SkillRegistry.resolve(p["skill"], p.get("skillVersion"))
        result = await SkillRunner.run(spec, {"brief": inputs.get("in"), **p},
                                       constraints=Constraints(cost_budget_cny=ctx.remaining_budget))
        if result.status != "ok":
            return NodeResult(status="failed", error=NodeError(
                class_="invalid_request", message=f"skill {result.status}", retryable=False))
        text = result.output["text"]
        await ctx.cost.record_llm(ctx, result.meta)
        return NodeResult(status="success", outputs={"out": {"type": "text", "text": text}},
                          cost_cny=result.meta.cost_cny, latency_ms=result.meta.latency_ms,
                          meta={"skill": f"{spec.key}@{spec.version}", "model": result.meta.model})

# apps/api/app/engine/executors/image.py  （骨架，同阶段 6 §6.5.3；此处给最小可跑版）
@register("image")
class ImageExecutor(BaseNodeExecutor):
    def estimate(self, node, inputs):
        p = node["params"]
        if p.get("tier") == "T-C": return Decimal("0.06") * p.get("count", 1)
        return REGISTRY.get(p.get("model") or "auto").price * p.get("count", 1)

    async def run(self, node, inputs, ctx):
        p = node["params"]
        await ctx.policy.check("L2", {"prompt": p["prompt"], "node_id": ctx.node_id})
        if p.get("tier") == "T-C" and inputs.get("ref"):
            return await self._reuse(inputs["ref"], node, ctx)
        spec = ctx.gateway.select("image", tier=p.get("tier"), model=p.get("model"),
                                 budget=ctx.remaining_budget)
        req = GenerationRequest(prompt=p["prompt"], negative_prompt=inputs.get("negative"),
                                refs=[a["url"] for a in inputs.get("refs", [])],
                                params={"ratio": p.get("ratio", "9:16"),
                                        "resolution": p.get("resolution", "1080x1920"),
                                        "count": p.get("count", 1),
                                        "seed": p.get("seed") or stable_seed(node["id"])},
                                callback_url=ctx.callback_url("image"),
                                idempotency_key=ctx.idempotency_key())
        res = await ctx.gateway.generate(spec, req, ctx)
        arts = await ctx.store.persist_all(res.artifacts, ctx.path("image"))
        await ctx.policy.check("L3", arts)
        await ctx.publish("node.artifact", {"node_id": ctx.node_id, "artifact": arts[0].model_dump()})
        return NodeResult(status="success",
                          outputs={"out": {"type": "image", "items": arts},
                                   "meta": {"type": "json", "value": res.meta}},
                          artifacts=arts, cost_cny=res.cost_cny, latency_ms=res.latency_ms,
                          meta={"adapter": spec.adapter, "model": spec.model})
```

```python
# apps/api/app/engine/executors/compose.py  （FFmpeg 合成，真实可用）
@register("compose")
class ComposeExecutor(BaseNodeExecutor):
    async def run(self, node, inputs, ctx):
        p = node["params"]
        clips = [a for a in inputs.get("video", [])] + inputs.get("videos", [])
        if not clips: return NodeResult(status="failed", error=NodeError(
            class_="invalid_request", message="没有可合成的视频片段", retryable=False))
        work = Path(tempfile.mkdtemp(prefix="mva_compose_"))
        for i, c in enumerate(clips): await ctx.store.download(c["storage_key"], work / f"in_{i}.mp4")
        ass = write_ass(subtitles_from(inputs.get("storyboard"), inputs.get("cues")), work / "sub.ass",
                        brand_kit=p.get("brandKitId"))
        out = work / "final.mp4"
        cmd = ["ffmpeg", "-y", *sum((["-i", str(work / f"in_{i}.mp4")] for i in range(len(clips))), []),
               "-i", str(ass), "-filter_complex", build_filtergraph(len(clips), p),
               "-map", "[vout]", *(["-map", "[aout]"] if p.get("bgmId") else []),
               "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
               "-r", str(p.get("fps", 30)), "-movflags", "+faststart", str(out)]
        await run_subprocess(cmd, timeout=p.get("timeoutS", 900))
        key = f"{ctx.path('final')}/final_v{node.get('attempt', 1)}.mp4"
        art = await ctx.store.put(out, key, kind="final", meta={
            "ai_generated": True, "brand_kit": p.get("brandKitId"), "bgm_license": p.get("bgmId"),
            "resolution": p.get("resolution", "1080x1920"), "duration_ms": await probe_duration(out)})
        return NodeResult(status="success", outputs={"out": {"type": "video", "items": [art]}},
                          artifacts=[art], cost_cny=Decimal("0.02"),
                          latency_ms=await last_cmd_ms())
```

### 7.3.7 适配器：注册表 + Mock（离线可跑的关键）
```python
# apps/api/app/adapters/registry.py
class AdapterRegistry:
    def __init__(self): self._by_cap: dict[Capability, list[BaseAdapter]] = defaultdict(list)
    def register(self, adapter: BaseAdapter):
        self._by_cap[adapter.spec.capability].append(adapter); return self
    def by_capability(self, cap): return sorted(self._by_cap[cap], key=lambda a: a.spec.price)
    def get(self, adapter_name: str) -> BaseAdapter: ...
REGISTRY = AdapterRegistry()

def load(mode: str):
    if mode == "mock":
        REGISTRY.register(MockLLM()).register(MockImage()).register(MockVideo()).register(MockTTS())
        return
    REGISTRY.register(DoubaoLLM(api_key=settings.doubao_key))
    REGISTRY.register(JimengImage(api_key=settings.jimeng_key)).register(DoubaoImage(...))
    REGISTRY.register(KlingVideo(...)).register(JimengVideo(...)).register(RunwayVideo(...))
    REGISTRY.register(VolcTTS(...)).register(WhisperASR(...))
```

```python
# apps/api/app/adapters/image/mock.py
class MockImage(BaseAdapter):
    """离线适配器：生成带文字的占位图，成本 0，用于开发/CI/E2E"""
    spec = ModelSpec(adapter="mock-image", model="mock-image-v1", capability=Capability.IMAGE,
                     price=Decimal("0"), price_unit="per_image", max_prompt_chars=2000,
                     ratios=("9:16", "16:9", "1:1"), resolutions=("1080x1920", "720x1280"),
                     supports_seed=True, concurrency=8, rpm=600, quality_tier="B")

    async def submit(self, req): 
        return TaskHandle(adapter=self.spec.adapter, external_task_id=new_id("mock_"),
                          submitted_at=utcnow(), payload=req)
    async def poll(self, handle): return TaskStatus(state="succeeded", progress=1.0)
    async def fetch(self, handle) -> GenerationResult:
        req: GenerationRequest = handle.payload
        w, h = map(int, req.params.get("resolution", "1080x1920").split("x"))
        img = render_placeholder(w, h, title=req.prompt[:60],
                                 subtitle=f"seed={req.params.get('seed')} #{req.params.get('i', 1)}")
        return GenerationResult(artifacts=[ArtifactRef(kind="image", data=img, mime="image/png",
                                                       width=w, height=h,
                                                       meta={"mock": True, "seed": req.params.get("seed")})],
                                meta={"adapter": self.spec.adapter, "seed": req.params.get("seed")},
                                cost_cny=Decimal("0"), latency_ms=120)
    def estimate_cost(self, req) -> Decimal: return Decimal("0")
    def normalize_error(self, exc): return MvaError("fatal", 500, str(exc))

# video/audio/llm 同构：MockVideo 返回 5s 纯色+计时器视频（ffmpeg 本地生成），MockTTS 返回正弦音+静音，MockLLM 用模板+规则产出合法 JSON
```

### 7.3.8 Worker
```python
# apps/api/app/workers/main.py
from arq.connections import RedisSettings
from arq import cron

async def startup(ctx):
    await db.init_pool(); registry.load(settings.model_mode); executors.load(settings.model_mode)
    ctx["gateway"] = ModelGateway(); ctx["bus"] = EventBus()

class WorkerSettings:
    functions = [drive_run, execute_node_job, render_compose, run_eval, poll_task, dispatch_outbox]
    cron_jobs = [cron(dispatch_outbox, second={0, 10, 20, 30, 40, 50}),
                 cron(sweep_timeouts, second={5}), cron(reconcile_costs, minute={0, 30})]
    on_startup = startup
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    max_jobs = 32; job_timeout = 1800; queue_name = "mva:default"

# apps/api/app/workers/jobs.py
async def execute_node_job(ctx, run_id: str, node_id: str, force: bool = False):
    run = await load_run(run_id)
    if await is_cancelled(run_id): return {"status": "cancelled"}
    node = find_node(run.graph, node_id)
    inputs = await resolve_inputs(run, node_id)                       # 权威输入解析（后端）
    ectx = NodeExecContext(run_id=run_id, workflow_id=run.workflow_id, node_id=node_id,
                           trace_id=run.trace_id, attempt=next_attempt(run, node_id),
                           gateway=ctx["gateway"], policy=PolicyService(), cost=CostService(),
                           store=ObjectStore(), qa=QAService(), workspace=run.workspace_id,
                           publish=lambda t, p: ctx["bus"].publish(run.workflow_id, t, p, run_id),
                           is_cancelled=lambda: is_cancelled(run_id))
    executor = EXECUTORS[node["type"]]
    errors = executor.validate(node, inputs)
    if errors: return {"status": "failed", "errors": errors}
    try:
        res = await executor.run(node, inputs, ectx)
    except MvaError as e:
        res = NodeResult(status="failed", error=NodeError(class_=e.code, message=e.message,
                                                          retryable=e.code in RETRYABLE))
    await persist_node_run(run, node_id, res, inputs)
    await CostService().settle(run, node_id, res.cost_cny)
    await ctx["bus"].publish(run.workflow_id, "node.status",
                             {"node_id": node_id, "status": res.status,
                              "cost_cny": float(res.cost_cny), "latency_ms": res.latency_ms,
                              "error": res.error.model_dump() if res.error else None}, run_id)
    return {"status": res.status}
```

### 7.3.9 Seed 脚本（让前端一打开就有东西看）
```python
# scripts/seed.py
async def main():
    ws = await ensure_workspace("demo")
    user = await ensure_user("demo@mva.local", role="owner")
    project = await create_project(ws, name="气泡水 20s 种草", goal="种草", product="气泡水",
                                  platform="douyin", duration_s=20, style="清爽")
    assets = [await import_asset(ws, p, tags=[...], portrait=False)
              for p in Path("fixtures/assets").glob("*.jpg")]
    tpl = await create_template(ws, name="产品图生视频（竖屏）", category="ecommerce",
                                graph=load_json("fixtures/graph_standard_ugc.json"),
                                variables=[{"key": "product_name", "type": "string"}])
    print({"workspace": ws.id, "project": project.id, "assets": len(assets), "template": tpl.id})
```

---

## 7.4 前端骨架

### 7.4.1 依赖与构建
```jsonc
// apps/web/package.json（节选）
{
  "dependencies": {
    "react": "^19.0.0", "react-dom": "^19.0.0",
    "@xyflow/react": "^12.3.0",
    "zustand": "^5.0.0",
    "zod": "^3.23.0",
    "@tanstack/react-query": "^5.59.0",
    "tailwindcss": "^3.4.0", "class-variance-authority": "^0.7.0",
    "lucide-react": "^0.450.0", "react-window": "^1.8.10", "immer": "^10.1.1"
  },
  "scripts": { "dev": "vite", "build": "tsc -b && vite build", "test": "vitest",
               "e2e": "playwright test" }
}
```

### 7.4.2 graphStore（含 applyPatch 纯函数 + undo）
```ts
// features/canvas/store/graphStore.ts
type GraphState = {
  graph: WorkflowGraph; version: number; dirty: boolean;
  applyLocal: (ops: PatchOp[]) => void;
  applyPatchRemote: (p: PatchAppliedPayload) => void;
  undo: () => Promise<void>; redo: () => Promise<void>;
};

export const useGraph = create<GraphState>()(immer((set, get) => ({
  graph: emptyGraph(), version: 0, dirty: false,

  applyLocal: (ops) => {
    const next = applyPatch(get().graph, { ops });          // 纯函数，前后端同构
    set(s => { s.graph = next; s.dirty = true; });
    scheduleFlush();                                        // 300ms 防抖 → POST /patches
  },

  applyPatchRemote: (p) => {
    set(s => {
      s.graph = applyPatch(s.graph, { ops: p.ops });
      s.version = p.version;
      s.dirty = false;
    });
    useRun.getState().markStale(p.changed_node_ids ?? []);   // 下游标 stale
  },

  undo: async () => { await api.post(`/workflows/${wfId}/undo`); await refetchGraph(); },
  redo: async () => { await api.post(`/workflows/${wfId}/redo`); await refetchGraph(); },
})));

// features/canvas/io/patch.ts —— 纯函数（与后端 three_way_merge 的快路径等价）
export function applyPatch(graph: WorkflowGraph, patch: { ops: PatchOp[] }): WorkflowGraph {
  const g = structuredClone(graph);
  for (const op of patch.ops) {
    switch (op.op) {
      case 'add_node':    g.nodes.push(op.node); break;
      case 'remove_node': g.nodes = g.nodes.filter(n => n.id !== op.node_id);
                          g.edges = g.edges.filter(e => e.source !== op.node_id && e.target !== op.node_id);
                          break;
      case 'update_node_params': {
        const n = g.nodes.find(n => n.id === op.node_id);
        if (n) n.data.params = { ...n.data.params, ...op.params };
        break; }
      case 'connect':     if (!g.edges.some(e => e.id === op.edge.id)) g.edges.push(op.edge); break;
      case 'disconnect':  g.edges = g.edges.filter(e => e.id !== op.edge_id); break;
      case 'move': { const n = g.nodes.find(n => n.id === op.node_id);
                     if (n) n.position = op.position; break; }
      case 'group': { const grp = g.groups.find(x => x.id === op.group_id)
                          ?? (g.groups.push({ id: op.group_id, label: op.label ?? '分组',
                                              nodeIds: [], color: 'slate' }), g.groups.at(-1)!);
                      grp.nodeIds = [...new Set([...grp.nodeIds, ...op.node_ids])];
                      op.node_ids.forEach(id => { const n = g.nodes.find(n => n.id === id);
                                                  if (n) n.data.groupId = op.group_id; });
                      break; }
      case 'ungroup':     g.groups = g.groups.filter(x => x.id !== op.group_id); break;
      case 'pin_input': { const n = g.nodes.find(n => n.id === op.node_id);
                          if (n) { n.data.pinnedInputs = { ...n.data.pinnedInputs,
                                   ...(op.artifact_id ? { [op.port_id]: op.artifact_id } : {}) };
                                   if (!op.artifact_id) delete n.data.pinnedInputs[op.port_id]; } break; }
    }
  }
  return g;
}
```

### 7.4.3 Canvas.tsx
```tsx
export default function Canvas({ workflowId }: { workflowId: string }) {
  const { graph, applyLocal } = useGraph();
  const { nodes, edges, onNodesChange, onEdgesChange } = useGraphBridge();   // store ↔ React Flow 适配
  useWorkflowSocket(workflowId);                                            // WS 订阅
  const { screenToFlowPosition } = useReactFlow();

  const onConnect = useCallback((c: Connection) => {
    const v = validateConnection(c, graph);
    if (!v.ok) return toast.error(v.reason!);
    if (v.severity === 'warn') toast.warning(v.reason!);
    applyLocal([{ op: 'connect', edge: mkEdge(c) }]);                       // 走 patch → undo 栈
  }, [graph, applyLocal]);

  const onDrop = useDropExternal((files, pos) => {                          // 外部文件拖入
    files.forEach(f => {
      const type = mimeToNodeType(f.type);                                  // image|video|audio
      applyLocal([{ op: 'add_node', node: mkNode(type, pos) }]);
      uploadAsset(f, { nodeId: nearestNodeId(pos) });                       // 预签名直传 + 进度环
    });
  });

  return (
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
      isValidConnection={(c) => validateConnection(c, graph).ok}
      onDrop={onDrop} onDragOver={e => e.preventDefault()}
      onDoubleClick={(e) => openQuickCreate(screenToFlowPosition({ x: e.clientX, y: e.clientY }))}
      panOnScroll minZoom={0.1} maxZoom={2} snapToGrid snapGrid={[8, 8]}
      onlyRenderVisibleElements selectionOnDrag
      defaultEdgeOptions={{ type: 'typed' }}
    >
      <Background variant={BackgroundVariant.Dots} gap={16} />
      <MiniMap pannable zoomable />
      <Controls />
      <Panel position="top-center"><RunToolbar workflowId={workflowId} /></Panel>
      <Panel position="bottom-right"><CostMeter workflowId={workflowId} /></Panel>
    </ReactFlow>
  );
}
```

### 7.4.4 BaseNode + 一个节点 spec
```tsx
// features/canvas/nodes/BaseNode.tsx
export function BaseNode<P extends object>({ id, data, selected }: NodeProps<MvaNode<P>>) {
  const spec = nodeRegistry.get(data.type);
  const { values, missing } = useResolvedInputs(id);
  const { run, retry } = useRunActions();
  const accent = ACCENT[spec.accent];

  return (
    <div className={cn('group rounded-xl border bg-white shadow-sm w-[300px]',
                       STATUS_RING[data.status],   // idle 灰 / stale 黄 / running 蓝脉冲 / success 绿 / failed 红
                       selected && 'ring-2 ring-sky-500')}>
      <header className="flex items-center gap-2 px-3 py-2 border-b">
        <spec.icon className={cn('size-4', accent.text)} />
        <input className="flex-1 bg-transparent text-sm font-medium outline-none"
               defaultValue={data.label}
               onBlur={e => useGraph.getState().applyLocal(
                 [{ op: 'update_node_params', node_id: id, params: { label: e.target.value } }])} />
        {data.locked && <Lock className="size-3.5 text-slate-400" />}
        {missing.length > 0 && <Badge tone="amber">缺少输入</Badge>}
        <button onClick={() => useUi.getState().toggleCollapse(id)}><ChevronDown /></button>
      </header>

      {!data.ui.collapsed && (
        <div className="p-3 space-y-2">
          <PreviewSlot nodeId={id} type={data.type} outputs={data.outputs} />   {/* 图像缩略图/视频播放器/波形 */}
          <InlineParams nodeId={id} spec={spec} />                              {/* Zod schema 自动生成表单 */}
          {data.error && <ErrorRow error={data.error} onRetry={() => retry(id)} />}
          {data.runMeta && (
            <footer className="flex justify-between text-[11px] text-slate-500">
              <span>{data.runMeta.adapter} · {data.runMeta.model}</span>
              <span>¥{data.runMeta.costCny?.toFixed(3)} · {(data.runMeta.latencyMs! / 1000).toFixed(1)}s</span>
            </footer>)}
        </div>
      )}

      {spec.inputs.map(p => <Handle key={p.id} id={`in:${p.id}`} type="target"
        position={Position.Left} style={portStyle(p, values, missing)} />)}
      {spec.outputs.map(p => <Handle key={p.id} id={`out:${p.id}`} type="source"
        position={Position.Right} style={portStyle(p, values, missing)} />)}

      <NodeToolbar isVisible={selected} className="flex gap-1">
        <ToolButton icon={Play} label="运行" onClick={() => run('single', [id])} />
        <ToolButton icon={RotateCcw} label="重试" disabled={data.status !== 'failed'} onClick={() => retry(id)} />
        <ToolButton icon={Copy} label="复制" onClick={() => duplicateNode(id)} />
        <ToolButton icon={Lock} label={data.locked ? '解锁' : '锁定'} onClick={() => toggleLock(id)} />
        <ToolButton icon={Group} label="打组" onClick={() => groupSelection()} />
        <ToolButton icon={Trash2} label="删除" onClick={() => applyLocal([{ op: 'remove_node', node_id: id }])} />
      </NodeToolbar>
    </div>
  );
}
```

```tsx
// features/canvas/registry/specs/image.tsx
export const ImageParams = z.object({ /* 见阶段 5 §5.3 */ });
export const imageSpec: NodeTypeSpec<z.infer<typeof ImageParams>> = {
  id: 'image', title: '图像生成', category: 'generate', icon: ImageIcon, accent: 'blue',
  description: '上传图片或调用文生图模型生成（支持 tier 分级控本）',
  inputs: [{ id: 'prompt', label: '提示词', type: 'text' },
           { id: 'ref', label: '参考图', type: 'image' },
           { id: 'refs', label: '参考图组', type: 'image', multi: true }],
  outputs: [{ id: 'out', label: '图像', type: 'image' }, { id: 'meta', label: '元数据', type: 'json' }],
  paramsSchema: ImageParams, defaultParams: ImageParams.parse({ prompt: '' }),
  Component: ImageNodeView,
  estimateCost: (p) => (p.tier === 'T-A' ? 0.9 : p.tier === 'T-B' ? 0.45 : 0.06) * p.count,
  instantiate: (ctx) => ({ prompt: ctx.upstreamText?.slice(0, 300) ?? '' }),
  groupable: true,
};
```

### 7.4.5 API 客户端 + WS
```ts
// shared/api.ts
export const api = {
  get:  <T>(p: string) => http<T>('GET', p),
  post: <T>(p: string, body?: unknown, idempotencyKey?: string) =>
          http<T>('POST', p, body, idempotencyKey),
};

// features/canvas/ws/useWorkflowSocket.ts （实现见阶段 5 §5.9）
export const useWorkflowSocket = (workflowId: string) => { /* since + seq 缺口 + 重连 + 心跳 */ };
```

### 7.4.6 应用外壳
```tsx
// App.tsx
export default function App() {
  return (
    <div className="grid grid-cols-[260px_1fr_340px] h-screen">
      <aside><TemplateLibrary /><NodePalette /></aside>
      <main className="relative">
        <Canvas workflowId={wfId} />
        <RunLogPanel />                      {/* 底部抽屉，虚拟化列表 */}
        <ProposalDock />                     {/* 右下角 Agent 提案卡 */}
      </main>
      <aside><Inspector /><CostMeter /><AgentChat sessionId={sid} /></aside>
    </div>
  );
}
```

---

## 7.5 端到端示例：一句话 → 成片（Mock 模式，无需外部 Key）

```bash
# 1) 起服务并初始化
make up && make migrate && make seed

# 2) 让 Agent 生成工作流（返回 patch_id）
curl -s localhost:8000/api/v1/agent/sessions -d '{"project_id":"prj_demo"}' -H 'Content-Type: application/json'
curl -s localhost:8000/api/v1/agent/sessions/$SID/messages -H 'Content-Type: application/json' -d '{
  "message":"给这款气泡水做一条 20s 抖音种草视频，清爽夏日感，突出 0 糖",
  "auto_apply": true }'
# → {"reply":"我生成了这套流程…","patch_id":"p_xxx","questions":[]}

# 3) 运行
curl -s localhost:8000/api/v1/runs -H 'Content-Type: application/json' \
  -d '{"workflow_id":"wf_demo","mode":"full","budget_limit_cny":8}' | tee run.json
# → {"run_id":"run_xxx","status":"queued","estimate":{"cost_cny":0.63,"eta_s":95,"reused":0}}

# 4) 观察事件（另开终端）
websocat "ws://localhost:8000/ws/workflows/wf_demo?token=$TOKEN&since=0"
# → {"seq":1,"type":"run.status","payload":{"status":"running",...}}
# → {"seq":2,"type":"node.status","payload":{"node_id":"n_script","status":"success",...}}
# → {"seq":9,"type":"node.artifact","payload":{"node_id":"n_image_3","artifact":{...}}}
# → {"seq":18,"type":"run.status","payload":{"status":"succeeded","final_artifact":{...}}}

# 5) 取成片
curl -s localhost:8000/api/v1/runs/run_xxx | jq '.final_artifact'
```

**预期事件序列**（Mock 模式，约 60–95s）：
```
1  run.status(running)
2  node.status(n_brief → success)
3  node.status(n_copy → success)     ┐ 并行
4  node.status(n_script → success)   ┘
5  node.status(n_tier → success)
6  node.status(n_img_1 → running) … node.artifact(n_img_1)
7  node.status(n_vid_1 → running)    ← i2v（Mock 生成 5s 占位视频）
8  node.status(n_tts → success) → node.artifact(n_tts)
9  node.status(n_qa → success)       report{total:0.91, verdict:"pass"}
10 node.status(n_compose → running) → node.artifact(final)
11 run.status(succeeded, final_artifact, spent_cny:0.63)
```

---

## 7.6 开发工作流

| 命令 | 作用 |
|---|---|
| `make up` / `make down` | 起停全栈 |
| `make migrate` | Alembic 升级（`alembic revision --autogenerate` 生成迁移） |
| `make seed` | 建演示数据（工作区/项目/素材/模板） |
| `make contracts` | 由 `node_catalog.json` 重生成前后端绑定 + 跑契约测试 |
| `make demo` | 跑通「一句话 → 成片」（Mock） |
| `pytest -q` / `npm test` / `npx playwright test` | 单测 / 前端单测 / E2E |
| `MODEL_MODE=live` | 切真实模型（需在 `.env` 配 Key；未配 Key 的 adapter 自动跳过） |

**契约测试（防前后端漂移）**：`packages/contracts/fixtures/*.json` 存 `(graph, patch) → expected_graph`，Python 与 TS 各自跑一遍 `applyPatch`，结果必须字节一致；`node_catalog.json` 的端口/参数名与两侧注册表必须完全一致（CI 门禁）。

---

## 7.7 交付清单与建议实现顺序（对齐阶段 1 的 W1–W4）

| 周 | 交付物 | 验收 |
|---|---|---|
| **W1** | `packages/contracts`（workflow/patch/node_catalog）+ 前端 Canvas 骨架（8 类节点注册、连线校验、undo/redo、模板库空壳）+ 后端 workflows/patches API + `applyPatch` 契约测试 | 拖节点连线、导出 JSON、导入还原；契约测试绿 |
| **W2** | Postgres 迁移 + Run/NodeRun + arq worker + DAG 调度 + 幂等 + Mock 适配器 + WS Hub + 前端 runStore 接线 | Mock 模式跑通「文本 → 图像」；WS 实时变色；断线重连不丢状态 |
| **W3** | 8 个 Executor 全实现（含 FFmpeg compose）+ PolicyService(3 层) + CostService/BudgetGuard + QA 规则引擎 + skill 版本化 + Agent（Brief/规划/提案） | `make demo` 全流程出 MP4；预算熔断生效；审核阻断有 audit_log |
| **W4** | 模板保存/实例化/导入导出 + 版本管理 + 评测集与 E2E + OTel/Prometheus 埋点 + 部署脚本 + 文档 | 阶段 1 §8 的 10 条 DoD 全绿 |

**风险最小化策略**：**W1–W2 全程 Mock 模式**——不依赖任何外部模型账号即可开发与联调，真实模型在 W3 之后按 adapter 逐个接入（每个 adapter 都有一份对应的 contract test 与录制回放 fixture，避免联调期反复烧钱）。

---

**下一步**：确认后进入 **阶段 8：测试与评测** —— 单测/集成/E2E（含画布交互）、评测指标与样例评测集、成本估算模型、画布交互端到端测试用例。
