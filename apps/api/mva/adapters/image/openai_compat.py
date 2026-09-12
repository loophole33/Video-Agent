"""OpenAI 兼容图像适配器 —— 一个实现覆盖多家厂商（不写死任何一家）。

多数国内外厂商都提供 OpenAI 形状的 `POST {base_url}/images/generations`：
  · OpenAI           https://api.openai.com/v1            model=gpt-image-1
  · 通义万相（兼容）  https://dashscope.aliyuncs.com/compatible-mode/v1
  · 火山方舟/豆包     https://ark.cn-beijing.volces.com/api/v3
  · 硅基流动/智谱等   各自 base_url
换厂商 = 改 .env 里的三个变量，代码零改动。
"""
from __future__ import annotations

import base64
import time
from decimal import Decimal

import httpx

from ...config import settings
from ...imaging import probe_image_size, sniff_mime
from ..errors import ErrorClass, MvaError, classify_http
from ..base import (BaseAdapter, Capability, GeneratedImage, GenerationRequest,
                    GenerationResult, ModelSpec, TaskHandle, TaskStatus)

# 常见厂商接受的尺寸集合（按需在 ModelSpec.resolutions 里覆盖）
def nearest_size(resolution: str, supported: tuple[str, ...]) -> str:
    try:
        w, h = (int(x) for x in resolution.split("x"))
    except Exception:  # noqa: BLE001
        return supported[0]
    want = w / h

    def score(s: str) -> tuple[float, int]:
        sw, sh = (int(x) for x in s.split("x"))
        return (abs(sw / sh - want), abs(sw - w))

    return sorted(supported, key=score)[0]


class OpenAICompatImageAdapter(BaseAdapter):
    def __init__(self, spec: ModelSpec, base_url: str, api_key: str):
        self.spec = spec
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self._client = httpx.AsyncClient(timeout=settings.request_timeout_s)

    # ── 接口实现 ──
    async def submit(self, req: GenerationRequest) -> TaskHandle:
        payload: dict = {
            "model": self.spec.model,
            "prompt": req.prompt[: self.spec.max_prompt_chars],
            "n": int(req.params.get("count", 1)),
            "size": nearest_size(str(req.params.get("resolution", "1080x1920")), self.spec.resolutions),
            "response_format": "b64_json",
        }
        if self.spec.supports_negative_prompt and req.negative_prompt:
            payload["negative_prompt"] = req.negative_prompt[:400]
        try:
            r = await self._client.post(
                f"{self.base_url}/images/generations",
                json=payload,
                headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                timeout=req.timeout_s,
            )
        except httpx.TimeoutException as e:
            raise MvaError(ErrorClass.TRANSIENT, f"请求超时：{e}", http_status=504) from e
        except httpx.HTTPError as e:
            raise MvaError(ErrorClass.TRANSIENT, f"网络异常：{e}", http_status=502) from e

        if r.status_code >= 400:
            raise classify_http(r.status_code, r.text)
        return TaskHandle(adapter=self.spec.adapter, external_task_id=f"oa_{time.time_ns()}", payload=r.json())

    async def poll(self, handle: TaskHandle) -> TaskStatus:
        return TaskStatus(state="succeeded", progress=1.0)  # 该形状为同步返回

    async def fetch(self, handle: TaskHandle) -> GenerationResult:
        started = time.perf_counter()
        body = handle.payload or {}
        items = body.get("data") or []
        if not items:
            raise MvaError(ErrorClass.TRANSIENT, "厂商返回体缺少 data 字段", http_status=502,
                           detail={"keys": list(body.keys())[:8]})
        arts: list[GeneratedImage] = []
        for it in items:
            if it.get("b64_json"):
                data = base64.b64decode(it["b64_json"])
                w, h = probe_image_size(data)
                arts.append(GeneratedImage(data=data, mime=sniff_mime(data), width=w, height=h,
                                           meta={"revised_prompt": it.get("revised_prompt")}))
            elif it.get("url"):
                rr = await self._client.get(it["url"])
                if rr.status_code >= 400:
                    raise classify_http(rr.status_code, rr.text)
                w, h = probe_image_size(rr.content)
                arts.append(GeneratedImage(data=rr.content, mime=sniff_mime(rr.content),
                                           width=w, height=h, meta={"source_url": it["url"]}))
            else:
                raise MvaError(ErrorClass.TRANSIENT, "厂商返回体既无 b64_json 也无 url", http_status=502)
        return GenerationResult(
            artifacts=arts,
            meta={"adapter": self.spec.adapter, "model": self.spec.model, "ai_generated": True,
                  "provider_host": self.base_url.split("//")[-1].split("/")[0]},
            cost_cny=self.estimate_cost(GenerationRequest(prompt="", params={"count": len(arts)})),
            latency_ms=int((time.perf_counter() - started) * 1000),
            raw={"usage": body.get("usage")},
        )

    def estimate_cost(self, req: GenerationRequest) -> Decimal:
        return self.spec.price * Decimal(int(req.params.get("count", 1)))

    def normalize_error(self, exc: Exception) -> MvaError:
        if isinstance(exc, MvaError):
            return exc
        if isinstance(exc, httpx.TimeoutException):
            return MvaError(ErrorClass.TRANSIENT, f"超时：{exc}", http_status=504)
        if isinstance(exc, httpx.HTTPError):
            return MvaError(ErrorClass.TRANSIENT, f"网络异常：{exc}", http_status=502)
        if isinstance(exc, (KeyError, ValueError, TypeError)):
            return MvaError(ErrorClass.INVALID_REQUEST, f"参数/解析错误：{exc}", http_status=400)
        return MvaError(ErrorClass.FATAL, f"未分类异常：{exc}", http_status=500)

    async def probe(self) -> bool:
        return bool(self.base_url and self.api_key)

    def error_map(self) -> dict:
        return {
            "429": (ErrorClass.RATE_LIMITED.value, "厂商限流"),
            "401/403": (ErrorClass.FATAL.value, "鉴权失败"),
            "402": (ErrorClass.QUOTA_EXCEEDED.value, "余额不足"),
            "400(policy)": (ErrorClass.CONTENT_BLOCKED.value, "内容审核拒绝"),
            "400": (ErrorClass.INVALID_REQUEST.value, "参数错误"),
            "5xx": (ErrorClass.TRANSIENT.value, "服务异常"),
        }
