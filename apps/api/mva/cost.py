"""成本账本 —— 每次真实调用都落一行，可按适配器/日期汇总（docs/phase-2 §2.5 cost_ledger 的最小实现）。"""
from __future__ import annotations

import json
import threading
import time
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from .config import settings


@dataclass
class LedgerEntry:
    ts: str
    adapter: str
    model: str
    node_id: str | None
    cost_cny: float
    latency_ms: int
    ok: bool
    attempt: int
    error: str | None = None
    extra: dict = field(default_factory=dict)


class CostLedger:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or (settings.data_dir / "cost_ledger.jsonl")
        self._lock = threading.Lock()
        self._mem: list[LedgerEntry] = []
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        for line in self.path.read_text(encoding="utf-8").splitlines()[-5000:]:
            try:
                d = json.loads(line)
                self._mem.append(LedgerEntry(**d))
            except Exception:  # noqa: BLE001
                continue

    def record(self, *, adapter: str, model: str, node_id: str | None, cost: Decimal,
               latency_ms: int, ok: bool, attempt: int, error: str | None = None,
               extra: dict | None = None) -> LedgerEntry:
        entry = LedgerEntry(
            ts=datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            adapter=adapter, model=model, node_id=node_id, cost_cny=float(cost),
            latency_ms=latency_ms, ok=ok, attempt=attempt, error=error, extra=extra or {},
        )
        with self._lock:
            self._mem.append(entry)
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(asdict(entry), ensure_ascii=False) + "\n")
        return entry

    def recent(self, limit: int = 50) -> list[LedgerEntry]:
        return self._mem[-limit:][::-1]

    def summary(self) -> dict:
        by_adapter: dict[str, dict] = defaultdict(lambda: {"calls": 0, "ok": 0, "cost_cny": 0.0, "failures": 0})
        by_day: dict[str, dict] = defaultdict(lambda: {"calls": 0, "cost_cny": 0.0})
        total_cost = 0.0
        for e in self._mem:
            a = by_adapter[e.adapter]
            a["calls"] += 1
            a["ok"] += 1 if e.ok else 0
            a["failures"] += 0 if e.ok else 1
            a["cost_cny"] = round(a["cost_cny"] + e.cost_cny, 6)
            day = e.ts[:10]
            by_day[day]["calls"] += 1
            by_day[day]["cost_cny"] = round(by_day[day]["cost_cny"] + e.cost_cny, 6)
            total_cost += e.cost_cny
        return {
            "entries": len(self._mem),
            "total_cost_cny": round(total_cost, 6),
            "by_adapter": dict(by_adapter),
            "by_day": dict(sorted(by_day.items())[-14:]),
            "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }


__all__ = ["CostLedger", "LedgerEntry", "time"]
