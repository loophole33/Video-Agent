"""Skill 注册表：Prompt 模板 + 版本 + 输入/输出 Schema（docs/phase-3 §3.3 的最小落地）。

规则：
  · 每个 Skill 一个 key，版本化（prompt 文件放在 prompts/<key>/<version>.md）
  · 输出必须过 Schema 校验；不过 → 把校验错误回灌给模型"修复重试"（≤2 次），绝不静默放行
  · 调用记录里保留 skill/version/model/tokens/cost/schema_repairs，便于复现与回归
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

PROMPTS_DIR = Path(__file__).parent / "prompts"
DEFAULT_NEGATIVE = "低分辨率, 模糊, 畸变, 多余肢体, 文字乱码, 水印, 版权标识, 过曝, 塑料感"


@dataclass(frozen=True)
class SkillSpec:
    key: str
    version: str
    title: str
    capability: str
    temperature: float
    max_tokens: int
    input_schema: dict
    output_schema: dict
    json_mode: bool = True

    @property
    def prompt_path(self) -> Path:
        return PROMPTS_DIR / self.key / f"{self.version}.md"

    def render_prompt(self, variables: dict[str, Any]) -> str:
        template = self.prompt_path.read_text(encoding="utf-8")
        out = template
        for name, value in variables.items():
            token = "{{ " + name + " }}"
            rendered = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
            out = out.replace(token, rendered)
            # 支持带默认值/过滤器的简单写法： {{ x | default("…") }} / {{ x | tojson }}
            for suffix in (' | tojson', ' | default("（无）")'):
                out = out.replace("{{ " + name + suffix + " }}", rendered)
        return out


COPY_SKILL = SkillSpec(
    key="mva.copy.generate",
    version="1.1.0",
    title="营销文案生成（3 版）",
    capability="llm",
    temperature=0.8,
    max_tokens=1400,
    input_schema={
        "type": "object",
        "required": ["brief"],
        "properties": {"brief": {"type": "object"}, "max_chars": {"type": "integer"}},
    },
    output_schema={
        "type": "object",
        "required": ["variants", "recommended_index"],
        "properties": {
            "variants": {
                "type": "array",
                "minItems": 3,
                "maxItems": 3,
                "items": {
                    "type": "object",
                    "required": ["style", "hook", "body", "cta"],
                    "properties": {
                        "style": {"type": "string", "enum": ["痛点型", "利益型", "场景型"]},
                        "hook": {"type": "string", "minLength": 2, "maxLength": 60},
                        "body": {"type": "string", "minLength": 2, "maxLength": 200},
                        "cta": {"type": "string", "minLength": 2, "maxLength": 40},
                        "estimated_read_s": {"type": "number"},
                    },
                },
            },
            "recommended_index": {"type": "integer", "minimum": 0, "maximum": 2},
            "usp_coverage": {"type": "object"},
        },
    },
)

STORYBOARD_SKILL = SkillSpec(
    key="mva.script.storyboard",
    version="1.3.0",
    title="分镜脚本生成",
    capability="llm",
    temperature=0.6,
    max_tokens=2600,
    input_schema={
        "type": "object",
        "required": ["brief"],
        "properties": {
            "brief": {"type": "object", "description": "含 product/subject/platform/duration_s/style 等；subject 为画面主体（通用请求）"},
            "copy": {"type": "object"},
            "target_duration_s": {"type": "integer"},
            "shot_count": {"type": "integer"},
        },
    },
    output_schema={
        "type": "object",
        "required": ["total_duration_s", "shots"],
        "properties": {
            "total_duration_s": {"type": "number", "minimum": 3, "maximum": 180},
            "narration_full": {"type": "string"},
            "shots": {
                "type": "array",
                "minItems": 1,
                "maxItems": 12,
                "items": {
                    "type": "object",
                    "required": ["shot_no", "duration_s", "visual", "camera", "on_screen_text"],
                    "properties": {
                        "shot_no": {"type": "integer", "minimum": 1},
                        "duration_s": {"type": "number", "minimum": 1, "maximum": 10},
                        "visual": {"type": "string", "maxLength": 220},
                        "camera": {
                            "type": "string",
                            "enum": ["特写", "中景", "全景", "俯拍", "跟拍", "缓慢推近", "环绕"],
                        },
                        "subject_ref": {"type": "string"},
                        "narration": {"type": "string"},
                        "on_screen_text": {"type": "string", "maxLength": 20},
                        "transition_out": {
                            "type": "string",
                            "enum": ["cut", "dissolve", "slide", "zoom", "none"],
                        },
                    },
                },
            },
            "consistency_bible": {"type": "object"},
        },
    },
)

PROMPT_SKILL = SkillSpec(
    key="mva.prompt.compile.video",
    version="1.0.0",
    title="提示词编译（图像/视频）",
    capability="llm",
    temperature=0.4,
    max_tokens=1200,
    input_schema={
        "type": "object",
        "required": ["shot"],
        "properties": {
            "shot": {"type": "object"},
            "style": {"type": "object"},
            "consistency_bible": {"type": "object"},
            "target": {"type": "string"},
            "model_family": {"type": "string"},
            "max_chars": {"type": "integer"},
        },
    },
    output_schema={
        "type": "object",
        "required": ["prompt", "negative_prompt"],
        "properties": {
            "prompt": {"type": "string", "minLength": 8, "maxLength": 2000},
            "negative_prompt": {"type": "string", "maxLength": 600},
            "params_hint": {"type": "object"},
            "consistency_anchor_used": {"type": "string"},
        },
    },
)


@dataclass
class SkillRegistry:
    skills: dict[str, list[SkillSpec]] = field(default_factory=dict)

    def register(self, spec: SkillSpec) -> "SkillRegistry":
        self.skills.setdefault(spec.key, []).append(spec)
        return self

    def resolve(self, key: str, version: str | None = None) -> SkillSpec:
        versions = self.skills.get(key)
        if not versions:
            raise KeyError(f"未注册的 Skill：{key}")
        if version:
            for s in versions:
                if s.version == version:
                    return s
            raise KeyError(f"{key} 没有版本 {version}")
        return sorted(versions, key=lambda s: s.version)[-1]  # 取最新版本

    def describe(self) -> list[dict]:
        return [
            {
                "key": s.key,
                "version": s.version,
                "title": s.title,
                "capability": s.capability,
                "prompt_file": str(s.prompt_path.relative_to(PROMPTS_DIR.parent.parent)),
                "temperature": s.temperature,
                "max_tokens": s.max_tokens,
            }
            for versions in self.skills.values()
            for s in sorted(versions, key=lambda x: x.version)
        ]


def build_registry() -> SkillRegistry:
    reg = SkillRegistry()
    return reg.register(COPY_SKILL).register(STORYBOARD_SKILL).register(PROMPT_SKILL)


__all__ = [
    "SkillSpec", "SkillRegistry", "build_registry",
    "COPY_SKILL", "STORYBOARD_SKILL", "PROMPT_SKILL", "DEFAULT_NEGATIVE",
]
