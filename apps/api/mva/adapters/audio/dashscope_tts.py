"""DashScope 原生 TTS 适配器（qwen3-tts-flash 等）。

实测形状（本机端点验证通过）：
    POST {base}/services/aigc/multimodal-generation/generation
      body: {"model": "qwen3-tts-flash", "input": {"text": "…", "voice": "Cherry"}}
      resp: {"output": {"audio": {"url": "https://…wav", "expires_at": …}}}
    → 再 GET 该 url 拿到音频字节（URL 有有效期，必须立刻转存）

注意：该端点的 OpenAI 兼容 /audio/speech 返回 404，所以不能复用图像那套形状。
"""
from __future__ import annotations

import time
from decimal import Decimal

import httpx

from ...config import settings
from ..base import (BaseAdapter, Capability, GeneratedImage, GenerationRequest,
                    GenerationResult, ModelSpec, TaskHandle, TaskStatus)
from ..errors import ErrorClass, MvaError, classify_http


def _resolve_base() -> str:
    return (settings.tts_base_url or settings.video_base_url).rstrip("/")


def _resolve_key() -> str:
    return settings.tts_api_key or settings.video_api_key


class DashScopeTTSAdapter(BaseAdapter):
    def __init__(self, spec: ModelSpec, base_url: str, api_key: str):
        self.spec = spec
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self._client = httpx.AsyncClient(timeout=settings.request_timeout_s)

    async def probe(self) -> bool:
        return bool(self.base_url and self.api_key)

    async def submit(self, req: GenerationRequest) -> TaskHandle:
        text = (req.params.get("text") or req.prompt or "").strip()
        if not text:
            raise MvaError(ErrorClass.INVALID_REQUEST, "TTS 文本为空", http_status=400)
        requested_voice = str(req.params.get("voice") or settings.tts_voice)
        last_err: MvaError | None = None

        # 音色写错（不在厂商许可列表里）是常见问题：自动回退到默认音色重试一次，别让整条配音挂掉
        for voice in dict.fromkeys([requested_voice, settings.tts_voice, "Cherry"]):
            body = {"model": self.spec.model, "input": {"text": text[: self.spec.max_prompt_chars], "voice": voice}}
            try:
                r = await self._client.post(
                    f"{self.base_url}/services/aigc/multimodal-generation/generation",
                    json=body,
                    headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                    timeout=req.timeout_s,
                )
            except httpx.TimeoutException as e:
                raise MvaError(ErrorClass.TRANSIENT, f"TTS 请求超时：{e}", http_status=504) from e
            except httpx.HTTPError as e:
                raise MvaError(ErrorClass.TRANSIENT, f"TTS 网络异常：{e}", http_status=502) from e

            if r.status_code >= 400:
                err = classify_http(r.status_code, r.text)
                if "voice" in r.text.lower() and err.cls is ErrorClass.INVALID_REQUEST:
                    last_err = MvaError(ErrorClass.INVALID_REQUEST,
                                        f"音色 {voice!r} 不被厂商许可（已尝试回退）", http_status=400)
                    continue
                raise err

            payload = r.json()
            audio = ((payload.get("output") or {}).get("audio") or {})
            audio_url = audio.get("url")
            if not audio_url:
                raise MvaError(ErrorClass.TRANSIENT, "TTS 未返回音频地址", http_status=502,
                               detail={"keys": list((payload.get("output") or {}).keys())[:8],
                                       "code": payload.get("code")})
            return TaskHandle(adapter=self.spec.adapter,
                              external_task_id=audio.get("id") or f"tts_{time.time_ns()}",
                              payload={"url": audio_url, "text": text, "voice": voice})

        raise last_err or MvaError(ErrorClass.FATAL, "TTS 未能完成", http_status=500)

    async def poll(self, handle: TaskHandle) -> TaskStatus:
        return TaskStatus(state="succeeded", progress=1.0)  # 该形状为同步返回

    async def fetch(self, handle: TaskHandle) -> GenerationResult:
        started = time.perf_counter()
        url = (handle.payload or {}).get("url")
        text = (handle.payload or {}).get("text", "")
        try:
            r = await self._client.get(url, timeout=120)
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise MvaError(ErrorClass.TRANSIENT, f"音频下载失败（URL 可能已过期）：{e}", http_status=502) from e
        mime = r.headers.get("content-type", "audio/wav").split(";")[0]
        if mime in ("application/octet-stream", ""):
            mime = "audio/wav" if url.endswith(".wav") else "audio/mpeg"
        return GenerationResult(
            artifacts=[GeneratedImage(data=r.content, mime=mime, meta={"provider": self.spec.adapter,
                                                                       "chars": len(text)})],
            meta={"adapter": self.spec.adapter, "model": self.spec.model, "chars": len(text),
                  "ai_generated": True, "voice": str(settings.tts_voice)},
            cost_cny=self.spec.price * Decimal(len(text)) / 1000,
            latency_ms=int((time.perf_counter() - started) * 1000),
        )

    def estimate_cost(self, req: GenerationRequest) -> Decimal:
        text = str(req.params.get("text") or req.prompt or "")
        return self.spec.price * Decimal(len(text)) / 1000

    def normalize_error(self, exc: Exception) -> MvaError:
        if isinstance(exc, MvaError):
            return exc
        if isinstance(exc, httpx.TimeoutException):
            return MvaError(ErrorClass.TRANSIENT, f"TTS 超时：{exc}", http_status=504)
        if isinstance(exc, httpx.HTTPError):
            return MvaError(ErrorClass.TRANSIENT, f"TTS 网络异常：{exc}", http_status=502)
        return MvaError(ErrorClass.FATAL, f"TTS 未分类异常：{exc}", http_status=500)

    def error_map(self) -> dict:
        return {
            "429": (ErrorClass.RATE_LIMITED.value, "厂商限流"),
            "401/403": (ErrorClass.FATAL.value, "鉴权失败"),
            "400(敏感/审核)": (ErrorClass.CONTENT_BLOCKED.value, "文本审核拒绝"),
            "5xx": (ErrorClass.TRANSIENT.value, "服务异常"),
        }


def build(base_url: str | None = None, api_key: str | None = None) -> DashScopeTTSAdapter:
    spec = ModelSpec(
        adapter="dashscope-tts", model=settings.tts_model, capability=Capability.TTS,
        price=Decimal(str(settings.price_tts_1k_chars)), price_unit="per_1k_chars",
        max_prompt_chars=2000, ratios=(), resolutions=(), concurrency=4, rpm=60,
        region="cn", quality_tier="A", note=f"DashScope 语音合成（{settings.tts_model}）",
    )
    return DashScopeTTSAdapter(spec, base_url or _resolve_base(), api_key or _resolve_key())
