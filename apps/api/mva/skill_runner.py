"""Skill 执行器：渲染版本化 Prompt → 调 LLM → 校验结构 → 失败则"修复重试"。

这是 docs/phase-3 §3.3.3 的最小可运行实现：
    验证入参 → 版本化模板渲染 → 模型调用 → JSON 提取 → Schema 校验
    → 不通过则把【原始输出 + 校验错误】回灌给模型修复（≤2 次）
    → 仍不通过就报错，绝不把脏数据放行
"""
from __future__ import annotations

import json
import time
from decimal import Decimal

from .adapters.base import Capability, GenerationRequest
from .adapters.errors import ErrorClass, MvaError
from .schema import SchemaError, extract_json, validate
from .skills import SkillRegistry

MAX_REPAIRS = 2


def _repair_prompt(base_prompt: str, bad_output: str, error: str) -> str:
    return (
        f"{base_prompt}\n\n"
        "---\n"
        "你上一次的输出不符合要求，必须修正。\n"
        f"校验错误：{error}\n"
        f"你上次的输出：\n{bad_output[:1500]}\n\n"
        "请只输出**修正后的 JSON**，不要任何解释、不要 markdown 围栏。"
    )


class SkillRunner:
    def __init__(self, gateway, skills: SkillRegistry) -> None:
        self.gateway = gateway
        self.skills = skills

    async def run(self, key: str, inputs: dict, version: str | None = None,
                  node_id: str | None = None) -> dict:
        spec = self.skills.resolve(key, version)
        try:
            validate(inputs, spec.input_schema, "$input")
        except SchemaError as e:
            raise MvaError(ErrorClass.INVALID_REQUEST, f"入参不符合 {key} 的 Schema：{e}", http_status=400) from e

        variables = {**inputs}
        variables.setdefault("negative_baseline", "低分辨率, 模糊, 抖动, 闪烁, 文字乱码, 水印")
        variables.setdefault("max_chars", 400 if key != "mva.copy.generate" else 90)
        prompt = spec.render_prompt(variables)

        started = time.perf_counter()
        repairs = 0
        last_error = ""
        last_raw = ""
        total_cost = Decimal("0")
        tokens = {"in": 0, "out": 0}
        attempts_log: list[dict] = []

        for attempt in range(MAX_REPAIRS + 1):
            req = GenerationRequest(
                prompt=prompt,
                params={"temperature": spec.temperature, "max_tokens": spec.max_tokens,
                        "json_mode": spec.json_mode, "system": "你是严格的 JSON 输出器，只输出 JSON。"},
                idempotency_key=f"{key}@{spec.version}:{hash(prompt) % 10**10}",
                timeout_s=180,
            )
            result, attempts = await self.gateway.generate(
                Capability.LLM, req, tier=None, node_id=node_id,
            )
            attempts_log.extend(attempts)
            total_cost += result.cost_cny
            tokens["in"] += result.tokens.get("in", 0)
            tokens["out"] += result.tokens.get("out", 0)
            last_raw = result.text or ""

            try:
                data = extract_json(last_raw)
                validate(data, spec.output_schema, "$output")
                return {
                    "ok": True,
                    "skill": {"key": spec.key, "version": spec.version},
                    "output": data,
                    "meta": {
                        "model": result.meta.get("model"),
                        "adapter": result.meta.get("adapter"),
                        "tokens": tokens,
                        "cost_cny": float(total_cost),
                        "latency_ms": int((time.perf_counter() - started) * 1000),
                        "schema_repairs": repairs,
                        "prompt_file": str(spec.prompt_path.name),
                        "attempts": attempts_log,
                    },
                }
            except (SchemaError, ValueError) as e:
                last_error = str(e)
                if repairs >= MAX_REPAIRS:
                    break
                repairs += 1
                prompt = _repair_prompt(prompt, last_raw, last_error)

        raise MvaError(
            ErrorClass.INVALID_REQUEST,
            f"{key}@{spec.version} 输出连续 {MAX_REPAIRS + 1} 次未通过 Schema 校验：{last_error}",
            http_status=422,
            detail={"schema_repairs": repairs, "raw_tail": last_raw[-400:], "attempts": attempts_log},
        )


__all__ = ["SkillRunner", "MAX_REPAIRS", "json"]
