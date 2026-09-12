"""本地 Stable Diffusion 适配器（AUTOMATIC1111 / SD.Next 兼容 API）—— 零 Key、零 API 成本。

只要有本地 SD WebUI 在跑（默认 127.0.0.1:7860），这条路径就自动可用：
不联网、不付费，但需要 GPU（或慢速 CPU）与一个已下载的模型。
用 probe() 探测可用性，探测失败就自动从选型候选中剔除。
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

# SD 系列对尺寸敏感：必须 64 的倍数，且别超出训练分辨率太多
SD_SIZES = {
    "9:16": "768x1344",
    "16:9": "1344x768",
    "1:1": "1024x1024",
}


def sd_size(ratio: str) -> str:
    return SD_SIZES.get(ratio, "768x1344")


class SDWebUIImageAdapter(BaseAdapter):
    def __init__(self, spec: ModelSpec, base_url: str):
        self.spec = spec
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(timeout=settings.request_timeout_s)

    async def probe(self) -> bool:
        try:
            r = await self._client.get(f"{self.base_url}/sdapi/v1/options", timeout=2.5)
            return r.status_code < 400
        except Exception:  # noqa: BLE001
            return False

    async def submit(self, req: GenerationRequest) -> TaskHandle:
        ratio = str(req.params.get("ratio", "9:16"))
        payload = {
            "prompt": req.prompt[: self.spec.max_prompt_chars],
            "negative_prompt": req.negative_prompt or "",
            "width": int(sd_size(ratio).split("x")[0]),
            "height": int(sd_size(ratio).split("x")[1]),
            "steps": int(req.params.get("steps", 24)),
            "cfg_scale": float(req.params.get("cfg", 6.0)),
            "seed": int(req.params.get("seed") or -1),
            "batch_size": int(req.params.get("count", 1)),
            "sampler_name": str(req.params.get("sampler", "DPM++ 2M Karras")),
        }
        try:
            r = await self._client.post(f"{self.base_url}/sdapi/v1/txt2img", json=payload, timeout=req.timeout_s)
        except httpx.TimeoutException as e:
            raise MvaError(ErrorClass.TRANSIENT, f"本地 SD 超时（可能显存不足）：{e}", http_status=504) from e
        except httpx.HTTPError as e:
            raise MvaError(ErrorClass.TRANSIENT, f"本地 SD 连接失败：{e}", http_status=502) from e
        if r.status_code >= 400:
            raise classify_http(r.status_code, r.text)
        return TaskHandle(adapter=self.spec.adapter, external_task_id=f"sd_{time.time_ns()}", payload=r.json())

    async def poll(self, handle: TaskHandle) -> TaskStatus:
        return TaskStatus(state="succeeded", progress=1.0)

    async def fetch(self, handle: TaskHandle) -> GenerationResult:
        started = time.perf_counter()
        images = (handle.payload or {}).get("images") or []
        if not images:
            raise MvaError(ErrorClass.TRANSIENT, "SD WebUI 未返回图像", http_status=502)
        arts = []
        for b in images:
            data = base64.b64decode(b.split(",", 1)[-1])
            w, h = probe_image_size(data)
            arts.append(GeneratedImage(data=data, mime=sniff_mime(data), width=w, height=h,
                                       meta={"provider": "sd-webui"}))
        return GenerationResult(
            artifacts=arts,
            meta={"adapter": self.spec.adapter, "model": self.spec.model, "ai_generated": True,
                  "local": True},
            cost_cny=self.estimate_cost(GenerationRequest(prompt="", params={"count": len(arts)})),
            latency_ms=int((time.perf_counter() - started) * 1000),
        )

    def estimate_cost(self, req: GenerationRequest) -> Decimal:
        return self.spec.price * Decimal(int(req.params.get("count", 1)))

    def normalize_error(self, exc: Exception) -> MvaError:
        if isinstance(exc, MvaError):
            return exc
        if isinstance(exc, httpx.TimeoutException):
            return MvaError(ErrorClass.TRANSIENT, f"本地 SD 超时：{exc}", http_status=504)
        if isinstance(exc, httpx.HTTPError):
            return MvaError(ErrorClass.TRANSIENT, f"本地 SD 网络异常：{exc}", http_status=502)
        return MvaError(ErrorClass.FATAL, f"本地 SD 未分类异常：{exc}", http_status=500)
