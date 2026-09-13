"""网关行为验证脚本 —— 对**真实运行的**网关服务发真实 HTTP 请求。

它验证的正是「接真实厂商之后才会暴露」的那些行为：
  ① 正常路径（OpenAI 兼容形状的 HTTP 往返 + b64 解析 + 落盘 + 记账）
  ② 429 限流 → 自动重试并最终成功（重试次数可观测）
  ③ 5xx 连续失败 → 自动切备用适配器（降级链）
  ④ 402 配额不足 → 切备用适配器
  ⑤ 400 内容审核拒绝 → 不重试、不降级，直接阻断
  ⑥ 厂商地址不可达 → 降级到零 Key 兜底适配器，流程不断
  ⑦ 成本账本按适配器汇总

用法：先起网关（见 README），再 `python scripts/verify_gateway.py`
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import sys
from pathlib import Path

import httpx

# 以 `python scripts/xxx.py` 直接运行时，sys.path 里只有 scripts/ —— 手动加上 apps/api
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mva.adapters.image.local_poster import render_poster  # noqa: E402
from mva.config import settings  # noqa: E402

# Windows 控制台默认 GBK，中文/符号会炸；强制 UTF-8 输出
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass

BASE = os.environ.get("MVA_VERIFY_BASE", "http://127.0.0.1:8010")
PROMPT = "冰镇气泡水特写，0 糖 0 卡，清爽夏日感"

PASS: list[str] = []
FAIL: list[str] = []
CAPS: dict[str, list[dict]] = {}  # /healthz 的 capabilities，供形状断言判断模型族


def video_model_caps() -> dict:
    """取视频适配器的 ModelSpec 播报值（/healthz 的 capabilities.video[0]）。"""
    return (CAPS.get("video") or [{}])[0]


def is_newgen(model: str) -> bool:
    """与适配器同口径：wan2.7 及以后用 media 数组传首帧 + 2–15s 档位。"""
    return bool(re.match(r"^wan2\.(7|8|9)", model or ""))


def check(name: str, ok: bool, detail: str = "") -> None:
    (PASS if ok else FAIL).append(f"{name}{(' -- ' + detail) if detail else ''}")
    print(f"  {'[PASS]' if ok else '[FAIL]'} {name}{(' -- ' + detail) if detail else ''}")


async def control(client: httpx.AsyncClient, mode: str, times: int = 0, reset: bool = False) -> None:
    r = await client.post(f"{BASE}/mock-provider/control",
                          json={"mode": mode, "times": times, "reset_history": reset})
    r.raise_for_status()


async def generate(client: httpx.AsyncClient, *, count: int = 1, tier: str = "T-B") -> tuple[int, dict]:
    r = await client.post(f"{BASE}/api/v1/images/generate", json={
        "prompt": PROMPT, "negative_prompt": "低分辨率, 水印",
        "params": {"tier": tier, "ratio": "9:16", "resolution": "1080x1920", "count": count, "seed": 42},
        "node_id": "n_img_verify",
    }, timeout=180)
    try:
        body = r.json()
    except Exception:  # noqa: BLE001
        body = {"raw": r.text[:200]}
    return r.status_code, body


async def verify_tts(client: httpx.AsyncClient) -> None:
    print("\n[14] 配音（TTS）：单段 / 逐镜批量 / 非法音色自动回退")
    await control(client, "ok", reset=True)

    r = await client.post(f"{BASE}/api/v1/tts/generate",
                          json={"text": "下午三点，困得睁不开眼？", "voice": "Cherry", "node_id": "n_tts_1"},
                          timeout=300)
    body = r.json()
    check("单段配音成功", r.status_code == 200 and len(body.get("artifacts", [])) == 1, f"HTTP {r.status_code}")
    if r.status_code == 200:
        a = body["artifacts"][0]
        check("音频可下载且是真 WAV", await _is_wav(client, a["url"]), a["url"][:48])
        check("时长被 ffprobe 探明", (a.get("durationMs") or 0) > 300, f'{a.get("durationMs")}ms')
        check("按字数计费", body["meta"]["cost_cny"] >= 0, f'¥{body["meta"]["cost_cny"]}')

    segs = [{"shot_no": 1, "text": "下午三点，困得睁不开眼？"},
            {"shot_no": 2, "text": "来一罐冰镇气泡水，0 糖 0 卡。"},
            {"shot_no": 3, "text": "气泡在舌尖炸开，一口就回魂。"}]
    r = await client.post(f"{BASE}/api/v1/tts/generate",
                          json={"segments": segs, "voice": "Cherry", "node_id": "n_tts_2"}, timeout=300)
    body = r.json()
    check("逐镜批量配音成功（3 段）", r.status_code == 200 and len(body.get("artifacts", [])) == 3,
          f'HTTP {r.status_code}, 段数={len(body.get("artifacts", []))}')
    if r.status_code == 200:
        shots = [a["meta"].get("shot_no") for a in body["artifacts"]]
        check("每段都带 shot_no（音画对齐的依据）", shots == [1, 2, 3], str(shots))
        durs = [a.get("durationMs") for a in body["artifacts"]]
        check("各段时长随文本长度变化", len(set(durs)) > 1, str(durs))

    r = await client.post(f"{BASE}/api/v1/tts/generate",
                          json={"text": "非法音色测试", "voice": "qingxin-不存在", "node_id": "n_tts_3"},
                          timeout=300)
    check("非法音色自动回退默认音色后成功", r.status_code == 200, f"HTTP {r.status_code} {str(r.json())[:160]}")

    print("\n[15] 配音失败路径：文本审核拒绝 → 归类 content_blocked")
    await control(client, "content_blocked", times=3, reset=True)
    r = await client.post(f"{BASE}/api/v1/tts/generate",
                          json={"text": "违规文本", "voice": "Cherry", "node_id": "n_tts_4"}, timeout=300)
    cls = err_class(r.json() if r.headers.get("content-type", "").startswith("application/json") else {})
    check("被阻断（非 200）", r.status_code >= 400, f"HTTP {r.status_code}")
    check("归类为 content_blocked", cls == "content_blocked", f"class={cls}")
    await control(client, "ok")


async def _is_wav(client: httpx.AsyncClient, url: str) -> bool:
    r = await client.get(f"{BASE}{url}")
    return r.status_code == 200 and r.content[:4] == b"RIFF" and r.content[8:12] == b"WAVE"


async def main() -> int:
    async with httpx.AsyncClient() as client:
        await control(client, "ok", reset=True)  # 开局先清干净，避免上一次的故障注入残留
        print("\n[1] 健康检查与能力清单")
        health = (await client.get(f"{BASE}/healthz")).json()
        CAPS.update(health.get("capabilities") or {})
        check("healthz 可用", health.get("ok") is True, f"provider={health.get('image_provider')}")
        avail = [a["adapter"] for a in health.get("available", [])]
        check("选型含 openai-compat（真实厂商路径）", "openai-compat" in avail, f"available={avail}")
        check("选型含 local-poster（兜底）", "local-poster" in avail)

        print("\n[2] 正常路径：经 OpenAI 兼容 HTTP 拉图 → b64 解析 → 落盘 → 记账")
        await control(client, "ok")
        code, body = await generate(client, count=2)
        ok = code == 200 and len(body.get("artifacts", [])) == 2
        check("生成 2 张成功", ok, f"HTTP {code}")
        if ok:
            a = body["artifacts"][0]
            adapter = body["meta"].get("adapter")
            check("适配器为 openai-compat", adapter == "openai-compat", f"adapter={adapter}")
            check("产物已落盘（内容寻址 url）", a["url"].startswith("/assets/"), a["url"][:48])
            check("尺寸正确", (a["width"], a["height"]) == (1080, 1920), f'{a["width"]}x{a["height"]}')
            check("成本按价格表记账", abs(body["meta"]["cost_cny"] - 0.06 * 2) < 1e-9,
                  f'cost={body["meta"]["cost_cny"]}')
            # 真实取回字节，确认不是空壳 URL
            img = await client.get(f"{BASE}{a['url']}")
            check("产物可通过 HTTP 取回", img.status_code == 200 and len(img.content) > 5000,
                  f'{len(img.content)} bytes, {img.headers.get("content-type")}')
            png_ok = img.content[:8] == b"\x89PNG\r\n\x1a\n"
            check("确实是 PNG 文件头", png_ok)

        print("\n[3] 429 限流 → 自动重试后成功（重试次数可观测）")
        await control(client, "rate_limited", times=2)
        code, body = await generate(client)
        tried = [a for a in body.get("meta", {}).get("attempts", []) if a.get("adapter") == "openai-compat"]
        check("最终成功", code == 200, f"HTTP {code}")
        check("重试了 2 次后成功", len(tried) == 3, f"attempts={len(tried)}")

        print("\n[4] 5xx 连续失败 → 自动切备用适配器（降级链）")
        await control(client, "server_error", times=10)
        code, body = await generate(client)
        meta = body.get("meta", {})
        check("仍然出图（未整体失败）", code == 200 and len(body.get("artifacts", [])) == 1, f"HTTP {code}")
        check("已标记 degraded", meta.get("degraded") is True, f'degraded={meta.get("degraded")}')
        check("实际使用兜底适配器", meta.get("adapter") == "local-poster", f'adapter={meta.get("adapter")}')
        check("成本随之归零", meta.get("cost_cny") == 0.0, f'cost={meta.get("cost_cny")}')
        await control(client, "ok")

        print("\n[5] 402 配额不足 → 切备用适配器")
        await control(client, "quota", times=3)
        code, body = await generate(client)
        check("切到兜底后成功", code == 200 and body.get("meta", {}).get("adapter") == "local-poster",
              f'HTTP {code}, adapter={body.get("meta", {}).get("adapter")}')
        await control(client, "ok")

        print("\n[6] 400 内容审核拒绝 → 不重试、不降级，直接阻断")
        await control(client, "content_blocked", times=5, reset=True)
        code, body = await generate(client)
        detail = body.get("detail") or body
        cls = (detail.get("error") or {}).get("class") if isinstance(detail, dict) else None
        check("被阻断（非 200）", code >= 400, f"HTTP {code}")
        check("归类为 content_blocked", cls == "content_blocked", f"class={cls}")
        state = (await client.get(f"{BASE}/mock-provider/state")).json()
        check("未降级、未重试（厂商只被调用 1 次）", state["calls"] == 1, f'vendor calls={state["calls"]}')
        await control(client, "ok")

        print("\n[7] 成本账本汇总")
        summary = (await client.get(f"{BASE}/api/v1/costs/summary")).json()
        by_adapter = summary["summary"]["by_adapter"]
        check("账本含 openai-compat 记录", "openai-compat" in by_adapter, json.dumps(by_adapter, ensure_ascii=False))
        check("账本含 local-poster 记录", "local-poster" in by_adapter)
        check("失败调用也被记录", any(v["failures"] > 0 for v in by_adapter.values()),
              json.dumps({k: v["failures"] for k, v in by_adapter.items()}))

        await verify_skills(client)
        await verify_video(client)
        await verify_tts(client)

    # 收尾：清掉故障注入，避免影响后续手工/端到端运行
    async with httpx.AsyncClient() as cleanup:
        await control(cleanup, "ok", reset=True)

    print("\n" + "=" * 68)
    print(f"通过 {len(PASS)} 项 · 失败 {len(FAIL)} 项")
    if FAIL:
        print("失败项：")
        for f in FAIL:
            print("  -", f)
    return 1 if FAIL else 0


BRIEF = {
    "objective": "种草", "product": {"name": "0 糖气泡水", "usp": ["0糖", "冰爽"]},
    "platform": "douyin", "duration_s": 20, "style": {"tone": "清爽", "pace": "快"},
}


async def skill(client: httpx.AsyncClient, key: str, inputs: dict) -> tuple[int, dict]:
    r = await client.post(f"{BASE}/api/v1/skills/{key}", json={"input": inputs}, timeout=180)
    try:
        return r.status_code, r.json()
    except Exception:  # noqa: BLE001
        return r.status_code, {"raw": r.text[:200]}


def err_class(body: dict) -> str | None:
    """兼容 FastAPI 的两种 detail 形状：{detail: {error: {...}}} 与 {detail: [...]}"""
    detail = body.get("detail")
    if isinstance(detail, dict):
        return (detail.get("error") or {}).get("class")
    return None


async def verify_skills(client: httpx.AsyncClient) -> None:
    print("\n[8] Skill 层：版本化 Prompt → LLM → 结构化校验")
    await control(client, "ok", reset=True)

    code, body = await skill(client, "mva.copy.generate", {"brief": BRIEF})
    out = body.get("output") or {}
    check("文案 Skill 成功", code == 200 and len(out.get("variants", [])) == 3, f"HTTP {code}")
    check("三个版本风格齐备", {v.get("style") for v in out.get("variants", [])} == {"痛点型", "利益型", "场景型"})
    meta = body.get("meta") or {}
    check("记录了 prompt 版本与 token 成本",
          meta.get("prompt_file") == "1.1.0.md" and "cost_cny" in meta,
          f"prompt={meta.get('prompt_file')} cost=¥{meta.get('cost_cny')}")

    code, body = await skill(client, "mva.script.storyboard",
                             {"brief": BRIEF, "copy": out.get("variants", [{}])[0],
                              "target_duration_s": 20, "shot_count": 6})
    sb = body.get("output") or {}
    shots = sb.get("shots", [])
    check("分镜 Skill 成功且镜头数正确", code == 200 and len(shots) == 6,
          f"HTTP {code}" + ("" if code == 200 else f" :: {json.dumps(body, ensure_ascii=False)[:220]}"))
    if not shots:
        return
    total = sum(float(s.get("duration_s", 0)) for s in shots)
    check("镜头时长之和与目标一致（±3%）", abs(total - 19.8) <= 19.8 * 0.03, f"合计 {total:.2f}s")
    cams = {s.get("camera") for s in shots}
    check("运镜取值都在枚举内", cams <= {"特写", "中景", "全景", "俯拍", "跟拍", "缓慢推近", "环绕"}, str(cams))
    check("字幕是给观众看的文案（非镜头名）", all(len(str(s.get("on_screen_text", ""))) >= 2 for s in shots))

    code, body = await skill(client, "mva.prompt.compile.video",
                             {"shot": shots[0], "style": BRIEF["style"],
                              "consistency_bible": sb.get("consistency_bible", {}),
                              "target": "video", "model_family": "kling"})
    pc = body.get("output") or {}
    check("提示词编译 Skill 成功", code == 200 and len(str(pc.get("prompt", ""))) > 8, f"HTTP {code}")
    check("负向提示词已产出", len(str(pc.get("negative_prompt", ""))) > 4)

    print("\n[9] 结构化输出的修复重试（模型先吐坏 JSON，再被修回）")
    await control(client, "bad_json", times=1, reset=True)
    code, body = await skill(client, "mva.copy.generate", {"brief": BRIEF})
    meta = body.get("meta") or {}
    check("坏 JSON 被修复后成功", code == 200, f"HTTP {code}")
    check("修复次数被记录", meta.get("schema_repairs") == 1, f"repairs={meta.get('schema_repairs')}")

    await control(client, "schema_violation", times=1, reset=True)
    code, body = await skill(client, "mva.copy.generate", {"brief": BRIEF})
    check("Schema 不符（风格枚举越界）也能修回", code == 200, f"HTTP {code}")

    print("\n[10] 厂商不支持 response_format 时自动降级重试")
    await control(client, "reject_json_mode", times=1, reset=True)
    code, body = await skill(client, "mva.copy.generate", {"brief": BRIEF})
    check("去掉 response_format 后成功", code == 200, f"HTTP {code}")


async def verify_video(client: httpx.AsyncClient) -> None:
    print("\n[11] 视频生成：异步任务全链路（submit → 轮询 → 真 MP4 → 落盘）")
    await control(client, "ok", reset=True)
    model = str(video_model_caps().get("model") or "")
    newgen = is_newgen(model)
    max_s = int(video_model_caps().get("max_duration_s") or 0)
    # 时长上限必须跟着模型族播报（wan2.7 → 15）。写死 10 会让前端以为新模型不能超过 10s。
    check("healthz 的时长上限与模型族一致（wan2.7+ → 15）",
          max_s >= 15 if newgen else max_s == 10, f'model={model}, max_duration_s={max_s}')

    # 首帧用真实落盘的 PNG：假厂商要能读到它才会去渲染真 MP4（data URI 不被假厂商解析）
    png = render_poster("冰镇气泡水易拉罐特写，蓝色包装，水珠，夏日清爽", 1080, 1920, 20260912,
                        tier="I2V-VERIFY", label="I2V VERIFY")
    stem = hashlib.sha256(png).hexdigest()[:16]
    ref_rel = f"images/verify/{stem}.png"
    ref_path = settings.data_dir / ref_rel
    ref_path.parent.mkdir(parents=True, exist_ok=True)
    ref_path.write_bytes(png)
    first_frame_url = f"/assets/{ref_rel}"

    asked = 4  # 请求 4s：wan2.2 夹到 5s，wan2.7 正好落在 2–15 档内
    r = await client.post(f"{BASE}/api/v1/videos/generate", json={
        "prompt": "冰镇气泡水特写，缓慢推近，水珠滑落，清爽夏日感",
        "first_frame_url": first_frame_url, "duration_s": asked, "resolution": "1080P", "tier": "T-A",
        "node_id": "n_vid_verify",
    }, timeout=300)
    body = r.json()
    check("视频生成成功", r.status_code == 200, f"HTTP {r.status_code} {str(body)[:120]}")
    if r.status_code == 200:
        art = (body.get("artifacts") or [{}])[0]
        check("适配器为 dashscope-video", body["meta"].get("adapter") == "dashscope-video",
              f'adapter={body["meta"].get("adapter")}')
        check("异步轮询发生过（>1 次）", int(body["meta"].get("polls", 0)) >= 1,
              f'polls={body["meta"].get("polls")}')
        check("片段尺寸/时长被 ffprobe 探明", art.get("width") == 1080 and art.get("height") == 1920,
              f'{art.get("width")}x{art.get("height")} {art.get("durationMs")}ms')
        # 时长按**模型族**夹档后计费：wan2.2 → 5s；wan2.7 → 请求值 4s 原样生效（仍按报出的时长计费）
        expected_s = float(asked) if newgen else 5.0
        check(f"时长按模型族夹档并按夹后时长计费（{model or '未知模型'} → {expected_s:g}s）",
              abs(body["meta"]["cost_cny"] - 0.45 * expected_s) < 1e-6,
              f'请求 {asked}s → ¥{body["meta"]["cost_cny"]}（0.45×{expected_s:g}s）')
        clip = await client.get(f"{BASE}{art['url']}")
        check("片段可下载且是真 MP4", clip.status_code == 200 and clip.content[4:8] == b"ftyp",
              f'{len(clip.content)} bytes')

        # ── 首帧形状钉子（wan2.7+）：假厂商必须收到 media[0].type == 'first_frame' ──
        # 只发 input.img_url 时这里会直接红：wan2.7 对错形状的提交也回 200，
        # 只有任务终态会 FAILED「Field required: input.media」，所以必须验证**终态 + 厂商收到的形状**。
        tasks = (await client.get(f"{BASE}/mock-provider/video-tasks")).json().get("video_tasks") or []
        task = tasks[-1] if tasks else {}
        if newgen:
            check("假厂商收到的首帧形状是 media[0].type=first_frame",
                  (task.get("media") or [{}])[0].get("type") == "first_frame" and not task.get("has_img_url"),
                  f'model={model} media={task.get("media")} has_img_url={task.get("has_img_url")}')
        else:
            check("假厂商收到的首帧形状是 input.img_url（旧模型族）",
                  task.get("has_img_url") is True, f'model={model} has_img_url={task.get("has_img_url")}')
        check("厂商收到的首帧地址非空（形状没把首帧弄丢）",
              bool((task.get("media") or [{}])[0].get("url_kind")) or bool(task.get("has_img_url")),
              f'media={task.get("media")}')
        check("厂商收到的时长是模型族合法档位",
              float(task.get("duration") or 0) in (range(2, 16) if newgen else (5, 10)),
              f'duration={task.get("duration")}')
        check("任务在厂商侧到达 SUCCEEDED 终态（已渲染出片段）",
              task.get("rendered_ok") is True, f'rendered_ok={task.get("rendered_ok")}')

    print("\n[12] 视频任务失败 → 归类为内容审核阻断（不重试）")
    await control(client, "video_fail", times=1, reset=True)
    r = await client.post(f"{BASE}/api/v1/videos/generate", json={
        "prompt": "违规示例", "duration_s": 4, "tier": "T-A", "node_id": "n_vid_verify2",
    }, timeout=300)
    cls = err_class(r.json() if r.headers.get("content-type", "").startswith("application/json") else {})
    check("被阻断（非 200）", r.status_code >= 400, f"HTTP {r.status_code}")
    check("归类为 content_blocked", cls == "content_blocked", f"class={cls}")

    print("\n[13] 视频供应商不可用 → 降级链（本例无备用视频厂商，应明确报错而不是静默失败）")
    await control(client, "server_error", times=10, reset=True)
    r = await client.post(f"{BASE}/api/v1/videos/generate", json={
        "prompt": "服务异常示例", "duration_s": 4, "node_id": "n_vid_verify3",
    }, timeout=300)
    check("明确失败并给出可读原因", r.status_code >= 400 and "error" in str(r.json()),
          f"HTTP {r.status_code} {str(r.json())[:120]}")


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
