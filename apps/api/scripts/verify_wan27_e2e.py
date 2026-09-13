"""Task 3.5 真实厂商端到端证明：经**网关**提交一次 wan2.7 i2v，确认**终态 SUCCEEDED** + 真片段落盘。

为什么不能只看 HTTP 200：DashScope 视频接口是异步的，参数错了也回 200，
错误只出现在 GET /tasks/{id} 的 task_status=FAILED 里。所以本脚本断言的是终态产物。

用法（网关已按真实 dashscope 配置启动，例如 8012）：
    python scripts/verify_wan27_e2e.py [base_url]
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mva.adapters.image.local_poster import render_poster  # noqa: E402

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8012"
DURATION_S = 5  # 5s/1080P ≈ ¥2.25（MVA_PRICE_VIDEO_SEC=0.45）


def first_frame_data_uri() -> str:
    png = render_poster("冰镇气泡水易拉罐特写，蓝色包装，水珠，夏日清爽", 1080, 1920, 20260912,
                        tier="I2V-E2E", label="I2V E2E WAN2.7")
    return "data:image/png;base64," + base64.b64encode(png).decode()


async def main() -> int:
    async with httpx.AsyncClient() as client:
        health = (await client.get(f"{BASE}/healthz")).json()
        vids = (health.get("capabilities") or {}).get("video") or [{}]
        model = vids[0].get("model")
        print(f"网关 {BASE} · video={health.get('providers', {}).get('video')} · model={model} · "
              f"max_duration_s={vids[0].get('max_duration_s')}")
        if not (health.get("available") and any(a["capability"] == "video" for a in health["available"])):
            print("❌ 没有可用的视频适配器")
            return 1

        payload = {
            "prompt": "镜头缓慢推近，水珠沿罐身滑落，气泡升腾，清爽夏日感，画面稳定无变形",
            "first_frame_url": first_frame_data_uri(),
            "negative_prompt": "模糊, 变形, 水印, 文字",
            "duration_s": DURATION_S,
            "resolution": "1080P",
            "tier": "T-A",
            "node_id": "n_wan27_e2e",
        }
        print(f"\n提交 i2v：duration_s={DURATION_S} · 1080P · 首帧=base64 data URI"
              f"（适配器应转成 input.media[0].type=first_frame）")
        t0 = time.time()
        r = await client.post(f"{BASE}/api/v1/videos/generate", json=payload, timeout=1200)
        dt = time.time() - t0
        body = r.json()
        print(f"HTTP {r.status_code} · 耗时 {dt:.0f}s")
        if r.status_code != 200:
            print("❌ 终态失败：", str(body)[:900])
            return 1

        art = body["artifacts"][0]
        meta = body["meta"]
        att = meta.get("attempts") or []
        print(f"\n✅ 终态 SUCCEEDED（网关返回 200 = 已完成 submit→轮询→下载→落盘整条链）")
        print(f"   适配器     : {meta.get('adapter')} / {meta.get('model')}")
        print(f"   轮询次数   : {meta.get('polls')} · attempts={att}")
        print(f"   尺寸/时长  : {art.get('width')}x{art.get('height')} · "
              f"{(art.get('durationMs') or 0)/1000:.2f}s")
        print(f"   花费       : ¥{meta.get('cost_cny')}（0.45/s × {DURATION_S}s）")
        print(f"   产物 URL   : {art['url']}")
        print(f"   字节数     : {art.get('size_bytes')} bytes · sha256={art.get('digest')}")

        clip = await client.get(f"{BASE}{art['url']}")
        ok_mp4 = clip.status_code == 200 and clip.content[4:8] == b"ftyp"
        print(f"   下载校验   : HTTP {clip.status_code} · {len(clip.content)} bytes · "
              f"ftyp={'yes' if ok_mp4 else 'NO'}")
        local = Path(sys.argv[2]) / art["url"].replace("/assets/", "") if len(sys.argv) > 2 else None
        if local:
            local.parent.mkdir(parents=True, exist_ok=True)
            local.write_bytes(clip.content)
            print(f"   已复制到   : {local}（{local.stat().st_size} bytes, "
                  f"sha256={hashlib.sha256(local.read_bytes()).hexdigest()[:16]}…）")
        return 0 if ok_mp4 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
