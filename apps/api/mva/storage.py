"""对象存储（本地实现）—— 内容寻址 + 静态服务。

真实环境换成 S3/OSS/MinIO 即可（接口一致：save(bytes) -> key/url，fetch_remote(url) -> bytes）。
内容寻址（sha256）顺带解决两件事：天然去重、产物可校验。
"""
from __future__ import annotations

import hashlib
from pathlib import Path

import httpx

from .config import settings

EXT_BY_MIME = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
               "video/mp4": "mp4", "audio/wav": "wav", "audio/x-wav": "wav",
               "audio/wave": "wav", "audio/mpeg": "mp3", "audio/mp3": "mp3",
               "audio/aac": "aac", "audio/ogg": "ogg"}


def save_bytes(data: bytes, *, mime: str = "image/png", subdir: str = "images") -> dict:
    digest = hashlib.sha256(data).hexdigest()
    ext = EXT_BY_MIME.get(mime, "bin")
    rel = Path(subdir) / digest[:2] / f"{digest}.{ext}"
    path = settings.data_dir / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():  # 内容寻址：同内容只落一次
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
    return {
        "key": str(rel).replace("\\", "/"),
        "url": f"/assets/{str(rel).replace(chr(92), '/')}",
        "sha256": digest,
        "mime": mime,
        "size_bytes": path.stat().st_size,
        "deduped": path.stat().st_size != len(data) or True,
    }


async def fetch_remote(url: str, timeout: float = 60.0) -> bytes:
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        r = await client.get(url)
        r.raise_for_status()
        return r.content


def usage() -> dict:
    total = 0
    files = 0
    for p in settings.data_dir.rglob("*"):
        if p.is_file():
            files += 1
            total += p.stat().st_size
    return {"files": files, "bytes": total, "dir": str(settings.data_dir)}
