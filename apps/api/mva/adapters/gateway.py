"""网关：选型 → 限流 → 重试 → 熔断 → 降级链 → 成本记账。

上层（节点执行器/调度器）只见 `gateway.generate(capability, req)`，
不认识任何厂商；厂商差异全部被适配器吃掉（约束 1）。
"""
from __future__ import annotations

import asyncio
import random
import time
from collections import deque
from dataclasses import dataclass
from decimal import Decimal

from .base import (BaseAdapter, Capability, GenerationRequest, GenerationResult)
from .errors import MAX_ATTEMPTS, SWITCH_ADAPTER, ErrorClass, MvaError
from ..config import settings


@dataclass
class AdapterHealth:
    failures: deque = None  # type: ignore[assignment]
    circuit_open_until: float = 0.0
    consecutive: int = 0

    def __post_init__(self) -> None:
        if self.failures is None:
            self.failures = deque(maxlen=20)

    @property
    def open(self) -> bool:
        return time.time() < self.circuit_open_until


class ModelGateway:
    def __init__(self, registry, ledger=None) -> None:
        self.registry = registry
        self.ledger = ledger
        self.health: dict[str, AdapterHealth] = {}
        self._sems: dict[str, asyncio.Semaphore] = {}
        self._buckets: dict[str, list[float]] = {}

    # ── 选型 ──
    async def select(self, capability: Capability, *, tier: str | None = None, model: str | None = None,
                     budget: Decimal | None = None, exclude: set[str] | None = None) -> BaseAdapter:
        exclude = exclude or set()
        cands = [a for a in await self.registry.available(capability) if a.spec.adapter not in exclude]
        if model and model not in ("auto", ""):
            named = [a for a in cands if a.spec.model == model or a.spec.adapter == model]
            cands = named or cands
        if not cands:
            raise MvaError(ErrorClass.FATAL,
                           f"没有可用的 {capability.value} 适配器（检查配置与探测结果）", http_status=503)
        if tier:
            rank = {"A": 0, "B": 1, "C": 2}
            cands.sort(key=lambda a: (abs(rank.get(a.spec.quality_tier, 1) - rank.get(tier, 1)), a.spec.price))
        else:
            cands.sort(key=lambda a: a.spec.price)
        if budget is not None:
            affordable = [a for a in cands if a.spec.price <= budget]
            cands = affordable or cands[:1]
        return cands[0]

    def _sem(self, adapter: str, limit: int) -> asyncio.Semaphore:
        if adapter not in self._sems:
            self._sems[adapter] = asyncio.Semaphore(max(1, limit))
        return self._sems[adapter]

    async def _rate_limit(self, spec) -> None:
        """令牌桶（按 rpm）+ 并发信号量；超限时降速重排而不是失败。"""
        bucket = self._buckets.setdefault(spec.adapter, [])
        now = time.time()
        bucket[:] = [t for t in bucket if now - t < 60]
        if len(bucket) >= spec.rpm:
            wait = 60 - (now - bucket[0]) + 0.05
            await asyncio.sleep(min(wait, 5.0))
        bucket.append(time.time())

    def _record_failure(self, adapter: str, err: MvaError) -> None:
        h = self.health.setdefault(adapter, AdapterHealth())
        h.failures.append((time.time(), err.cls.value))
        if err.cls in (ErrorClass.TRANSIENT, ErrorClass.RATE_LIMITED, ErrorClass.FATAL):
            h.consecutive += 1
            if h.consecutive >= 5:
                h.circuit_open_until = time.time() + 60
                h.consecutive = 0
        else:
            h.consecutive = 0

    def _record_success(self, adapter: str) -> None:
        h = self.health.setdefault(adapter, AdapterHealth())
        h.consecutive = 0

    def health_snapshot(self) -> dict:
        return {name: {"circuit_open": h.open, "recent_failures": len(h.failures)} for name, h in self.health.items()}

    # ── 生成 ──
    async def generate(self, capability: Capability, req: GenerationRequest, *, tier: str | None = None,
                       model: str | None = None, budget: Decimal | None = None,
                       node_id: str | None = None) -> tuple[GenerationResult, list[dict]]:
        attempts_log: list[dict] = []
        tried: set[str] = set()
        adapter = await self.select(capability, tier=tier, model=model, budget=budget)
        total_retries = 0
        degraded = False

        for _round in range(3):  # 最多换 2 次适配器
            spec = adapter.spec
            tried.add(spec.adapter)
            if self.health.setdefault(spec.adapter, AdapterHealth()).open:
                attempts_log.append({"adapter": spec.adapter, "skipped": "circuit_open"})
                nxt = await self._next_candidate(capability, tried, tier, budget)
                if not nxt:
                    raise MvaError(ErrorClass.FATAL, "所有适配器均处于熔断状态", http_status=503)
                adapter, degraded = nxt, True
                continue

            attempt = 0
            max_attempts = max(MAX_ATTEMPTS.values())
            while attempt < max_attempts:
                attempt += 1
                t0 = time.perf_counter()
                try:
                    await self._rate_limit(spec)
                    async with self._sem(spec.adapter, spec.concurrency):
                        handle = await adapter.submit(req)
                        status = await self._await_result(adapter, handle, req)
                        result = await adapter.fetch(handle)
                    result.retries = total_retries
                    result.meta.update({"degraded": degraded, "attempts": attempt,
                                        "latency_ms": int((time.perf_counter() - t0) * 1000)})
                    self._record_success(spec.adapter)
                    if self.ledger:
                        self.ledger.record(adapter=spec.adapter, model=spec.model, node_id=node_id,
                                           cost=result.cost_cny, latency_ms=result.latency_ms,
                                           ok=True, attempt=attempt)
                    attempts_log.append({"adapter": spec.adapter, "attempt": attempt, "ok": True})
                    return result, attempts_log
                except Exception as exc:  # noqa: BLE001
                    err = adapter.normalize_error(exc)
                    self._record_failure(spec.adapter, err)
                    if self.ledger:
                        self.ledger.record(adapter=spec.adapter, model=spec.model, node_id=node_id,
                                           cost=Decimal("0"), latency_ms=int((time.perf_counter() - t0) * 1000),
                                           ok=False, attempt=attempt, error=err.cls.value)
                    attempts_log.append({"adapter": spec.adapter, "attempt": attempt, "ok": False,
                                         "error": err.cls.value, "message": err.message[:160]})

                    if err.cls in SWITCH_ADAPTER and settings.degrade_enabled:
                        nxt = await self._next_candidate(capability, tried, tier, budget)
                        if nxt:
                            adapter, degraded = nxt, True
                            attempts_log.append({"adapter": nxt.spec.adapter, "switched_from": spec.adapter})
                            break  # 跳到下一个适配器
                    if not err.retryable or attempt >= MAX_ATTEMPTS.get(err.cls, 0):
                        raise
                    total_retries += 1
                    delay = (err.retry_after_s if err.retry_after_s
                             else min(2 ** attempt + random.random(), 30))
                    await asyncio.sleep(delay)
            else:
                raise MvaError(ErrorClass.TRANSIENT, "重试耗尽", http_status=502)

        raise MvaError(ErrorClass.FATAL, "适配器降级链已耗尽", http_status=503)

    async def _next_candidate(self, capability: Capability, tried: set[str], tier, budget):
        try:
            return await self.select(capability, tier=tier, budget=budget, exclude=tried)
        except MvaError:
            return None

    async def _await_result(self, adapter: BaseAdapter, handle, req: GenerationRequest):
        """异步厂商支持：轮询直到 succeeded/failed。

        真实视频模型都是这个形状（submit → task_id → PENDING/RUNNING → SUCCEEDED）；
        图像/LLM 这类同步厂商的 poll() 直接返回 succeeded，因此这里不引入任何额外延迟。
        """
        interval = float(getattr(settings, "video_poll_interval_s", 5.0))
        timeout = float(req.params.get("poll_timeout_s") or getattr(settings, "video_timeout_s", 900))
        deadline = time.time() + timeout
        status = await adapter.poll(handle)
        polls = 1
        while status.state in ("queued", "running"):
            if time.time() > deadline:
                raise MvaError(ErrorClass.TRANSIENT,
                               f"{adapter.spec.adapter} 任务超时（{timeout:.0f}s 内未完成，已轮询 {polls} 次）",
                               http_status=504)
            await asyncio.sleep(interval)
            status = await adapter.poll(handle)
            polls += 1
        if status.state == "failed":
            raise status.error or MvaError(ErrorClass.TRANSIENT, "任务失败", http_status=502)
        if isinstance(handle.payload, dict):
            handle.payload["_polls"] = polls
        return status
