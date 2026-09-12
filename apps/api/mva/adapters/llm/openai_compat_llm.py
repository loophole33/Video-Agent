"""OpenAI 兼容 LLM 适配器（chat completions）—— 一个实现覆盖 qwen / deepseek / gpt / 豆包 等。

关键点：
  · 支持 json_mode（response_format={"type":"json_object"}）；**厂商不支持时自动去掉重试一次**
  · 记账按 token（¥/1k in + ¥/1k out），不是按次
  · 文本结果放在 GenerationResult.text，由 Skill 层做 Schema 校验与修复重试
"""
from __future__ import annotations

import time
from decimal import Decimal

import httpx

from ...config import settings
from ..base import (BaseAdapter, Capability, GenerationRequest, GenerationResult,
                    ModelSpec, TaskHandle, TaskStatus)
from ..errors import ErrorClass, MvaError, classify_http


class OpenAICompatLLMAdapter(BaseAdapter):
    def __init__(self, spec: ModelSpec, base_url: str, api_key: str, temperature: float = 0.7):
        self.spec = spec
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.temperature = temperature
        self._client = httpx.AsyncClient(timeout=settings.request_timeout_s)

    async def probe(self) -> bool:
        return bool(self.base_url and self.api_key)

    async def submit(self, req: GenerationRequest) -> TaskHandle:
        messages: list[dict] = []
        if req.params.get("system"):
            messages.append({"role": "system", "content": str(req.params["system"])})
        messages.append({"role": "user", "content": req.prompt})
        payload: dict = {
            "model": self.spec.model,
            "messages": messages,
            "temperature": float(req.params.get("temperature", self.temperature)),
            "max_tokens": int(req.params.get("max_tokens", 1600)),
        }
        if req.params.get("json_mode", True):
            payload["response_format"] = {"type": "json_object"}

        for attempt in (1, 2, 3):
            try:
                r = await self._client.post(
                    f"{self.base_url}/chat/completions",
                    json=payload,
                    headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                    timeout=req.timeout_s,
                )
            except httpx.TimeoutException as e:
                raise MvaError(ErrorClass.TRANSIENT, f"LLM 请求超时：{e}", http_status=504) from e
            except httpx.HTTPError as e:
                raise MvaError(ErrorClass.TRANSIENT, f"LLM 网络异常：{e}", http_status=502) from e

            if r.status_code >= 400:
                # 有些厂商不支持 response_format，去掉它重试一次
                if attempt == 1 and payload.get("response_format") and r.status_code == 400:
                    payload.pop("response_format", None)
                    continue
                raise classify_http(r.status_code, r.text)

            body = r.json()
            choice = (body.get("choices") or [{}])[0]
            content = ((choice.get("message") or {}).get("content") or "").strip()
            finish = choice.get("finish_reason")
            usage = body.get("usage") or {}
            reasoning = int((usage.get("completion_tokens_details") or {}).get("reasoning_tokens", 0))

            # 推理模型常见坑：token 全花在 reasoning 上，content 为空（finish_reason=length）
            if not content and attempt < 3 and (finish == "length" or reasoning > 0):
                doubled = min(int(payload["max_tokens"]) * 2, 8192)
                if doubled > int(payload["max_tokens"]):
                    payload["max_tokens"] = doubled
                    continue
            if not content:
                hint = (
                    "（completion_tokens 全部用于 reasoning，content 为空）—— "
                    "请提高 MVA_*_TIMEOUT/技能 max_tokens，或改用非推理模型（如 qwen3.8-flash / qwen-plus）"
                    if reasoning > 0 else "（模型返回空内容）"
                )
                raise MvaError(ErrorClass.INVALID_REQUEST, f"模型没有输出正文 {hint}", http_status=422,
                               detail={"finish_reason": finish, "reasoning_tokens": reasoning,
                                       "usage": usage})
            return TaskHandle(adapter=self.spec.adapter, external_task_id=f"llm_{time.time_ns()}",
                              payload={"body": body, "request": payload})
        raise MvaError(ErrorClass.FATAL, "LLM 请求未能完成", http_status=500)

    async def poll(self, handle: TaskHandle) -> TaskStatus:
        return TaskStatus(state="succeeded", progress=1.0)

    async def fetch(self, handle: TaskHandle) -> GenerationResult:
        started = time.perf_counter()
        body = (handle.payload or {}).get("body") or {}
        choices = body.get("choices") or []
        if not choices:
            raise MvaError(ErrorClass.TRANSIENT, "LLM 返回体缺少 choices", http_status=502,
                           detail={"keys": list(body.keys())[:8]})
        text = (choices[0].get("message") or {}).get("content") or ""
        usage = body.get("usage") or {}
        tin, tout = int(usage.get("prompt_tokens", 0)), int(usage.get("completion_tokens", 0))
        cost = (Decimal(tin) / 1000) * Decimal(str(settings.price_llm_in_1k)) + \
               (Decimal(tout) / 1000) * Decimal(str(settings.price_llm_out_1k))
        return GenerationResult(
            artifacts=[],
            text=text,
            tokens={"in": tin, "out": tout},
            meta={
                "adapter": self.spec.adapter, "model": self.spec.model,
                "finish_reason": choices[0].get("finish_reason"),
                "json_mode": "response_format" in ((handle.payload or {}).get("request") or {}),
            },
            cost_cny=cost,
            latency_ms=int((time.perf_counter() - started) * 1000),
            raw=body,
        )

    def estimate_cost(self, req: GenerationRequest) -> Decimal:
        # 粗估：输入按字符数/1.6，输出按 max_tokens 的一半
        tin = int(len(req.prompt) / 1.6) + 200
        tout = int(req.params.get("max_tokens", 1600)) // 2
        return (Decimal(tin) / 1000) * Decimal(str(settings.price_llm_in_1k)) + \
               (Decimal(tout) / 1000) * Decimal(str(settings.price_llm_out_1k))

    def normalize_error(self, exc: Exception) -> MvaError:
        if isinstance(exc, MvaError):
            return exc
        if isinstance(exc, httpx.TimeoutException):
            return MvaError(ErrorClass.TRANSIENT, f"LLM 超时：{exc}", http_status=504)
        if isinstance(exc, httpx.HTTPError):
            return MvaError(ErrorClass.TRANSIENT, f"LLM 网络异常：{exc}", http_status=502)
        return MvaError(ErrorClass.FATAL, f"LLM 未分类异常：{exc}", http_status=500)

    def error_map(self) -> dict:
        return {
            "429": (ErrorClass.RATE_LIMITED.value, "厂商限流"),
            "401/403": (ErrorClass.FATAL.value, "鉴权失败"),
            "400(policy)": (ErrorClass.CONTENT_BLOCKED.value, "内容审核拒绝"),
            "400": (ErrorClass.INVALID_REQUEST.value, "参数错误（如不支持 response_format）"),
            "5xx": (ErrorClass.TRANSIENT.value, "服务异常"),
        }
