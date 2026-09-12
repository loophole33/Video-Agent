"""真实 TTS 自检：走网关的 /api/v1/tts/generate（按分镜批量，用于音画对齐）。

用法（网关已启动）：python scripts/smoke_real_tts.py
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass

BASE = "http://127.0.0.1:8010"

SEGMENTS = [
    {"shot_no": 1, "text": "下午三点，困得睁不开眼？"},
    {"shot_no": 2, "text": "来一罐冰镇气泡水，0 糖 0 卡。"},
    {"shot_no": 3, "text": "气泡在舌尖炸开，一口就回魂。"},
]


async def main() -> int:
    async with httpx.AsyncClient() as c:
        h = (await c.get(f"{BASE}/healthz")).json()
        print("available:", " | ".join(f"{a['capability']}:{a['adapter']}/{a['model']}"
                                       for a in h.get("available", [])))
        if h.get("warnings"):
            print("warnings:", " ; ".join(h["warnings"]))
        if not any(a["capability"] == "tts" for a in h.get("available", [])):
            print("\n❌ 没有可用的 TTS 适配器 —— 检查 MVA_TTS_PROVIDER / BASE_URL / API_KEY")
            return 1

        t0 = time.time()
        r = await c.post(f"{BASE}/api/v1/tts/generate",
                         json={"segments": SEGMENTS, "node_id": "n_tts_smoke"}, timeout=600)
        dt = time.time() - t0
        body = r.json()
        if r.status_code != 200:
            print(f"\n❌ HTTP {r.status_code}：", str(body)[:600])
            return 1

        m = body["meta"]
        print(f"\n✅ 成功（{dt:.1f}s）  适配器 {m['adapter']}/{m['model']}  音色 {m['voice']}")
        print(f"   段数 {m['segments']} · 花费 ¥{m['cost_cny']} · 耗时 {m['latency_ms']}ms\n")
        for a in body["artifacts"]:
            print(f"   shot_{a['meta'].get('shot_no')}: {a['durationMs']}ms · {a['size_bytes']/1024:.0f}KB · "
                  f"{a['mime']} · 「{a['meta'].get('text')}」")
            print(f"      {a['url']}")
        print("\n实体文件：apps/api/.mva-assets/audio/…")
        return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
