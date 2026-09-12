"""错误分类与重试矩阵 —— 与 docs/phase-2 §2.4.4 完全一致。

所有外部厂商的错误码/异常都必须经适配器的 normalize_error() 归一到这 6 类，
上层（调度器/网关）只认分类，不认厂商。
"""
from __future__ import annotations

from enum import Enum


class ErrorClass(str, Enum):
    TRANSIENT = "transient"  # 5xx / 网络 / 超时        → 可重试
    RATE_LIMITED = "rate_limited"  # 429                     → 可重试（读 Retry-After）
    QUOTA_EXCEEDED = "quota_exceeded"  # 配额/余额             → 不重试，切备用厂商
    CONTENT_BLOCKED = "content_blocked"  # 内容审核拒绝        → 不重试，记 audit_log
    INVALID_REQUEST = "invalid_request"  # 4xx 参数            → 不重试
    FATAL = "fatal"  # 鉴权/未分类            → 不重试，告警


RETRYABLE = {ErrorClass.TRANSIENT, ErrorClass.RATE_LIMITED}
MAX_ATTEMPTS = {
    ErrorClass.TRANSIENT: 3,
    ErrorClass.RATE_LIMITED: 5,
    ErrorClass.QUOTA_EXCEEDED: 0,
    ErrorClass.CONTENT_BLOCKED: 0,
    ErrorClass.INVALID_REQUEST: 0,
    ErrorClass.FATAL: 0,
}
# 出这类错时自动切同能力备用厂商
SWITCH_ADAPTER = {ErrorClass.QUOTA_EXCEEDED, ErrorClass.FATAL, ErrorClass.TRANSIENT}


class MvaError(Exception):
    def __init__(self, cls: ErrorClass, message: str, *, http_status: int = 502,
                 retry_after_s: float | None = None, detail: dict | None = None):
        super().__init__(message)
        self.cls = cls
        self.message = message
        self.http_status = http_status
        self.retry_after_s = retry_after_s
        self.detail = detail or {}

    @property
    def retryable(self) -> bool:
        return self.cls in RETRYABLE

    def to_dict(self) -> dict:
        return {"class": self.cls.value, "message": self.message, "retryable": self.retryable,
                **({"retry_after_s": self.retry_after_s} if self.retry_after_s else {}),
                **({"detail": self.detail} if self.detail else {})}


def classify_http(status: int, body: str = "") -> MvaError:
    """把厂商 HTTP 状态码翻译成统一错误（各适配器可覆盖，但默认走这里）。"""
    text = (body or "")[:300]
    lowered = text.lower()
    if status == 429:
        return MvaError(ErrorClass.RATE_LIMITED, f"厂商限流(429)：{text}", http_status=429)
    if status in (401, 403):
        return MvaError(ErrorClass.FATAL, f"鉴权失败({status})：请检查 API Key 配置", http_status=status)
    if status == 402:
        return MvaError(ErrorClass.QUOTA_EXCEEDED, f"余额/配额不足(402)：{text}", http_status=402)
    if status in (400, 422):
        # 内容审核类拒绝通常也是 400，靠关键词识别
        if any(k in lowered for k in ("policy", "safety", "moderation", "content", "敏感", "违规", "审核")):
            return MvaError(ErrorClass.CONTENT_BLOCKED, f"内容审核未通过：{text}", http_status=400)
        return MvaError(ErrorClass.INVALID_REQUEST, f"请求被拒绝({status})：{text}", http_status=status)
    if status >= 500:
        return MvaError(ErrorClass.TRANSIENT, f"厂商服务异常({status})：{text}", http_status=502)
    return MvaError(ErrorClass.FATAL, f"未分类错误({status})：{text}", http_status=502)
