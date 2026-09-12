"""阿里云 DashScope 视频生成适配器（wan2.x i2v / t2v）—— **异步任务**的完整形状。

真实厂商的视频生成几乎都是异步的：
    submit  → POST /services/aigc/video-generation/video-synthesis  (X-DashScope-Async: enable) → task_id
    poll    → GET  /tasks/{task_id} → PENDING / RUNNING / SUCCEEDED / FAILED
    fetch   → 从 SUCCEEDED 的 output.video_url 下载片段字节（随后由网关落盘成我们的产物 URL）

首帧可达性（i2v 的真实约束）：厂商需要能访问到参考图。
    · 本地产物（/assets/...）→ 转成 base64 data URI 由厂商接收（DashScope 支持）
    · 若配置了 MVA_VIDEO_PUBLIC_ASSET_BASE（你把产物放到了 CDN/公网）→ 改写成公网 URL 优先使用
"""
from __future__ import annotations

import base64
import re
import time
from decimal import Decimal

import httpx

from ...config import settings
from ...imaging import sniff_mime
from ..base import (BaseAdapter, Capability, GeneratedImage, GenerationRequest,
                    GenerationResult, ModelSpec, TaskHandle, TaskStatus)
from ..errors import ErrorClass, MvaError, classify_http

STATUS_MAP = {
    "PENDING": "queued",
    "RUNNING": "running",
    "SUCCEEDED": "succeeded",
    "SUCCESS": "succeeded",
    "FAILED": "failed",
    "CANCELED": "failed",
    "UNKNOWN": "running",
}


# wan 系列 i2v 只接受这几个时长；请求 4s 之类的值会被厂商拒绝，所以在这里向上取整到合法档位
ALLOWED_DURATIONS = (5, 10)


def clamp_duration(seconds: float) -> int:
    for d in ALLOWED_DURATIONS:
        if seconds <= d:
            return d
    return ALLOWED_DURATIONS[-1]


def to_vendor_ref(url: str) -> str:
    if not url:
        return url
    if url.startswith("data:"):
        return url
    if settings.video_public_asset_base and url.startswith("/assets/"):
        return settings.video_public_asset_base.rstrip("/") + url
    if url.startswith("http"):
        return url
    m = re.match(r"^/assets/(.+)$", url)
    if m:
        path = settings.data_dir / m.group(1)
        if path.is_file():
            data = path.read_bytes()
            mime = sniff_mime(data)
            return f"data:{mime};base64,{base64.b64encode(data).decode()}"
    return url


class DashScopeVideoAdapter(BaseAdapter):
    def __init__(self, spec: ModelSpec, base_url: str, api_key: str):
        self.spec = spec
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self._client = httpx.AsyncClient(timeout=settings.request_timeout_s)

    async def probe(self) -> bool:
        return bool(self.base_url and self.api_key)

    # ── ① 提交 ──
    async def submit(self, req: GenerationRequest) -> TaskHandle:
        first = to_vendor_ref(req.refs[0]) if req.refs else None
        duration = clamp_duration(float(req.params.get("durationS", 5)))
        payload = {
            "model": self.spec.model,
            "input": {
                "prompt": req.prompt[: self.spec.max_prompt_chars],
                **({"img_url": first} if first else {}),
                **({"negative_prompt": req.negative_prompt} if req.negative_prompt else {}),
            },
            "parameters": {
                "resolution": str(req.params.get("resolution", settings.video_resolution)),
                "duration": duration,
                "prompt_extend": bool(req.params.get("prompt_extend", True)),
                **({"seed": int(req.params["seed"])} if req.params.get("seed") is not None else {}),
            },
        }
        try:
            r = await self._client.post(
                f"{self.base_url}/services/aigc/video-generation/video-synthesis",
                json=payload,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                    "X-DashScope-Async": "enable",
                },
                timeout=req.timeout_s,
            )
        except httpx.TimeoutException as e:
            raise MvaError(ErrorClass.TRANSIENT, f"视频提交超时：{e}", http_status=504) from e
        except httpx.HTTPError as e:
            raise MvaError(ErrorClass.TRANSIENT, f"视频提交网络异常：{e}", http_status=502) from e
        if r.status_code >= 400:
            raise classify_http(r.status_code, r.text)

        body = r.json()
        out = body.get("output") or {}
        task_id = out.get("task_id")
        if not task_id:
            raise MvaError(ErrorClass.TRANSIENT, "厂商未返回 task_id", http_status=502,
                           detail={"keys": list(out.keys())[:8], "code": body.get("code")})
        return TaskHandle(adapter=self.spec.adapter, external_task_id=task_id,
                          payload={"submit": body, "request": payload,
                                   "deadline": time.time() + settings.video_timeout_s,
                                   "polls": 0})

    # ── ② 轮询 ──
    async def poll(self, handle: TaskHandle) -> TaskStatus:
        state = handle.payload
        state["polls"] = state.get("polls", 0) + 1
        if time.time() > state.get("deadline", 0):
            return TaskStatus(state="failed",
                              error=MvaError(ErrorClass.TRANSIENT, "视频生成超时（未在期限内完成）", http_status=504))
        try:
            r = await self._client.get(
                f"{self.base_url}/tasks/{handle.external_task_id}",
                headers={"Authorization": f"Bearer {self.api_key}"},
                timeout=60,
            )
        except httpx.HTTPError as e:
            raise MvaError(ErrorClass.TRANSIENT, f"视频轮询网络异常：{e}", http_status=502) from e
        if r.status_code >= 400:
            raise classify_http(r.status_code, r.text)

        body = r.json()
        state["last_poll"] = body
        out = body.get("output") or {}
        raw_status = str(out.get("task_status", "UNKNOWN")).upper()
        mapped = STATUS_MAP.get(raw_status, "running")
        if mapped == "failed":
            msg = out.get("message") or body.get("message") or "厂商任务失败"
            code = str(out.get("code") or body.get("code") or "")
            cls = ErrorClass.CONTENT_BLOCKED if any(k in msg for k in ("审核", "违规", "policy", "sensitive")) \
                else ErrorClass.TRANSIENT
            return TaskStatus(state="failed", error=MvaError(cls, f"[{code}] {msg}", http_status=502))
        if mapped == "succeeded":
            return TaskStatus(state="succeeded", progress=1.0)
        return TaskStatus(state="running", progress=min(0.9, 0.1 + 0.1 * state["polls"]))

    # ── ③ 取结果 ──
    async def fetch(self, handle: TaskHandle) -> GenerationResult:
        started = time.perf_counter()
        out = ((handle.payload or {}).get("last_poll") or {}).get("output") or {}
        video_url = out.get("video_url") or (out.get("results") or {}).get("video_url")
        if not video_url:
            raise MvaError(ErrorClass.TRANSIENT, "厂商任务成功但未返回 video_url", http_status=502,
                           detail={"keys": list(out.keys())[:8]})
        try:
            r = await self._client.get(video_url, timeout=settings.request_timeout_s)
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise MvaError(ErrorClass.TRANSIENT, f"片段下载失败：{e}", http_status=502) from e
        duration = float(clamp_duration(float(((handle.payload or {}).get("request") or {})
                                             .get("parameters", {}).get("duration", 5))))
        return GenerationResult(
            artifacts=[GeneratedImage(data=r.content, mime="video/mp4",
                                      meta={"source_url": video_url, "provider": self.spec.adapter})],
            meta={"adapter": self.spec.adapter, "model": self.spec.model, "ai_generated": True,
                  "duration_s": duration, "polls": (handle.payload or {}).get("polls", 0)},
            cost_cny=self.spec.price * Decimal(str(duration)),
            latency_ms=int((time.perf_counter() - started) * 1000),
            raw=handle.payload.get("last_poll"),
        )

    def estimate_cost(self, req: GenerationRequest) -> Decimal:
        return self.spec.price * Decimal(clamp_duration(float(req.params.get("durationS", 5))))

    def normalize_error(self, exc: Exception) -> MvaError:
        if isinstance(exc, MvaError):
            return exc
        if isinstance(exc, httpx.TimeoutException):
            return MvaError(ErrorClass.TRANSIENT, f"视频请求超时：{exc}", http_status=504)
        if isinstance(exc, httpx.HTTPError):
            return MvaError(ErrorClass.TRANSIENT, f"视频网络异常：{exc}", http_status=502)
        return MvaError(ErrorClass.FATAL, f"视频未分类异常：{exc}", http_status=500)

    def error_map(self) -> dict:
        return {
            "task_status=FAILED": (ErrorClass.TRANSIENT.value, "生成失败（可重试/换适配器）"),
            "FAILED+审核关键词": (ErrorClass.CONTENT_BLOCKED.value, "内容审核拒绝"),
            "429": (ErrorClass.RATE_LIMITED.value, "厂商限流"),
            "401/403": (ErrorClass.FATAL.value, "鉴权失败"),
            "超时": (ErrorClass.TRANSIENT.value, "未在期限内完成"),
        }
