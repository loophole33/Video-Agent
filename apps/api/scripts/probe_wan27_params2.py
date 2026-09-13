"""探针二：wan2.7-i2v 的参数有效性复查 —— 只提交、看终态，不下载。

首轮探针（probe_wan27_params.py）已确认：
  · A 旧形状 `input.img_url` → **终态 FAILED**「Field required: input.media」
  · B 新形状 `input.media[{type:'first_frame',url}]` + duration=5 → SUCCEEDED
  · D 新形状 media + duration=7（非 5/10 档）→ SUCCEEDED

本轮补测适配器里另外两个参数在 wan2.7 上是否仍有效：
  · `negative_prompt`（wan2.7 文档未提及；若被拒需去掉）
  · `prompt_extend`
并确认 duration=15（新上限）也被接受。

用法：cd apps/api && python scripts/probe_wan27_params2.py
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
import time
from pathlib import Path

import httpx

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass

ROOT = Path(__file__).resolve().parents[3]
REF = ROOT / "out" / "real-qwen-keyframe.png"


def load_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    return out


def small_data_uri(path: Path, max_side: int = 512) -> str:
    data = path.read_bytes()
    try:
        from PIL import Image  # type: ignore
        im = Image.open(io.BytesIO(data)).convert("RGB")
        im.thumbnail((max_side, max_side))
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=85)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:  # noqa: BLE001
        return "data:image/png;base64," + base64.b64encode(data).decode()


def main() -> int:
    env = {**load_env(ROOT / ".env"), **os.environ}
    base = env.get("MVA_VIDEO_BASE_URL", "").rstrip("/")
    key = env.get("MVA_VIDEO_API_KEY", "")
    model = env.get("MVA_VIDEO_MODEL", "")
    uri = small_data_uri(REF)
    url = f"{base}/services/aigc/video-generation/video-synthesis"
    prompt = "小男孩在雨中奔跑，水花四溅"

    def media_input() -> dict:
        return {"prompt": prompt, "media": [{"type": "first_frame", "url": uri}]}

    candidates: list[tuple[str, dict]] = [
        ("E. media + negative_prompt（适配器当前会发）", {
            "model": model,
            "input": {**media_input(), "negative_prompt": "低分辨率, 模糊, 畸变"},
            "parameters": {"resolution": "1080P", "duration": 5},
        }),
        ("F. media + duration=15（新上限）", {
            "model": model, "input": media_input(),
            "parameters": {"resolution": "1080P", "duration": 15},
        }),
    ]

    submitted: list[tuple[str, str]] = []
    with httpx.Client(timeout=90) as client:
        for name, payload in candidates:
            r = client.post(url, json=payload, headers={
                "Authorization": f"Bearer {key}", "Content-Type": "application/json",
                "X-DashScope-Async": "enable"})
            tid = ""
            if r.status_code == 200:
                tid = ((r.json().get("output") or {}).get("task_id")) or ""
            print(f"{'✓ 提交' if r.status_code == 200 else '✗ 拒绝'}  {name}  HTTP {r.status_code}")
            if r.status_code != 200:
                print(f"    {r.text[:260]}\n")
            else:
                submitted.append((name, tid))

        # 等终态（async 的拒绝发生在 render 阶段，提交成功不代表有效）
        print("\n等待终态（async 校验延迟，必须看 task_status）…")
        results = []
        for _ in range(30):
            time.sleep(10)
            done = 0
            results = []
            for name, tid in submitted:
                b = client.get(f"{base}/tasks/{tid}", headers={"Authorization": f"Bearer {key}"}).json()
                out = b.get("output") or {}
                st = out.get("task_status")
                results.append((name, st, bool(out.get("video_url")), str(out.get("message", ""))[:80]))
                if st in ("SUCCEEDED", "FAILED", "CANCELED"):
                    done += 1
            if done == len(submitted):
                break
        for name, st, has, msg in results:
            print(f"{name[:34]:36s} {st:10s} video={'YES' if has else '-'}  {msg}")

    (ROOT / "out" / "probe_wan27_params2.txt").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
