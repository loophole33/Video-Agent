"""配置：环境变量驱动，不把任何厂商写死在代码里（约束 1）。

支持从项目根或 apps/api 下的 .env 读取，避免引入 python-dotenv 依赖。
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _load_env_files() -> None:
    here = Path(__file__).resolve()
    for candidate in (here.parents[3] / ".env", here.parents[1] / ".env"):
        if not candidate.exists():
            continue
        for line in candidate.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env_files()


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


@dataclass(frozen=True)
class Settings:
    host: str = _env("MVA_API_HOST", "127.0.0.1")
    port: int = int(_env("MVA_API_PORT", "8010"))
    data_dir: Path = Path(_env("MVA_DATA_DIR", ".mva-assets")).resolve()

    # 图像供应商：local(零依赖 Pillow) | openai(任意 OpenAI 兼容厂商) | sd(本地 A1111/ComfyUI) | mock-openai(自测用)
    image_provider: str = _env("MVA_IMAGE_PROVIDER", "local")
    image_base_url: str = _env("MVA_IMAGE_BASE_URL", "")
    image_api_key: str = _env("MVA_IMAGE_API_KEY", "")
    image_model: str = _env("MVA_IMAGE_MODEL", "gpt-image-1")
    image_quality_tier: str = _env("MVA_IMAGE_TIER", "B")

    sd_base_url: str = _env("MVA_SD_BASE_URL", "http://127.0.0.1:7860")
    sd_model: str = _env("MVA_SD_MODEL", "sd_xl_base_1.0")

    # ── LLM（文案 / 分镜 / 提示词编译）──
    llm_provider: str = _env("MVA_LLM_PROVIDER", "none")  # none | openai | mock-openai
    llm_base_url: str = _env("MVA_LLM_BASE_URL", "")
    llm_api_key: str = _env("MVA_LLM_API_KEY", "")
    llm_model: str = _env("MVA_LLM_MODEL", "qwen-plus")
    llm_quality_tier: str = _env("MVA_LLM_TIER", "B")

    # ── 视频生成（i2v / t2v，异步任务）──
    video_provider: str = _env("MVA_VIDEO_PROVIDER", "none")  # none | dashscope | mock-dashscope
    video_base_url: str = _env("MVA_VIDEO_BASE_URL", "https://dashscope.aliyuncs.com/api/v1")
    video_api_key: str = _env("MVA_VIDEO_API_KEY", "")
    video_model: str = _env("MVA_VIDEO_MODEL", "wan2.2-i2v-flash")
    video_resolution: str = _env("MVA_VIDEO_RESOLUTION", "1080P")
    video_poll_interval_s: float = float(_env("MVA_VIDEO_POLL_INTERVAL_S", "5"))
    video_timeout_s: float = float(_env("MVA_VIDEO_TIMEOUT_S", "900"))
    # 厂商需要能访问到的首帧地址：本地图片会转成 base64 data URI；
    # 若你把产物放到公网/CDN，填这里可改写成公网 URL（优先于 base64）
    video_public_asset_base: str = _env("MVA_VIDEO_PUBLIC_ASSET_BASE", "")
    public_base_url: str = _env("MVA_PUBLIC_BASE_URL", f"http://127.0.0.1:{_env('MVA_API_PORT', '8010')}")

    max_retries: int = int(_env("MVA_MAX_RETRIES", "3"))
    request_timeout_s: float = float(_env("MVA_REQUEST_TIMEOUT_S", "180"))
    degrade_enabled: bool = _env("MVA_DEGRADE", "1") == "1"
    enable_mock_provider: bool = _env("MVA_ENABLE_MOCK_PROVIDER", "1") == "1"

    # ── 语音合成（配音）──
    #   实测：DashScope 原生 multimodal-generation 可用；OpenAI 兼容 /audio/speech 在该端点 404
    tts_provider: str = _env("MVA_TTS_PROVIDER", "none")  # none | dashscope | mock-dashscope
    tts_base_url: str = _env("MVA_TTS_BASE_URL", "")      # 留空则复用 MVA_VIDEO_BASE_URL
    tts_api_key: str = _env("MVA_TTS_API_KEY", "")        # 留空则复用 MVA_VIDEO_API_KEY
    tts_model: str = _env("MVA_TTS_MODEL", "qwen3-tts-flash")
    tts_voice: str = _env("MVA_TTS_VOICE", "Cherry")

    # 价格表（¥）：可按需覆盖，代码里不硬编码厂商价
    price_local: float = float(_env("MVA_PRICE_LOCAL", "0.0"))
    price_openai: float = float(_env("MVA_PRICE_OPENAI", "0.06"))
    price_sd: float = float(_env("MVA_PRICE_SD", "0.0"))
    price_video_sec: float = float(_env("MVA_PRICE_VIDEO_SEC", "0.45"))
    price_tts_1k_chars: float = float(_env("MVA_PRICE_TTS_1K_CHARS", "0.02"))
    price_llm_in_1k: float = float(_env("MVA_PRICE_LLM_IN_1K", "0.002"))
    price_llm_out_1k: float = float(_env("MVA_PRICE_LLM_OUT_1K", "0.008"))

    cors_origins: list[str] = field(default_factory=lambda: _env(
        "MVA_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
    ).split(","))


settings = Settings()
settings.data_dir.mkdir(parents=True, exist_ok=True)
(settings.data_dir / "images").mkdir(exist_ok=True)
