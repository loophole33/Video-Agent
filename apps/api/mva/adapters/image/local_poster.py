"""零 Key 兜底适配器：用 Pillow 渲染真实 PNG（不是 AI 生成，明确标注为占位）。

它的价值有两个：
  1. 让整条链路（适配器 → 网关 → 对象存储 → 成本账 → 前端预览）在没有 Key、没有 GPU 时也能跑通
  2. 作为降级链的最后一环：真实厂商全挂时，成片仍然能出（观感降级但流程不断）
"""
from __future__ import annotations

import asyncio
import io
import math
import random
import time
from decimal import Decimal
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from ...config import settings
from ..errors import ErrorClass, MvaError
from ..base import (BaseAdapter, Capability, GeneratedImage, GenerationRequest,
                    GenerationResult, ModelSpec, TaskHandle, TaskStatus)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/PingFang.ttc",
]

PALETTES = [
    ((14, 12, 11), (36, 31, 28), (232, 163, 61)),
    ((12, 16, 20), (24, 40, 52), (76, 155, 232)),
    ((18, 13, 22), (44, 30, 56), (176, 107, 232)),
    ((10, 18, 16), (22, 46, 40), (63, 191, 143)),
]


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except Exception:  # noqa: BLE001
                continue
    return ImageFont.load_default()


def _wrap(text: str, font, max_width: int, draw: ImageDraw.ImageDraw) -> list[str]:
    lines: list[str] = []
    cur = ""
    for ch in text:
        probe = cur + ch
        if draw.textlength(probe, font=font) > max_width and cur:
            lines.append(cur)
            cur = ch
        else:
            cur = probe
    if cur:
        lines.append(cur)
    return lines[:4]


def render_poster(prompt: str, width: int, height: int, seed: int, *, tier: str = "T-B",
                  label: str = "PLACEHOLDER") -> bytes:
    """按种子生成一张「胶片格」风格的竖屏画面（构图/配色随种子变化）。"""
    rnd = random.Random(seed)
    bg, mid, accent = PALETTES[seed % len(PALETTES)]
    img = Image.new("RGB", (width, height), bg)
    draw = ImageDraw.Draw(img)

    # 径向渐变底
    for i in range(60, 0, -1):
        r = int(max(width, height) * (i / 60) * 0.75)
        cx, cy = width * (0.35 + rnd.random() * 0.3), height * (0.3 + rnd.random() * 0.25)
        alpha = int(10 + (60 - i) * 1.4)
        layer = Image.new("RGB", (width, height), bg)
        ld = ImageDraw.Draw(layer)
        ld.ellipse([cx - r, cy - r, cx + r, cy + r], fill=tuple(min(255, c + alpha) for c in mid))
        img = Image.blend(img, layer, 0.06)
    img = img.filter(ImageFilter.GaussianBlur(1.2))
    draw = ImageDraw.Draw(img)

    # 主体：随种子变化的几何构成（模拟"被摄物体"）
    cx, cy = width * (0.32 + rnd.random() * 0.36), height * (0.34 + rnd.random() * 0.24)
    bw = width * (0.2 + rnd.random() * 0.18)
    bh = height * (0.22 + rnd.random() * 0.2)
    draw.ellipse([cx - bw * 1.5, cy + bh * 0.85, cx + bw * 1.5, cy + bh * 1.05],
                 fill=tuple(max(0, c - 8) for c in bg))
    draw.rounded_rectangle([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2],
                           radius=int(bw * 0.18), fill=tuple(int(c * 0.95 + 18) for c in mid),
                           outline=accent, width=max(2, width // 360))
    draw.rounded_rectangle([cx - bw * 0.32, cy - bh * 0.1, cx + bw * 0.32, cy + bh * 0.16],
                           radius=max(2, width // 240), fill=(245, 241, 232))
    for i in range(3):  # 高光
        r = bw * (0.2 + 0.12 * i)
        draw.ellipse([cx + bw * 0.9 - r, cy - bh * 0.7 - r, cx + bw * 0.9 + r, cy - bh * 0.7 + r],
                     outline=accent, width=1)

    # 三分线
    for i in (1, 2):
        draw.line([(width / 3 * i, 0), (width / 3 * i, height)], fill=accent, width=1)
        draw.line([(0, height / 3 * i), (width, height / 3 * i)], fill=accent, width=1)

    # 齿孔
    hole_gap = max(20, height // 64)
    for y in range(hole_gap, height - hole_gap, hole_gap):
        w = max(5, width // 150)
        draw.rounded_rectangle([w, y, w * 2, y + hole_gap * 0.55], radius=2, fill=(14, 12, 11))
        draw.rounded_rectangle([width - w * 2, y, width - w, y + hole_gap * 0.55], radius=2, fill=(14, 12, 11))

    # 角标
    pad, arm = int(width * 0.03), int(width * 0.035)
    for (x0, y0, dx, dy) in ((pad, pad, 1, 1), (width - pad, height - pad, -1, -1)):
        draw.line([(x0, y0), (x0 + arm * dx, y0)], fill=accent, width=2)
        draw.line([(x0, y0), (x0, y0 + arm * dy)], fill=accent, width=2)

    # 文案（把 prompt 写进画面，演示时可读）
    f_title = _font(max(18, width // 26))
    f_meta = _font(max(12, width // 52))
    draw.text((pad, int(height * 0.06)), label, font=f_meta, fill=accent)
    draw.text((pad, int(height * 0.09)), f"{tier} · seed {seed}", font=f_meta,
              fill=(207, 199, 181))
    y = int(height * 0.74)
    for line in _wrap(prompt.replace("\n", " "), f_title, width - pad * 2, draw):
        draw.text((pad, y), line, font=f_title, fill=(245, 241, 232))
        y += int(f_title.size * 1.35)
    draw.text((pad, height - int(height * 0.05)), "非 AI 生成 · 占位画面（未配置模型）",
              font=f_meta, fill=(167, 158, 139))

    # 暗角
    vig = Image.new("L", (width, height), 0)
    vd = ImageDraw.Draw(vig)
    vd.ellipse([-width * 0.25, -height * 0.18, width * 1.25, height * 1.18], fill=190)
    vig = vig.filter(ImageFilter.GaussianBlur(width // 12))
    img = Image.composite(img, Image.new("RGB", (width, height), (0, 0, 0)), vig)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


class LocalPosterAdapter(BaseAdapter):
    spec = ModelSpec(
        adapter="local-poster", model="pillow-poster-v1", capability=Capability.IMAGE,
        price=Decimal(str(settings.price_local)), price_unit="per_image",
        max_prompt_chars=400, ratios=("9:16", "16:9", "1:1"),
        resolutions=("1080x1920", "720x1280"), supports_seed=True, supports_negative_prompt=True,
        concurrency=8, rpm=600, region="local", quality_tier="C",
        note="零 Key 兜底：Pillow 渲染占位画面（非 AI 生成）",
    )

    async def submit(self, req: GenerationRequest) -> TaskHandle:
        return TaskHandle(adapter=self.spec.adapter, external_task_id=f"local_{time.time_ns()}", payload=req)

    async def poll(self, handle: TaskHandle) -> TaskStatus:
        return TaskStatus(state="succeeded", progress=1.0)

    async def fetch(self, handle: TaskHandle) -> GenerationResult:
        req: GenerationRequest = handle.payload
        started = time.perf_counter()
        res = str(req.params.get("resolution", "1080x1920"))
        w, h = (int(x) for x in res.split("x"))
        count = int(req.params.get("count", 1))
        base_seed = int(req.params.get("seed") or 1234)
        tier = str(req.params.get("tier", "T-B"))

        def _render(i: int) -> GeneratedImage:
            png = render_poster(req.prompt, w, h, base_seed + i * 7919, tier=tier)
            return GeneratedImage(data=png, mime="image/png", width=w, height=h,
                                  meta={"seed": base_seed + i * 7919, "provider": "local-poster"})

        artifacts = await asyncio.gather(*[asyncio.to_thread(_render, i) for i in range(count)])
        return GenerationResult(
            artifacts=list(artifacts),
            meta={"adapter": self.spec.adapter, "model": self.spec.model, "seed": base_seed, "tier": tier,
                  "placeholder": True, "ai_generated": False},
            cost_cny=self.estimate_cost(req),
            latency_ms=int((time.perf_counter() - started) * 1000),
            raw={"provider": "local-poster"},
        )

    def estimate_cost(self, req: GenerationRequest) -> Decimal:
        return self.spec.price * Decimal(int(req.params.get("count", 1)))

    def normalize_error(self, exc: Exception) -> MvaError:
        if isinstance(exc, MvaError):
            return exc
        return MvaError(ErrorClass.TRANSIENT, f"本地渲染失败：{exc}", http_status=500)

    async def probe(self) -> bool:
        return True


__all__ = ["LocalPosterAdapter", "render_poster", "_font", "_wrap", "math"]
