"""极简 JSON Schema 校验器（只支持本项目用到的子集，避免引入额外依赖）。

支持：type / properties / required / items / enum / const / minimum / maximum /
      minItems / maxItems / minLength / maxLength / anyOf(oneOf) / additionalProperties(false)
目的是给 LLM 的结构化输出兜底：解析失败或结构不符 → 触发"修复重试"，绝不把脏数据放行。
"""
from __future__ import annotations

from typing import Any

TYPES = {
    "object": dict, "array": list, "string": str, "number": (int, float),
    "integer": int, "boolean": bool, "null": type(None),
}


class SchemaError(ValueError):
    def __init__(self, path: str, message: str):
        super().__init__(f"{path}: {message}")
        self.path = path
        self.message = message


def validate(instance: Any, schema: dict, path: str = "$") -> None:
    """校验通过返回 None，否则抛 SchemaError（带出错路径，便于回灌给模型修复）。"""
    if not isinstance(schema, dict):
        return

    if "const" in schema and instance != schema["const"]:
        raise SchemaError(path, f"应为常量 {schema['const']!r}，实际 {instance!r}")

    if "enum" in schema and instance not in schema["enum"]:
        raise SchemaError(path, f"应为 {schema['enum']} 之一，实际 {instance!r}")

    for key in ("anyOf", "oneOf"):
        if key in schema:
            errors = []
            for sub in schema[key]:
                try:
                    validate(instance, sub, path)
                    return
                except SchemaError as e:
                    errors.append(e.message)
            raise SchemaError(path, f"不满足 {'/'.join(str(s.get('type')) for s in schema[key])}（{'; '.join(errors)}）")

    t = schema.get("type")
    if t:
        expected = TYPES.get(t)
        if expected is None:
            raise SchemaError(path, f"未知类型声明 {t}")
        # bool 是 int 的子类，必须单独排除
        if t in ("number", "integer") and isinstance(instance, bool):
            raise SchemaError(path, f"应为 {t}，实际 boolean")
        if not isinstance(instance, expected):
            raise SchemaError(path, f"应为 {t}，实际 {type(instance).__name__}")

    if isinstance(instance, str):
        if "minLength" in schema and len(instance) < schema["minLength"]:
            raise SchemaError(path, f"长度需 ≥ {schema['minLength']}")
        if "maxLength" in schema and len(instance) > schema["maxLength"]:
            raise SchemaError(path, f"长度需 ≤ {schema['maxLength']}")

    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            raise SchemaError(path, f"需 ≥ {schema['minimum']}，实际 {instance}")
        if "maximum" in schema and instance > schema["maximum"]:
            raise SchemaError(path, f"需 ≤ {schema['maximum']}，实际 {instance}")

    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            raise SchemaError(path, f"至少 {schema['minItems']} 项，实际 {len(instance)}")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            raise SchemaError(path, f"至多 {schema['maxItems']} 项，实际 {len(instance)}")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for i, item in enumerate(instance):
                validate(item, item_schema, f"{path}[{i}]")

    if isinstance(instance, dict):
        for req in schema.get("required", []):
            if req not in instance:
                raise SchemaError(path, f"缺少必需字段 {req!r}")
        props = schema.get("properties", {})
        for k, v in instance.items():
            if k in props:
                validate(v, props[k], f"{path}.{k}")
            elif schema.get("additionalProperties") is False:
                raise SchemaError(path, f"多余字段 {k!r}")


def extract_json(text: str) -> Any:
    """从模型输出里抠出 JSON：容忍 ```json 围栏与前后废话。"""
    import json
    import re

    s = (text or "").strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", s)
    if fence:
        s = fence.group(1).strip()
    try:
        return json.loads(s)
    except Exception:  # noqa: BLE001
        pass
    # 退化路径：截取第一个 { 到最后一个 }
    start, end = s.find("{"), s.rfind("}")
    if start >= 0 and end > start:
        return json.loads(s[start : end + 1])
    raise ValueError("输出中找不到 JSON")
