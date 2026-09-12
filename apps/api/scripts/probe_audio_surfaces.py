"""探测端点上可用的 TTS / ASR 接口形状（只发极短输入，费用可忽略）。

支持两种常见形状：
  A. OpenAI 兼容：POST {base}/audio/speech        （返回音频字节）
                  POST {base}/audio/transcriptions（multipart，返回 JSON）
  B. DashScope 原生：POST {base}/services/aigc/multimodal-generation/generation（返回音频 URL）
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx

# 以 `python scripts/xxx.py` 直接运行时，sys.path 里只有 scripts/ —— 手动加上 apps/api
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass

from mva.config import settings  # noqa: E402

COMPAT = settings.image_base_url.rstrip("/")          # …/compatible-mode/v1
NATIVE = settings.video_base_url.rstrip("/")          # …/api/v1
KEY = settings.image_api_key or settings.video_api_key
H = {"Authorization": f"Bearer {KEY}"}


def show(label: str, r: httpx.Response) -> None:
    ct = r.headers.get("content-type", "")
    if ct.startswith("audio") or ct.startswith("application/octet-stream"):
        print(f"[{label}] HTTP {r.status_code} · {ct} · {len(r.content)} bytes  ✅ 音频")
    else:
        body = r.text[:260].replace("\n", " ")
        print(f"[{label}] HTTP {r.status_code} · {ct} :: {body}")


async def main() -> None:
    async with httpx.AsyncClient(timeout=90) as c:
        print(f"compatible-mode 基址: {COMPAT}")
        print(f"DashScope 原生基址 : {NATIVE}\n")

        # A1. OpenAI 兼容 TTS
        for voice in ("Cherry", "alloy"):
            try:
                r = await c.post(f"{COMPAT}/audio/speech", headers={**H, "Content-Type": "application/json"},
                                 json={"model": "qwen3-tts-flash", "input": "测试配音", "voice": voice,
                                       "response_format": "mp3"})
                show(f"compat /audio/speech voice={voice}", r)
            except Exception as e:  # noqa: BLE001
                print(f"[compat /audio/speech voice={voice}] 异常: {e}")

        # B1. DashScope 原生 TTS
        try:
            r = await c.post(f"{NATIVE}/services/aigc/multimodal-generation/generation",
                             headers={**H, "Content-Type": "application/json"},
                             json={"model": "qwen3-tts-flash",
                                   "input": {"text": "测试配音", "voice": "Cherry"}})
            show("native qwen3-tts-flash", r)
            if r.status_code == 200:
                print("   →", json.dumps(r.json(), ensure_ascii=False)[:300])
        except Exception as e:  # noqa: BLE001
            print(f"[native qwen3-tts-flash] 异常: {e}")

        # A2. OpenAI 兼容 ASR（multipart）
        try:
            r = await c.post(f"{COMPAT}/audio/transcriptions", headers=H,
                             files={"file": ("test.mp3", b"\x00" * 2048, "audio/mpeg")},
                             data={"model": "qwen3-asr-flash", "response_format": "verbose_json"})
            show("compat /audio/transcriptions", r)
        except Exception as e:  # noqa: BLE001
            print(f"[compat /audio/transcriptions] 异常: {e}")


if __name__ == "__main__":
    asyncio.run(main())
