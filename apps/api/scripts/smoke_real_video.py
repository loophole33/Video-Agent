"""真实视频生成自检：走网关的 i2v 端点，落一段真片段到 .mva-assets。

用法（网关已启动）：python scripts/smoke_real_video.py [首帧图路径]
不传首帧图时用 Pillow 现生成一张（i2v 需要首帧；t2v 可省）。
"""
from __future__ import annotations

import asyncio
import base64
import sys
import time
from pathlib import Path

import httpx

# 以 `python scripts/xxx.py` 直接运行时，sys.path 里只有 scripts/ —— 手动加上 apps/api
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass

BASE = "http://127.0.0.1:8010"


def first_frame() -> str:
    """返回 data URI 形式的首帧（网关会把它当作 /assets 之外的直传参考图）。"""
    from mva.adapters.image.local_poster import render_poster

    png = render_poster("冰镇气泡水易拉罐特写，蓝色包装，水珠，夏日清爽", 1080, 1920, 20260912,
                        tier="I2V-SMOKE", label="I2V SMOKE")
    return "data:image/png;base64," + base64.b64encode(png).decode()


async def main() -> int:
    ref = sys.argv[1] if len(sys.argv) > 1 else first_frame()
    async with httpx.AsyncClient() as client:
        health = (await client.get(f"{BASE}/healthz")).json()
        print("providers:", health.get("providers"))
        print("available:", " | ".join(f"{a['capability']}:{a['adapter']}/{a['model']}"
                                       for a in health.get("available", [])))
        if health.get("warnings"):
            print("warnings:", " ; ".join(health["warnings"]))
        if not any(a["capability"] == "video" for a in health.get("available", [])):
            print("\n❌ 没有可用的视频适配器 —— 检查 MVA_VIDEO_PROVIDER / BASE_URL / API_KEY")
            return 1

        print("\n提交 i2v（5s / 1080P）…（真实模型通常 1–5 分钟）")
        t0 = time.time()
        try:
            r = await client.post(f"{BASE}/api/v1/videos/generate", json={
                "prompt": "镜头缓慢推近，水珠沿罐身滑落，气泡升腾，清爽夏日感，画面稳定无变形",
                "first_frame_url": ref,
                "duration_s": 5,
                "resolution": "1080P",
                "tier": "T-A",
                "node_id": "n_video_smoke",
            }, timeout=1200)
        except httpx.HTTPError as e:
            print("❌ 请求失败：", e)
            return 1
        dt = time.time() - t0
        body = r.json()
        if r.status_code != 200:
            print(f"❌ HTTP {r.status_code}：", str(body)[:800])
            return 1

        art = body["artifacts"][0]
        meta = body["meta"]
        print(f"\n✅ 成功（{dt:.0f}s 含轮询 {meta.get('polls')} 次）")
        print(f"   适配器   : {meta.get('adapter')} / {meta.get('model')}")
        print(f"   尺寸时长 : {art.get('width')}x{art.get('height')} · {(art.get('durationMs') or 0)/1000:.1f}s")
        print(f"   花费     : ¥{meta.get('cost_cny')} · 重试 {meta.get('retries')}")
        print(f"   产出     : {art['url']}（{art.get('size_bytes', 0)/1024:.0f} KB）")
        print(f"   实体文件 : apps/api/.mva-assets/{art['url'].replace('/assets/', '')}")
        return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
