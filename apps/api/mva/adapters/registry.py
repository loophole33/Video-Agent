"""适配器注册表 —— 按 providers 配置装配可用适配器（接入新厂商只改这里 + 一个子类）。"""
from __future__ import annotations

from decimal import Decimal

from ..config import settings
from .base import BaseAdapter, Capability, ModelSpec
from .image.local_poster import LocalPosterAdapter
from .image.openai_compat import OpenAICompatImageAdapter
from .image.sd_webui import SDWebUIImageAdapter
from .audio.dashscope_tts import build as build_tts
from .llm.openai_compat_llm import OpenAICompatLLMAdapter
from .video.dashscope_video import DashScopeVideoAdapter


class AdapterRegistry:
    def __init__(self) -> None:
        self._items: list[BaseAdapter] = []
        self._probe_cache: dict[str, tuple[float, bool]] = {}
        # 配置层面的问题必须**显式报出来**，不能静默降级
        self.warnings: list[str] = []

    def warn(self, message: str) -> None:
        if message not in self.warnings:
            self.warnings.append(message)

    def register(self, adapter: BaseAdapter) -> "AdapterRegistry":
        self._items.append(adapter)
        return self

    def all(self) -> list[BaseAdapter]:
        return list(self._items)

    def by_capability(self, cap: Capability) -> list[BaseAdapter]:
        return [a for a in self._items if a.spec.capability == cap]

    def get(self, adapter_name: str) -> BaseAdapter:
        for a in self._items:
            if a.spec.adapter == adapter_name:
                return a
        raise KeyError(f"未注册的适配器：{adapter_name}")

    async def available(self, cap: Capability) -> list[BaseAdapter]:
        """探测可用性（带 30s 缓存），把探测失败的适配器从选型中剔除。"""
        import time

        out: list[BaseAdapter] = []
        for a in self.by_capability(cap):
            cached = self._probe_cache.get(a.spec.adapter)
            now = time.time()
            if cached and now - cached[0] < 30:
                ok = cached[1]
            else:
                try:
                    ok = await a.probe()
                except Exception:  # noqa: BLE001
                    ok = False
                self._probe_cache[a.spec.adapter] = (now, ok)
            if ok:
                out.append(a)
        return out


VALID_PROVIDERS = {
    "image": {"local", "openai", "sd", "local-sd", "mock-openai"},
    "llm": {"none", "openai", "mock-openai"},
    "video": {"none", "dashscope", "mock-dashscope"},
    "tts": {"none", "dashscope", "mock-dashscope"},
}


def build_registry() -> AdapterRegistry:
    """按 MVA_*_PROVIDER 装配：local / openai / sd / dashscope / mock-*（可多选，靠 degrade 链串联）。"""
    reg = AdapterRegistry()
    provider = settings.image_provider.strip().lower()

    # ── 先做配置体检：值写错时明确告知，而不是悄悄不注册适配器 ──
    for cap, value, env in (
        ("image", provider, "MVA_IMAGE_PROVIDER"),
        ("llm", settings.llm_provider.strip().lower(), "MVA_LLM_PROVIDER"),
        ("video", settings.video_provider.strip().lower(), "MVA_VIDEO_PROVIDER"),
        ("tts", settings.tts_provider.strip().lower(), "MVA_TTS_PROVIDER"),
    ):
        if value not in VALID_PROVIDERS[cap]:
            reg.warn(f"{env}='{value}' 不是受支持的值（可选：{' | '.join(sorted(VALID_PROVIDERS[cap]))}）"
                     f" → 该能力的适配器未注册，对应节点将走本地兜底")
    if provider in ("openai", "mock-openai") and not settings.image_base_url:
        reg.warn("MVA_IMAGE_PROVIDER=openai 但 MVA_IMAGE_BASE_URL 为空 → 图像适配器未注册")
    if settings.llm_provider.strip().lower() in ("openai", "mock-openai") and not settings.llm_base_url:
        reg.warn("MVA_LLM_PROVIDER=openai 但 MVA_LLM_BASE_URL 为空 → LLM 适配器未注册，文案/分镜走规则版")
    if settings.video_provider.strip().lower() in ("dashscope", "mock-dashscope"):
        if not settings.video_base_url:
            reg.warn("MVA_VIDEO_PROVIDER=dashscope 但 MVA_VIDEO_BASE_URL 为空 → 视频适配器未注册")
        elif not settings.video_api_key:
            reg.warn("MVA_VIDEO_PROVIDER=dashscope 但 MVA_VIDEO_API_KEY 为空 → 视频调用会因鉴权失败")

    if provider in ("mock-openai", "openai") and settings.image_base_url:
        reg.register(OpenAICompatImageAdapter(
            ModelSpec(
                adapter="openai-compat", model=settings.image_model, capability=Capability.IMAGE,
                price=Decimal(str(settings.price_openai)), price_unit="per_image",
                max_prompt_chars=2000, ratios=("9:16", "16:9", "1:1"),
                resolutions=("1024x1536", "1024x1024", "1536x1024", "1080x1920"),
                supports_seed=False, supports_negative_prompt=True, concurrency=4, rpm=50,
                quality_tier=settings.image_quality_tier,
                note=f"OpenAI 兼容厂商（{settings.image_base_url}）",
            ),
            base_url=settings.image_base_url, api_key=settings.image_api_key,
        ))

    if provider in ("sd", "local-sd"):
        reg.register(SDWebUIImageAdapter(
            ModelSpec(
                adapter="sd-webui", model=settings.sd_model, capability=Capability.IMAGE,
                price=Decimal(str(settings.price_sd)), price_unit="per_image",
                max_prompt_chars=1500, ratios=("9:16", "16:9", "1:1"),
                resolutions=("768x1344", "1024x1024"), supports_seed=True,
                supports_negative_prompt=True, concurrency=1, rpm=60, region="local",
                quality_tier="A", note="本地 SD WebUI（需 GPU）",
            ),
            base_url=settings.sd_base_url,
        ))

    # ── LLM（文案 / 分镜 / 提示词编译）：未配置则不注册，Skill 调用会明确报"无可用适配器" ──
    lp = settings.llm_provider.strip().lower()
    if lp in ("openai", "mock-openai") and settings.llm_base_url:
        reg.register(OpenAICompatLLMAdapter(
            ModelSpec(
                adapter="llm-openai-compat", model=settings.llm_model, capability=Capability.LLM,
                price=Decimal(str(settings.price_llm_out_1k)), price_unit="per_1k_tokens",
                max_prompt_chars=24000, ratios=(), resolutions=(),
                concurrency=4, rpm=120, quality_tier=settings.llm_quality_tier,
                note=f"OpenAI 兼容 LLM（{settings.llm_base_url}）",
            ),
            base_url=settings.llm_base_url, api_key=settings.llm_api_key,
        ))

    # ── 视频生成（异步 i2v/t2v）──
    vp = settings.video_provider.strip().lower()
    if vp in ("dashscope", "mock-dashscope") and settings.video_base_url:
        reg.register(DashScopeVideoAdapter(
            ModelSpec(
                adapter="dashscope-video", model=settings.video_model, capability=Capability.VIDEO,
                price=Decimal(str(settings.price_video_sec)), price_unit="per_second",
                max_prompt_chars=1200, ratios=("9:16", "16:9", "1:1"),
                resolutions=("1080P", "720P"), max_duration_s=10,
                supports_callback=False, supports_seed=True, supports_first_frame=True,
                supports_negative_prompt=True, concurrency=2, rpm=20, quality_tier="A",
                note=f"DashScope 视频生成（{settings.video_base_url}）",
            ),
            base_url=settings.video_base_url, api_key=settings.video_api_key,
        ))

    # ── 语音合成（配音）──
    tp = settings.tts_provider.strip().lower()
    if tp in ("dashscope", "mock-dashscope"):
        if not (settings.tts_base_url or settings.video_base_url):
            reg.warn("MVA_TTS_PROVIDER=dashscope 但 BASE_URL 为空 → TTS 适配器未注册")
        elif not (settings.tts_api_key or settings.video_api_key):
            reg.warn("MVA_TTS_PROVIDER=dashscope 但 API_KEY 为空 → 配音会因鉴权失败")
        else:
            reg.register(build_tts())

    # 兜底永远最后注册 —— 降级链的最后一环
    reg.register(LocalPosterAdapter())
    return reg
