"""探针：qwen-image-3.0 的图生图（I2I）请求形状 —— 实测，不猜。

背景：HANDOFF §2 记录「接口形状（实测，别再猜）」是项目铁律。
官方文档页抓取只拿到导航壳，无法确认参考图字段名，故直接对真实端点试形状。

策略：拿一张真实产出图（out/real-qwen-keyframe.png）当参考图，
依次试若干候选 payload 形状，记录 HTTP 状态与厂商返回体片段。
第一个成功（HTTP 200 且返回 data[]）的形状即真形状。

成本：每个候选一次图像调用（¥0.06/张）。失败形状（400）不计费。
用法：cd apps/api && python scripts/probe_image_i2i.py
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
from pathlib import Path

import httpx

# Windows 控制台默认 GBK，print 非 ASCII/异体字符会 UnicodeEncodeError 直接中断探测
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass

ROOT = Path(__file__).resolve().parents[3]          # D:\vtest
ENV = ROOT / ".env"
REF = ROOT / "out" / "real-qwen-keyframe.png"


def load_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def shrink_png(data: bytes, max_side: int = 768) -> bytes:
    """把参考图缩到 <=768px，避免 base64 过大被厂商拒；失败则原样返回。"""
    try:
        from PIL import Image  # type: ignore
    except Exception:  # noqa: BLE001
        return data
    try:
        im = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:  # noqa: BLE001
        return data
    im.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=88)
    return buf.getvalue()


def main() -> int:
    env = {**load_env(ENV), **os.environ}
    base = env.get("MVA_IMAGE_BASE_URL", "").rstrip("/")
    key = env.get("MVA_IMAGE_API_KEY", "")
    model = env.get("MVA_IMAGE_MODEL", "qwen-image-3.0")
    if not base or not key:
        print("缺少 MVA_IMAGE_BASE_URL / MVA_IMAGE_API_KEY，无法探测")
        return 2
    if not REF.is_file():
        print(f"参考图不存在：{REF}")
        return 2

    raw = REF.read_bytes()
    small = shrink_png(raw)
    data_uri = "data:image/jpeg;base64," + base64.b64encode(small).decode()
    print(f"参考图：{REF.name} {len(raw)//1024}KB → {len(small)//1024}KB  data-uri {len(data_uri)//1024}KB")
    print(f"端点：{base}/images/generations  模型：{model}\n")

    prompt = "保持主体不变，换成纯色影棚背景，柔和侧光"
    common = {
        "model": model,
        "prompt": prompt,
        "n": 1,
        "size": "1024x1536",
        "response_format": "b64_json",
    }

    # 候选形状：字段名与嵌套方式都试一遍
    candidates: list[tuple[str, dict]] = [
        ("A. image=<data_uri>", {**common, "image": data_uri}),
        ("B. image=[<data_uri>]", {**common, "image": [data_uri]}),
        ("C. image_url=<data_uri>", {**common, "image_url": data_uri}),
        ("D. images=[<data_uri>]", {**common, "images": [data_uri]}),
        ("E. messages 多模态", {
            "model": model, "n": 1, "size": "1024x1536", "response_format": "b64_json",
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": data_uri}},
            ]}],
        }),
    ]

    results = []
    with httpx.Client(timeout=180) as client:
        for name, payload in candidates:
            try:
                r = client.post(f"{base}/images/generations", json=payload,
                                headers={"Authorization": f"Bearer {key}",
                                         "Content-Type": "application/json"})
            except httpx.HTTPError as e:
                print(f"✗ {name}: 网络异常 {e}\n")
                results.append((name, "network", str(e)))
                continue
            body_text = r.text[:600]
            got = 0
            if r.status_code == 200:
                try:
                    got = len(r.json().get("data") or [])
                except Exception:  # noqa: BLE001
                    got = -1
            mark = "✓" if (r.status_code == 200 and got > 0) else "✗"
            print(f"{mark} {name}: HTTP {r.status_code}  data={got}")
            print(f"    {body_text[:300]}\n")
            results.append((name, r.status_code, got, body_text))
            if r.status_code == 200 and got > 0:
                print(f"→ 真实形状 = {name}")
                break

    out = ROOT / "out" / "probe_image_i2i.txt"
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"完整记录：{out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
