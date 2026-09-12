"""适配器统一接口 —— 与 docs/phase-4 §4.12 的 TypeScript/Python 契约逐字对应。

铁律：任何外部模型访问都必须经 BaseAdapter；接入新厂商 = 新增一个子类 + 注册，
上层（网关、调度器、画布、Agent）一律不改。
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from enum import Enum
from typing import Any

from .errors import MvaError


class Capability(str, Enum):
    LLM = "llm"
    VLM = "vlm"
    IMAGE = "image"
    VIDEO = "video"
    TTS = "tts"
    ASR = "asr"
    MUSIC = "music"


@dataclass(frozen=True)
class ModelSpec:
    adapter: str
    model: str
    capability: Capability
    price: Decimal
    price_unit: str  # per_image | per_second | per_1k_chars | per_1k_tokens
    max_prompt_chars: int = 1000
    ratios: tuple[str, ...] = ("9:16",)
    resolutions: tuple[str, ...] = ("1080x1920",)
    max_duration_s: int | None = None
    supports_callback: bool = False
    supports_seed: bool = False
    supports_first_frame: bool = False
    supports_last_frame: bool = False
    supports_negative_prompt: bool = False
    concurrency: int = 4
    rpm: int = 60
    commercial_use: bool = True
    region: str = "cn"
    quality_tier: str = "B"  # A/B/C，用于按预算自动选型
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "adapter": self.adapter, "model": self.model, "capability": self.capability.value,
            "price": float(self.price), "price_unit": self.price_unit, "quality_tier": self.quality_tier,
            "ratios": list(self.ratios), "resolutions": list(self.resolutions),
            "max_prompt_chars": self.max_prompt_chars, "max_duration_s": self.max_duration_s,
            "supports_seed": self.supports_seed, "supports_negative_prompt": self.supports_negative_prompt,
            "supports_first_frame": self.supports_first_frame, "supports_callback": self.supports_callback,
            "concurrency": self.concurrency, "rpm": self.rpm, "commercial_use": self.commercial_use,
            "region": self.region, "note": self.note,
        }


@dataclass
class GenerationRequest:
    prompt: str
    negative_prompt: str | None = None
    refs: list[str] = field(default_factory=list)
    params: dict[str, Any] = field(default_factory=dict)
    callback_url: str | None = None
    idempotency_key: str = ""
    timeout_s: float = 180.0


@dataclass
class GeneratedImage:
    data: bytes | None = None
    url: str | None = None
    mime: str = "image/png"
    width: int | None = None
    height: int | None = None
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class GenerationResult:
    artifacts: list[GeneratedImage]
    meta: dict[str, Any] = field(default_factory=dict)
    cost_cny: Decimal = Decimal("0")
    latency_ms: int = 0
    retries: int = 0
    raw: dict[str, Any] | None = None
    # 文本类能力（LLM/VLM 描述）走这里；与 artifacts 二选一或并存
    text: str | None = None
    tokens: dict[str, int] = field(default_factory=dict)


@dataclass
class TaskHandle:
    adapter: str
    external_task_id: str
    submitted_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    payload: Any = None


@dataclass
class TaskStatus:
    state: str  # queued | running | succeeded | failed
    progress: float | None = None
    error: MvaError | None = None


class BaseAdapter(ABC):
    spec: ModelSpec

    @abstractmethod
    async def submit(self, req: GenerationRequest) -> TaskHandle: ...

    @abstractmethod
    async def poll(self, handle: TaskHandle) -> TaskStatus: ...

    @abstractmethod
    async def fetch(self, handle: TaskHandle) -> GenerationResult: ...

    @abstractmethod
    def estimate_cost(self, req: GenerationRequest) -> Decimal: ...

    @abstractmethod
    def normalize_error(self, exc: Exception) -> MvaError: ...

    async def cancel(self, handle: TaskHandle) -> None:  # 可选实现
        return None

    def parse_callback(self, payload: dict) -> TaskStatus:  # 支持回调者实现
        raise NotImplementedError(f"{self.spec.adapter} 不支持回调")

    async def probe(self) -> bool:
        """可用性探测：本地模型/未配置 Key 的厂商据此被排除在选型之外。"""
        return True

    def error_map(self) -> dict[Any, tuple[str, str]]:
        """厂商错误码 → 统一分类（供契约测试与文档展示）。"""
        return {}
