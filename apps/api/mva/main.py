"""FastAPI 应用 —— 最小但形状正确的模型网关（docs/phase-6 §6.10 的最小落地）。

端点：
  GET  /healthz                       探针
  GET  /api/v1/models                 能力清单（画布据此显示可用模型与价格）
  POST /api/v1/images/generate        生成图像（同步返回，内部走 选型→限流→重试→降级→记账）
  GET  /api/v1/costs/summary          成本汇总
  GET  /assets/{path}                 产物静态服务
  POST /mock-provider/...             自测用假厂商（可关闭）
"""
from __future__ import annotations

import time
from decimal import Decimal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .adapters.base import Capability, GenerationRequest
from .adapters.errors import ErrorClass, MvaError
from .adapters.gateway import ModelGateway
from .adapters.registry import build_registry
from .config import settings
from .cost import CostLedger
from .imaging import probe_media_duration, probe_video, sniff_mime
from .mock_provider import router as mock_provider_router
from .skill_runner import SkillRunner
from .skills import build_registry as build_skills
from . import storage

VERSION = "0.3.0"


class ImageParams(BaseModel):
    tier: str = "T-B"
    ratio: str = "9:16"
    resolution: str = "1080x1920"
    count: int = Field(1, ge=1, le=4)
    seed: int | None = None
    steps: int | None = None


class GenerateImageRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=2000)
    negative_prompt: str | None = None
    params: ImageParams = ImageParams()
    node_id: str | None = None
    run_id: str | None = None
    model: str | None = None          # 'auto' 或具体 model/adapter 名
    budget_cny: float | None = None   # 单次调用预算上限（选型用）


class GenerateVideoRequest(BaseModel):
    """视频生成请求：i2v 传 first_frame_url，t2v 留空。

    注意：必须定义在模块级 —— 本文件用了 `from __future__ import annotations`，
    函数内定义的 Pydantic 模型会因注解解析失败被 FastAPI 当成 query 参数。
    """

    prompt: str = Field(..., min_length=1, max_length=1200)
    first_frame_url: str | None = None
    negative_prompt: str | None = None
    duration_s: int = Field(5, ge=2, le=15)   # wan2.7 支持 2–15s；更早的模型由适配器夹到 5/10
    resolution: str = "1080P"
    tier: str = "T-B"
    seed: int | None = None
    node_id: str | None = None
    run_id: str | None = None
    model: str | None = None
    budget_cny: float | None = None


class TTSSegment(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)
    shot_no: int | None = None


class GenerateTTSRequest(BaseModel):
    """配音请求：text（单段）或 segments（按分镜批量，用于音画对齐）。

    同 GenerateVideoRequest：必须定义在模块级，否则函数内的模型注解解析失败会被当成 query 参数。
    """

    text: str | None = Field(None, max_length=2000)
    segments: list[TTSSegment] | None = None
    voice: str | None = None
    model: str | None = None
    node_id: str | None = None
    run_id: str | None = None
    budget_cny: float | None = None


def create_app() -> FastAPI:
    ledger = CostLedger()
    registry = build_registry()
    gateway = ModelGateway(registry, ledger)
    skills = build_skills()
    skill_runner = SkillRunner(gateway, skills)

    app = FastAPI(title="MVA Model Gateway", version=VERSION)
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins or ["*"],
                       allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

    app.state.ledger = ledger
    app.state.gateway = gateway
    app.state.registry = registry
    app.state.skills = skills
    app.state.skill_runner = skill_runner

    async def _capabilities() -> dict[str, list[dict]]:
        out: dict[str, list[dict]] = {}
        for cap in Capability:
            avail = {a.spec.adapter for a in await registry.available(cap)}
            items = [{**a.spec.to_dict(), "available": a.spec.adapter in avail}
                     for a in registry.by_capability(cap)]
            if items:
                out[cap.value] = items
        return out

    @app.get("/healthz")
    async def healthz():
        caps = await _capabilities()
        return {
            "ok": True, "version": VERSION,
            "providers": {
                "image": settings.image_provider, "llm": settings.llm_provider,
                "video": settings.video_provider,
            },
            "image_provider": settings.image_provider,  # 兼容旧前端
            "available": [
                {"adapter": m["adapter"], "model": m["model"], "capability": cap,
                 "tier": m["quality_tier"], "price": m["price"]}
                for cap, items in caps.items() for m in items if m["available"]
            ],
            "capabilities": caps,
            "skills": skills.describe(),
            "storage": storage.usage(),
            "health": gateway.health_snapshot(),
            "warnings": registry.warnings,
        }

    @app.get("/api/v1/models")
    async def models():
        caps = await _capabilities()
        flat = [{"capability": cap, **m} for cap, items in caps.items() for m in items]
        return {
            "models": flat,
            "prices_configured": {
                "image_local": settings.price_local, "image_openai": settings.price_openai,
                "image_sd": settings.price_sd, "video_per_second": settings.price_video_sec,
                "llm_in_1k": settings.price_llm_in_1k, "llm_out_1k": settings.price_llm_out_1k,
            },
        }

    @app.get("/api/v1/skills")
    async def list_skills():
        return {"skills": skills.describe()}

    @app.post("/api/v1/skills/{key}")
    async def run_skill(key: str, payload: dict):
        """执行一个版本化 Skill：{input: {...}, version?: "1.2.0", node_id?}"""
        try:
            return await skill_runner.run(key, payload.get("input") or {}, payload.get("version"),
                                          node_id=payload.get("node_id"))
        except KeyError as e:
            raise HTTPException(status_code=404, detail={"error": {"class": "invalid_request",
                                                                  "message": str(e)}}) from e
        except MvaError as e:
            raise HTTPException(status_code=e.http_status,
                                detail={"error": e.to_dict()}) from e

    async def _generate(req: GenerateImageRequest) -> dict:
        started = time.perf_counter()
        greq = GenerationRequest(
            prompt=req.prompt,
            negative_prompt=req.negative_prompt,
            params={"tier": req.params.tier, "ratio": req.params.ratio,
                    "resolution": req.params.resolution, "count": req.params.count,
                    **({"seed": req.params.seed} if req.params.seed is not None else {}),
                    **({"steps": req.params.steps} if req.params.steps is not None else {})},
            idempotency_key=f"{req.run_id or '-'}:{req.node_id or '-'}:{abs(hash(req.prompt)) % 10**10}",
            timeout_s=settings.request_timeout_s,
        )
        budget = Decimal(str(req.budget_cny)) if req.budget_cny is not None else None
        attempts: list[dict] = []
        try:
            result, attempts = await gateway.generate(
                Capability.IMAGE, greq, tier=req.params.tier, model=req.model, budget=budget,
                node_id=req.node_id,
            )
        except MvaError as e:
            raise HTTPException(status_code=e.http_status,
                                detail={"error": e.to_dict(), "attempts": attempts}) from e

        artifacts = []
        for art in result.artifacts:
            data = art.data
            if data is None and art.url:
                data = await storage.fetch_remote(art.url)
            if data is None:
                continue
            saved = storage.save_bytes(data, mime=art.mime)
            mime = art.mime if art.mime.startswith("image/") else "image/png"
            artifacts.append({
                "id": f"art_{saved['sha256'][:12]}",
                "kind": "image", "url": saved["url"], "mime": mime,
                "width": art.width, "height": art.height,
                "digest": saved["sha256"], "size_bytes": saved["size_bytes"],
                "meta": {**art.meta, **result.meta, "node_id": req.node_id},
            })

        return {
            "ok": True,
            "artifacts": artifacts,
            "meta": {
                **result.meta,
                "cost_cny": float(result.cost_cny),
                "retries": result.retries,
                "latency_ms": int((time.perf_counter() - started) * 1000),
                "attempts": attempts,
            },
        }

    @app.post("/api/v1/images/generate")
    async def generate_image(req: GenerateImageRequest) -> dict:
        return await _generate(req)

    @app.post("/api/v1/images:generate")
    async def generate_image_alias(req: GenerateImageRequest) -> dict:
        return await _generate(req)

    # ── 视频生成（异步 i2v/t2v：网关内部完成 submit → 轮询 → 取片段 → 落盘）──
    @app.post("/api/v1/videos/generate")
    async def generate_video(req: GenerateVideoRequest) -> dict:
        started = time.perf_counter()
        greq = GenerationRequest(
            prompt=req.prompt,
            negative_prompt=req.negative_prompt,
            refs=[req.first_frame_url] if req.first_frame_url else [],
            params={"durationS": req.duration_s, "resolution": req.resolution, "tier": req.tier,
                    **({"seed": req.seed} if req.seed is not None else {})},
            idempotency_key=f"{req.run_id or '-'}:{req.node_id or '-'}:vid:{req.duration_s}",
            timeout_s=settings.request_timeout_s,
        )
        budget = Decimal(str(req.budget_cny)) if req.budget_cny is not None else None
        attempts: list[dict] = []
        try:
            result, attempts = await gateway.generate(Capability.VIDEO, greq, tier=req.tier,
                                                      model=req.model, budget=budget, node_id=req.node_id)
        except MvaError as e:
            raise HTTPException(status_code=e.http_status,
                                detail={"error": e.to_dict(), "attempts": attempts}) from e

        artifacts = []
        for art in result.artifacts:
            data = art.data
            if data is None and art.url:
                data = await storage.fetch_remote(art.url)
            if data is None:
                continue
            saved = storage.save_bytes(data, mime=art.mime or sniff_mime(data), subdir="videos")
            w, h, dur_ms = probe_video(data)
            artifacts.append({
                "id": f"art_{saved['sha256'][:12]}", "kind": "video", "url": saved["url"],
                "mime": "video/mp4", "width": w, "height": h,
                "durationMs": dur_ms or int(req.duration_s * 1000),
                "digest": saved["sha256"], "size_bytes": saved["size_bytes"],
                "meta": {**art.meta, **result.meta, "node_id": req.node_id, "real": True},
            })

        if not artifacts:
            raise HTTPException(status_code=502, detail={"error": {"class": "transient",
                                                                   "message": "厂商未返回可用的视频片段"}})
        return {"ok": True, "artifacts": artifacts,
                "meta": {**result.meta, "cost_cny": float(result.cost_cny), "retries": result.retries,
                         "latency_ms": int((time.perf_counter() - started) * 1000), "attempts": attempts}}

    # ── 语音合成（配音）：支持单段与按分镜批量（批量用于音画对齐）──
    async def _tts_one(text: str, req: GenerateTTSRequest, idx: int | None, voice: str) -> dict:
        greq = GenerationRequest(
            prompt=text,
            params={"text": text, "voice": voice},
            idempotency_key=f"{req.run_id or '-'}:{req.node_id or '-'}:tts:{idx if idx is not None else 0}:{len(text)}",
            timeout_s=settings.request_timeout_s,
        )
        result, attempts = await gateway.generate(Capability.TTS, greq, model=req.model, node_id=req.node_id)
        out = []
        for art in result.artifacts:
            data = art.data
            if data is None and art.url:
                data = await storage.fetch_remote(art.url)
            if data is None:
                continue
            saved = storage.save_bytes(data, mime=art.mime or sniff_mime(data), subdir="audio")
            dur_ms = probe_media_duration(settings.data_dir / saved["key"])
            out.append({
                "id": f"art_{saved['sha256'][:12]}", "kind": "audio", "url": saved["url"],
                "mime": art.mime or "audio/wav", "durationMs": dur_ms,
                "digest": saved["sha256"], "size_bytes": saved["size_bytes"],
                "meta": {**art.meta, **result.meta, "node_id": req.node_id,
                         "shot_no": idx, "text": text, "voice": voice},
            })
        return {"artifacts": out, "cost": result.cost_cny, "attempts": attempts,
                "meta": {"adapter": result.meta.get("adapter"), "model": result.meta.get("model")}}

    @app.post("/api/v1/tts/generate")
    async def generate_tts(req: GenerateTTSRequest) -> dict:
        started = time.perf_counter()
        voice = req.voice or settings.tts_voice
        if not req.text and not req.segments:
            raise HTTPException(status_code=400, detail={"error": {"class": "invalid_request",
                                                                   "message": "text 与 segments 至少提供一个"}})
        artifacts: list[dict] = []
        total_cost = Decimal("0")
        attempts_log: list[dict] = []
        adapter_name = None
        model_name = None
        try:
            if req.segments:
                for seg in req.segments:
                    r = await _tts_one(seg.text, req, seg.shot_no, voice)
                    artifacts.extend(r["artifacts"])
                    total_cost += r["cost"]
                    attempts_log.extend(r["attempts"])
                    adapter_name, model_name = r["meta"]["adapter"], r["meta"]["model"]
            else:
                r = await _tts_one(req.text or "", req, None, voice)
                artifacts, total_cost, attempts_log = r["artifacts"], r["cost"], r["attempts"]
                adapter_name, model_name = r["meta"]["adapter"], r["meta"]["model"]
        except MvaError as e:
            raise HTTPException(status_code=e.http_status,
                                detail={"error": e.to_dict(), "attempts": attempts_log}) from e

        if not artifacts:
            raise HTTPException(status_code=502, detail={"error": {"class": "transient",
                                                                   "message": "TTS 未返回可用音频"}})
        return {"ok": True, "artifacts": artifacts,
                "meta": {"adapter": adapter_name, "model": model_name, "voice": voice,
                         "cost_cny": float(total_cost),
                         "latency_ms": int((time.perf_counter() - started) * 1000),
                         "segments": len(artifacts), "attempts": attempts_log}}

    @app.get("/api/v1/costs/summary")
    async def costs_summary():
        return {"summary": ledger.summary(), "recent": [
            {"ts": e.ts, "adapter": e.adapter, "model": e.model, "node_id": e.node_id,
             "cost_cny": e.cost_cny, "latency_ms": e.latency_ms, "ok": e.ok, "attempt": e.attempt,
             "error": e.error} for e in ledger.recent(30)
        ]}

    @app.get("/assets/{path:path}")
    async def assets(path: str):
        target = (settings.data_dir / path).resolve()
        if not str(target).startswith(str(settings.data_dir)) or not target.is_file():
            raise HTTPException(status_code=404, detail="not found")
        mime = {".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
                ".mp4": "video/mp4", ".wav": "audio/wav"}.get(target.suffix, "application/octet-stream")
        return FileResponse(target, media_type=mime)

    if settings.enable_mock_provider:
        app.include_router(mock_provider_router)

    # 启动即打印装配结果与配置告警（配错了要马上看得见）
    import logging

    log = logging.getLogger("uvicorn.error")
    log.info("MVA 网关 v%s 装配完成：image=%s llm=%s video=%s",
             VERSION, settings.image_provider, settings.llm_provider, settings.video_provider)
    caps_txt = ", ".join(f"{a.spec.capability.value}:{a.spec.adapter}({a.spec.model})" for a in registry.all())
    log.info("  已注册适配器：%s", caps_txt)
    for w in registry.warnings:
        log.warning("  ⚠ %s", w)

    return app


app = create_app()
