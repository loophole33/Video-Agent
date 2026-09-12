"""图像工具：从字节里读出真实尺寸（产物的 width/height 必须是真的，不能靠调用方猜）。"""
from __future__ import annotations

import io


def probe_image_size(data: bytes) -> tuple[int | None, int | None]:
    try:
        from PIL import Image

        with Image.open(io.BytesIO(data)) as im:
            return im.size
    except Exception:  # noqa: BLE001
        return (None, None)


def sniff_mime(data: bytes) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav"
    if data[:3] == b"ID3" or data[:2] in (b"\xff\xfb", b"\xff\xf3"):
        return "audio/mpeg"
    if data[4:8] == b"ftyp":
        return "video/mp4"
    return "application/octet-stream"


def probe_media_duration(path) -> int | None:
    """读任意媒体文件（音频/视频）的真实时长（毫秒）。音频对齐必须用它，不能靠字数估算。"""
    import json
    import subprocess

    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        dur = json.loads(r.stdout or "{}").get("format", {}).get("duration")
        return int(float(dur) * 1000) if dur else None
    except Exception:  # noqa: BLE001
        return None


def probe_video(data: bytes) -> tuple[int | None, int | None, int | None]:
    import json
    import subprocess
    import tempfile
    from pathlib import Path

    try:
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "probe.mp4"
            p.write_bytes(data)
            r = subprocess.run(
                ["ffprobe", "-v", "error", "-select_streams", "v:0",
                 "-show_entries", "stream=width,height", "-show_entries", "format=duration",
                 "-of", "json", str(p)],
                capture_output=True, text=True, timeout=30,
            )
            info = json.loads(r.stdout or "{}")
            stream = (info.get("streams") or [{}])[0]
            dur = info.get("format", {}).get("duration")
            return (stream.get("width"), stream.get("height"),
                    int(float(dur) * 1000) if dur else None)
    except Exception:  # noqa: BLE001
        return (None, None, None)
