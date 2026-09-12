"""真机联调自检：用 .env 里配的真实厂商跑一遍 3 个 Skill，并把结果写成 JSON 供人工检查。

用法（网关已启动）：python scripts/smoke_real_skills.py
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass

BASE = "http://127.0.0.1:8010"
OUT = Path("smoke_real_skills.json")

BRIEF = {
    "objective": "种草",
    "product": {"name": "0 糖气泡水", "usp": ["0糖", "冰爽"]},
    "platform": "douyin",
    "duration_s": 20,
    "style": {"tone": "清爽", "pace": "快"},
    "constraints": {"forbidden_words": ["最", "第一", "国家级", "100%"]},
}


async def call(client: httpx.AsyncClient, key: str, inputs: dict) -> dict:
    r = await client.post(f"{BASE}/api/v1/skills/{key}", json={"input": inputs}, timeout=300)
    return {"status": r.status_code, "body": r.json()}


async def main() -> int:
    report: dict = {}
    async with httpx.AsyncClient() as client:
        health = (await client.get(f"{BASE}/healthz")).json()
        report["health"] = {
            "providers": health.get("providers"),
            "available": [f"{a['capability']}:{a['adapter']}/{a['model']}" for a in health.get("available", [])],
            "warnings": health.get("warnings"),
        }
        print("providers:", json.dumps(report["health"]["providers"], ensure_ascii=False))
        print("available:", " | ".join(report["health"]["available"]))
        if report["health"]["warnings"]:
            print("warnings:", " ; ".join(report["health"]["warnings"]))

        copy = await call(client, "mva.copy.generate", {"brief": BRIEF, "max_chars": 90})
        report["copy"] = copy
        if copy["status"] == 200:
            m = copy["body"]["meta"]
            print(f"\n[文案] {m['model']} · 修复 {m['schema_repairs']} · ¥{m['cost_cny']:.4f} · {m['latency_ms']}ms")
            for v in copy["body"]["output"]["variants"]:
                print(f"  [{v['style']}] {v['hook']}")
                print(f"      {v['body']}")
                print(f"      CTA: {v['cta']}  (~{v.get('estimated_read_s')}s)")
            print("  usp_coverage:", json.dumps(copy["body"]["output"].get("usp_coverage"), ensure_ascii=False))
        else:
            print("\n[文案] 失败：", json.dumps(copy["body"], ensure_ascii=False)[:400])

        variant = (copy["body"].get("output", {}).get("variants") or [{}])[0] if copy["status"] == 200 else {}
        sb = await call(client, "mva.script.storyboard",
                        {"brief": BRIEF, "copy": variant, "target_duration_s": 20, "shot_count": 6})
        report["storyboard"] = sb
        if sb["status"] == 200:
            o = sb["body"]["output"]
            m = sb["body"]["meta"]
            total = sum(float(s["duration_s"]) for s in o["shots"])
            print(f"\n[分镜] {m['model']} · 修复 {m['schema_repairs']} · ¥{m['cost_cny']:.4f} · {m['latency_ms']}ms"
                  f" · 目标 {o['total_duration_s']}s / 实际合计 {total:.1f}s")
            for s in o["shots"]:
                print(f"  #{s['shot_no']} {s['duration_s']}s {s['camera']:<5} | 字幕「{s['on_screen_text']}」")
                print(f"      画面: {s['visual']}")
            print("  一致性词典:", json.dumps(o.get("consistency_bible"), ensure_ascii=False)[:220])
        else:
            print("\n[分镜] 失败：", json.dumps(sb["body"], ensure_ascii=False)[:600])

        shots = (sb["body"].get("output", {}).get("shots") or [{}]) if sb["status"] == 200 else [{}]
        pc = await call(client, "mva.prompt.compile.video",
                        {"shot": shots[0], "style": BRIEF["style"],
                         "consistency_bible": (sb["body"].get("output", {}) or {}).get("consistency_bible", {}),
                         "target": "video", "model_family": "kling", "max_chars": 800})
        report["compile"] = pc
        if pc["status"] == 200:
            o = pc["body"]["output"]
            print(f"\n[提示词编译] {pc['body']['meta']['model']}")
            print("  正向:", o["prompt"])
            print("  负向:", o["negative_prompt"])
            print("  参数建议:", json.dumps(o.get("params_hint"), ensure_ascii=False))
        else:
            print("\n[提示词编译] 失败：", json.dumps(pc["body"], ensure_ascii=False)[:400])

    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n完整结果已写入 {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
