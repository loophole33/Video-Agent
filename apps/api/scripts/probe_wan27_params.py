"""探针：wan2.7-i2v 的首帧传参与时长档位 —— 实测，不猜。

背景：用户把 MVA_VIDEO_MODEL 从 wan2.2-i2v-plus 换成 wan2.7-i2v（前者额度用光）。
适配器 `dashscope_video.py` 里有两处对 wan 系列的硬假设，可能已失效：
  1. 首帧用 `input.img_url` 传 —— 但 wan2.7 文档说它只接受 `input.media[{type:'first_frame',url}]`，
     并明确「早期模型才用 img_url」。
  2. `ALLOWED_DURATIONS = (5, 10)` —— 但 wan2.7 支持 2–15 秒。

本探针**只提交、不轮询**：只为确认参数是否被接受，不花钱（文档载明失败调用不计费）。
每次提交成功即取消任务，避免真的出片。

用法：cd apps/api && python scripts/probe_wan27_params.py
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
from pathlib import Path

import httpx

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass

ROOT = Path(__file__).resolve().parents[3]
ENV = ROOT / ".env"
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
        data = buf.getvalue()
        mime = "image/jpeg"
    except Exception:  # noqa: BLE001
        mime = "image/png"
    return f"data:{mime};base64,{base64.b64encode(data).decode()}"


def main() -> int:
    env = {**load_env(ENV), **os.environ}
    base = env.get("MVA_VIDEO_BASE_URL", "").rstrip("/")
    key = env.get("MVA_VIDEO_API_KEY", "")
    model = env.get("MVA_VIDEO_MODEL", "")
    if not (base and key and model):
        print("缺少 MVA_VIDEO_* 配置")
        return 2
    if not REF.is_file():
        print(f"参考图不存在：{REF}")
        return 2

    uri = small_data_uri(REF)
    print(f"模型：{model}")
    print(f"端点：{base}/services/aigc/video-generation/video-synthesis")
    print(f"参考图 data-uri 长度：{len(uri)//1024}KB\n")

    prompt = "小男孩在雨中奔跑，水花四溅"
    url = f"{base}/services/aigc/video-generation/video-synthesis"

    # 候选：首帧传参方式 × 时长档位
    candidates: list[tuple[str, dict]] = [
        ("A. 旧形状 img_url + duration=5（当前适配器）", {
            "model": model,
            "input": {"prompt": prompt, "img_url": uri},
            "parameters": {"resolution": "1080P", "duration": 5, "prompt_extend": True},
        }),
        ("B. 新形状 media[first_frame] + duration=5", {
            "model": model,
            "input": {"prompt": prompt,
                      "media": [{"type": "first_frame", "url": uri}]},
            "parameters": {"resolution": "1080P", "duration": 5, "prompt_extend": True},
        }),
        ("C. 新形状 media + duration=3（wan2.7 声称支持 2–15s）", {
            "model": model,
            "input": {"prompt": prompt,
                      "media": [{"type": "first_frame", "url": uri}]},
            "parameters": {"resolution": "1080P", "duration": 3, "prompt_extend": True},
        }),
        ("D. 新形状 media + duration=7（非 5/10 档）", {
            "model": model,
            "input": {"prompt": prompt,
                      "media": [{"type": "first_frame", "url": uri}]},
            "parameters": {"resolution": "1080P", "duration": 7, "prompt_extend": True},
        }),
    ]

    results = []
    with httpx.Client(timeout=90) as client:
        for name, payload in candidates:
            try:
                r = client.post(url, json=payload, headers={
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                    "X-DashScope-Async": "enable",
                })
            except httpx.HTTPError as e:
                print(f"✗ {name}: 网络异常 {e}\n")
                results.append((name, "network", str(e)))
                continue

            body_text = r.text[:500]
            task_id = ""
            if r.status_code == 200:
                try:
                    task_id = (r.json().get("output") or {}).get("task_id", "")
                except Exception:  # noqa: BLE001
                    pass
            mark = "✓ 接受" if r.status_code == 200 else "✗ 被拒"
            print(f"{mark}  {name}")
            print(f"    HTTP {r.status_code}  task_id={task_id or '—'}")
            print(f"    {body_text[:280]}\n")
            results.append((name, r.status_code, task_id, body_text))

            # 接受即取消，避免真的出片花钱
            if task_id:
                try:
                    c = client.post(f"{base}/tasks/{task_id}/cancel",
                                    headers={"Authorization": f"Bearer {key}"})
                    print(f"    （已尝试取消：HTTP {c.status_code}）\n")
                except httpx.HTTPError as e:
                    print(f"    （取消失败：{e}）\n")

    out = ROOT / "out" / "probe_wan27_params.txt"
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"完整记录：{out}")

    accepted = [n for n, code, *_ in results if code == 200]
    print("\n=== 结论 ===")
    print(f"被接受的形状：{accepted or '无'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
