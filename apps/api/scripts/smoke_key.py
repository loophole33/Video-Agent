"""真 key 冒烟测试 —— 一条命令验证你配置的图像厂商是否真的能用。

它不走假厂商、不走 Mock：直接按 .env 里的 MVA_IMAGE_* 配置调一次真实接口，
把图存到本地并打印：适配器 / 模型 / 尺寸 / 字节 / 耗时 / 花费 / 错误分类。

用法：
    npm run smoke            # 或 python apps/api/scripts/smoke_key.py
退出码：0 成功；非 0 失败（错误信息会直接告诉你该去控制台做什么）。
"""
from __future__ import annotations

import asyncio
import os
import sys
from decimal import Decimal
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mva.adapters.base import Capability, GenerationRequest  # noqa: E402
from mva.adapters.gateway import ModelGateway  # noqa: E402
from mva.adapters.registry import build_registry  # noqa: E402
from mva.config import settings  # noqa: E402
from mva.cost import CostLedger  # noqa: E402

PROMPT = "冰镇气泡水罐特写，水珠，清爽夏日感，商业摄影，竖屏"
HINTS = {
    "fatal": "→ 鉴权失败：检查 MVA_IMAGE_API_KEY 是否正确、是否多复制了空格；某些厂商要求 key 与 base_url 同地域。",
    "quota_exceeded": "→ 余额/配额不足：去厂商控制台充值或开通对应模型。",
    "invalid_request": "→ 参数被拒：模型名可能不对（检查 MVA_IMAGE_MODEL），或该模型不接受所请求的尺寸。",
    "content_blocked": "→ 内容审核拒绝：换个更中性的提示词再试。",
    "rate_limited": "→ 触发限流：稍后重试，或调低并发。",
    "transient": "→ 厂商服务/网络异常：稍后重试；若持续，检查 base_url 与出网代理。",
}


async def main() -> int:
    print("=" * 72)
    print("MVA 真 key 冒烟测试")
    print(f"  provider = {settings.image_provider}")
    print(f"  base_url = {settings.image_base_url or '(未配置)'}")
    print(f"  model    = {settings.image_model}")
    key = settings.image_api_key
    if not key:
        masked = "(未配置)"
    elif len(key) <= 8:
        masked = key[0] + "*" * (len(key) - 1)
    else:
        masked = key[:6] + "****" + key[-4:]
    print(f"  api_key  = {masked}")
    print("=" * 72)

    registry = build_registry()
    gateway = ModelGateway(registry, CostLedger())
    avail = await registry.available(Capability.IMAGE)
    print("可用适配器：", [f"{a.spec.adapter}({a.spec.model}, ¥{a.spec.price}/张)" for a in avail] or "无")

    try:
        result, attempts = await gateway.generate(
            Capability.IMAGE,
            GenerationRequest(prompt=PROMPT, negative_prompt="低分辨率, 水印",
                              params={"tier": "T-B", "ratio": "9:16", "resolution": "1080x1920",
                                      "count": 1, "seed": 42}),
            tier="T-B", budget=Decimal("5"),
        )
    except Exception as exc:  # noqa: BLE001
        cls = getattr(exc, "cls", None)
        cls_name = getattr(cls, "value", "unknown")
        print(f"\n[FAIL] 调用失败：{cls_name} — {exc}")
        print(HINTS.get(cls_name, "→ 查看上方错误详情与厂商控制台。"))
        return 2

    art = result.artifacts[0]
    data = art.data or b""
    out = Path(__file__).resolve().parents[1] / "smoke_key_output.png"
    out.write_bytes(data)
    print("\n调用轨迹：")
    for a in attempts:
        print("  -", a)
    print("\n[OK] 成功")
    print(f"  适配器   : {result.meta.get('adapter')}")
    print(f"  模型     : {result.meta.get('model')}")
    print(f"  尺寸     : {art.width}x{art.height}")
    print(f"  字节     : {len(data)} ({len(data) / 1024:.0f} KB)")
    print(f"  耗时     : {result.latency_ms} ms")
    print(f"  花费     : ¥{result.cost_cny}")
    print(f"  降级     : {result.meta.get('degraded')}")
    print(f"  产出文件 : {out}")
    if result.meta.get("placeholder"):
        print("\n注意：当前用的是 local-poster（占位画面，非 AI 生成）。")
        print("     要出真实 AI 画面，请在 .env 里配 MVA_IMAGE_PROVIDER=openai + BASE_URL/API_KEY/MODEL。")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
