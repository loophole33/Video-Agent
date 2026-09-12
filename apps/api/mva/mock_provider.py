"""自测用的「假厂商」：OpenAI 兼容图像/LLM 端点 + DashScope 形状的异步视频端点 + 故障注入。

它的存在不是为了糊弄 —— 而是为了让**真实厂商的调用路径**（HTTP 形状、b64 解析、异步 task_id 轮询、
错误码归一、重试、熔断、降级链、结构化输出修复）在**没有任何 API Key** 的情况下也能被完整验证。
把 MVA_*_BASE_URL 指到真实厂商，代码一行不用改。
"""
from __future__ import annotations

import asyncio
import base64
import json
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .adapters.image.local_poster import render_poster
from .config import settings

router = APIRouter(prefix="/mock-provider", tags=["mock-provider"])


@dataclass
class FaultState:
    mode: str = "ok"
    remaining: int = 0
    calls: int = 0
    history: list[dict] = field(default_factory=list)

    def take(self) -> str:
        self.calls += 1
        mode = self.mode
        if self.remaining > 0:
            self.remaining -= 1
            if self.remaining == 0:
                self.mode = "ok"
        self.history.append({"n": self.calls, "mode": mode, "ts": time.time()})
        self.history = self.history[-50:]
        return mode


state = FaultState()
video_tasks: dict[str, dict] = {}


@router.post("/control")
async def control(payload: dict) -> dict:
    """注入故障：{"mode": "rate_limited", "times": 2} —— 用来验证重试与降级。"""
    state.mode = str(payload.get("mode", "ok"))
    state.remaining = int(payload.get("times", 0))
    if payload.get("reset_history"):
        state.history.clear()
        state.calls = 0
        video_tasks.clear()
    return {"ok": True, "mode": state.mode, "remaining": state.remaining}


@router.get("/state")
async def get_state() -> dict:
    return {"mode": state.mode, "remaining": state.remaining, "calls": state.calls,
            "history": state.history[-10:], "video_tasks": list(video_tasks.keys())}


# ═══════════════ 图像（OpenAI 兼容） ═══════════════

@router.post("/v1/images/generations")
async def images_generations(request: Request):
    body = await request.json()
    mode = state.take()

    if mode == "rate_limited":
        return JSONResponse({"error": {"message": "rate limit exceeded", "type": "rate_limit_error"}},
                            status_code=429, headers={"Retry-After": "1"})
    if mode == "server_error":
        return JSONResponse({"error": {"message": "internal server error"}}, status_code=500)
    if mode == "quota":
        return JSONResponse({"error": {"message": "insufficient balance"}}, status_code=402)
    if mode == "content_blocked":
        return JSONResponse({"error": {"message": "your request was rejected as a result of our safety system"}},
                            status_code=400)
    if mode == "slow":
        await asyncio.sleep(2.5)
    if mode == "timeout":
        await asyncio.sleep(600)

    prompt = str(body.get("prompt", ""))[:200]
    size = str(body.get("size", "1024x1536"))
    try:
        w, h = (int(x) for x in size.split("x"))
    except Exception:  # noqa: BLE001
        w, h = 1024, 1536
    n = int(body.get("n", 1))
    seed = int(body.get("seed") or 42)

    def _one(i: int) -> str:
        png = render_poster(prompt, w, h, seed + i * 7919, tier="MOCK-VENDOR", label="MOCK VENDOR")
        return base64.b64encode(png).decode()

    images = await asyncio.gather(*[asyncio.to_thread(_one, i) for i in range(n)])
    return {
        "created": int(time.time()),
        "data": [{"b64_json": b, "revised_prompt": prompt} for b in images],
        "usage": {"images": n, "size": f"{w}x{h}"},
        "model": body.get("model", "mock-image-1"),
    }


# ═══════════════ LLM（OpenAI 兼容 chat completions） ═══════════════

def _detect_skill(prompt: str) -> str:
    # 用各 prompt 模板里的**特征短语**判定，避免互相误判（分镜 prompt 里也会出现文案内容）
    if "分镜导演" in prompt or '"shots"' in prompt:
        return "storyboard"
    if "提示词工程师" in prompt or '"negative_prompt"' in prompt:
        return "compile"
    return "copy"


def _mock_copy(prompt: str) -> dict:
    product = "产品"
    for token in ("气泡水", "手工皂", "提拉米苏", "吸尘器", "咖啡"):
        if token in prompt:
            product = token
            break
    return {
        "variants": [
            {"style": "痛点型", "hook": f"下午三点，撑不住了吧？", "body": f"来一口冰镇{product}，气泡在舌尖炸开，人瞬间清醒。", "cta": "左下角，囤一箱", "estimated_read_s": 9.6},
            {"style": "利益型", "hook": f"0 糖也能这么爽？", "body": f"{product}真正做到 0 糖 0 卡，冰镇后清爽不腻。", "cta": "点购物车，今天发", "estimated_read_s": 9.2},
            {"style": "场景型", "hook": "加班到十点，冰箱里那罐救了我", "body": f"拉开拉环的瞬间，一天的疲惫都被{product}冲散了。", "cta": "评论区扣 1，发链接", "estimated_read_s": 10.1},
        ],
        "recommended_index": 0,
        "usp_coverage": {"0糖": True, "冰爽": True},
    }


def _mock_storyboard(prompt: str) -> dict:
    shots = []
    plan = [
        ("通勤路上疲惫的年轻人握着产品，都市傍晚光线", "中景", "下午三点，撑不住了"),
        ("产品冰镇特写，水珠沿罐身滑落，冷调高光", "特写", "0 糖 0 卡"),
        ("办公室桌面上打开产品，气泡升腾，暖光洒落", "缓慢推近", "一口回魂"),
        ("成分表特写，突出 0 糖标识，清爽配色", "特写", "就是敢写 0 糖"),
        ("普通饮料与产品并排对比，俯拍构图", "俯拍", "同样是快乐"),
        ("产品与品牌 logo 同框，夏日冰爽背景", "全景", "左下角，囤一箱"),
    ]
    for i, (visual, camera, text) in enumerate(plan, start=1):
        shots.append({
            "shot_no": i, "duration_s": 3.3, "visual": visual, "camera": camera,
            "subject_ref": "hero_product", "narration": text,
            "on_screen_text": text, "transition_out": "dissolve",
        })
    return {
        "total_duration_s": 19.8,
        "narration_full": "下午三点撑不住了？来一口 0 糖 0 卡的气泡水，一口回魂。",
        "shots": shots,
        "consistency_bible": {
            "characters": [], "props": ["蓝色易拉罐，420ml，哑光标签，白色 0 糖标识"],
            "environment": ["办公室 / 通勤 / 夏日户外"], "lighting": "自然柔光 + 冷调高光",
        },
    }


def _mock_compile(prompt: str) -> dict:
    return {
        "prompt": "产品特写，蓝色易拉罐冰镇，水珠沿罐身滑落，缓慢推近，自然柔光加冷调高光，4k 商业摄影，清爽夏日感",
        "negative_prompt": "低分辨率, 模糊, 抖动, 闪烁, 文字乱码, 水印, 过曝",
        "params_hint": {"ratio": "9:16", "resolution": "1080x1920", "duration_s": 4, "motion": "缓慢推近"},
        "consistency_anchor_used": "蓝色易拉罐，420ml，哑光标签，白色 0 糖标识",
    }


@router.post("/v1/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()
    mode = state.take()
    prompt = json.dumps(body.get("messages", []), ensure_ascii=False)

    if mode == "rate_limited":
        return JSONResponse({"error": {"message": "rate limit exceeded"}}, status_code=429,
                            headers={"Retry-After": "1"})
    if mode == "server_error":
        return JSONResponse({"error": {"message": "internal server error"}}, status_code=500)
    if mode == "content_blocked":
        return JSONResponse({"error": {"message": "rejected by safety system"}}, status_code=400)
    if mode == "reject_json_mode":
        # 模拟"厂商不支持 response_format"：第一次带该参数时报 400，去掉后就正常
        if "response_format" in body:
            return JSONResponse({"error": {"message": "response_format is not supported"}}, status_code=400)

    skill = _detect_skill(prompt)
    payload = {"copy": _mock_copy, "storyboard": _mock_storyboard, "compile": _mock_compile}[skill](prompt)

    if mode == "bad_json":
        content = "好的，这是结果：\n```json\n{\"variants\": [{\"style\": \"痛点型\",\n```\n（被截断了）"
    elif mode == "schema_violation":
        content = json.dumps({"variants": [{"style": "随便型", "hook": "x"}], "recommended_index": 9},
                             ensure_ascii=False)
    else:
        content = json.dumps(payload, ensure_ascii=False)

    return {
        "id": f"chatcmpl-mock-{int(time.time())}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": body.get("model", "mock-llm"),
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content},
                     "finish_reason": "stop"}],
        "usage": {"prompt_tokens": max(1, len(prompt) // 4), "completion_tokens": max(1, len(content) // 4),
                  "total_tokens": (len(prompt) + len(content)) // 4},
    }


# ═══════════════ 视频（DashScope 异步形状，产出真 MP4） ═══════════════

async def _render_clip_mp4(task_id: str, prompt: str, img_ref: str | None, seconds: float) -> str:
    """假厂商也要给**真 MP4**：用 ffmpeg 把一张（有就复用首帧）画面渲染成带运动的片段。"""
    vdir = settings.data_dir / "videos"
    vdir.mkdir(parents=True, exist_ok=True)
    png_path = vdir / f"{task_id}.png"
    mp4_path = vdir / f"{task_id}.mp4"

    def _write_png() -> None:
        if img_ref and img_ref.startswith("data:image") and "," in img_ref:
            try:
                png_path.write_bytes(base64.b64decode(img_ref.split(",", 1)[1]))
                return
            except Exception:  # noqa: BLE001
                pass
        png_path.write_bytes(render_poster(prompt or "mock i2v", 1080, 1920, abs(hash(prompt)) % 10**6,
                                           tier="I2V", label="MOCK I2V"))

    await asyncio.to_thread(_write_png)
    frames = max(30, int(seconds * 30))
    cmd = [
        "ffmpeg", "-hide_banner", "-y", "-i", str(png_path),
        "-vf", f"scale=2160:3840:force_original_aspect_ratio=increase,crop=2160:3840,"
               f"zoompan=z='min(1+0.0016*on,1.3)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
               f":d={frames}:s=1080x1920:fps=30,setsar=1,format=yuv420p",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-movflags", "+faststart", str(mp4_path),
    ]
    await asyncio.to_thread(subprocess.run, cmd, cwd=str(vdir), check=True,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return f"{settings.public_base_url}/assets/videos/{mp4_path.name}"


@router.post("/dashscope/services/aigc/video-generation/video-synthesis")
async def video_synthesis(request: Request):
    body = await request.json()
    mode = state.take()
    if mode == "rate_limited":
        return JSONResponse({"code": "Throttling.RateQuota", "message": "Requests rate limit exceeded"},
                            status_code=429)
    if mode == "server_error":
        return JSONResponse({"code": "InternalError", "message": "internal error"}, status_code=500)
    if mode == "quota":
        return JSONResponse({"code": "Arrearage", "message": "insufficient balance"}, status_code=402)

    task_id = f"mock-vid-{int(time.time() * 1000) % 10**9}"
    inp = body.get("input") or {}
    params = body.get("parameters") or {}
    video_tasks[task_id] = {
        "prompt": str(inp.get("prompt", "")),
        "img_url": inp.get("img_url"),
        "duration": float(params.get("duration", 5)),
        "polls": 0,
        "fails": mode == "video_fail",
        "stuck": mode == "video_slow",
        "created": time.time(),
    }
    return {"request_id": task_id, "output": {"task_id": task_id, "task_status": "PENDING"}}


@router.get("/dashscope/tasks/{task_id}")
async def video_task(task_id: str):
    task = video_tasks.get(task_id)
    if not task:
        return JSONResponse({"code": "InvalidParameter", "message": "task not found"}, status_code=404)
    task["polls"] = task.get("polls", 0) + 1
    if task["stuck"]:
        return {"output": {"task_id": task_id, "task_status": "RUNNING"}}
    if task["fails"]:
        return {"output": {"task_id": task_id, "task_status": "FAILED", "code": "DataInspectionFailed",
                           "message": "内容审核未通过：画面包含敏感元素"}}
    if task["polls"] < 2:  # 第一次轮询返回 RUNNING，模拟异步
        return {"output": {"task_id": task_id, "task_status": "RUNNING"}}
    if "video_url" not in task:
        task["video_url"] = await _render_clip_mp4(task_id, task["prompt"], task["img_url"], task["duration"])
    return {"output": {"task_id": task_id, "task_status": "SUCCEEDED",
                       "video_url": task["video_url"],
                       "submit_time": "2026-01-01 00:00:00", "scheduled_time": "2026-01-01 00:00:01",
                       "end_time": "2026-01-01 00:00:30"}}


# ═══════════════ 语音合成（DashScope 原生形状，产出真 WAV） ═══════════════

ALLOWED_MOCK_VOICES = {"Cherry", "Serena", "Ethan", "Chelsie"}


async def _render_tts_wav(name: str, text: str) -> str:
    """假厂商也给**真 WAV**：用 ffmpeg 生成与文本长度相称的语音占位音（含淡入淡出）。"""
    adir = settings.data_dir / "audio" / "mock"
    adir.mkdir(parents=True, exist_ok=True)
    wav = adir / f"{name}.wav"
    dur = max(0.8, len(text) / 4.5)  # 按中文语速估时长
    cmd = [
        "ffmpeg", "-hide_banner", "-y",
        "-f", "lavfi", "-i", f"sine=frequency=180:duration={dur:.2f}:sample_rate=24000",
        "-af", f"tremolo=f=6:d=0.6,afade=t=in:d=0.1,afade=t=out:st={max(0, dur - 0.2):.2f}:d=0.2",
        "-ac", "1", str(wav),
    ]
    await asyncio.to_thread(subprocess.run, cmd, cwd=str(adir), check=True,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return f"{settings.public_base_url}/assets/audio/mock/{wav.name}"


@router.post("/dashscope/services/aigc/multimodal-generation/generation")
async def tts_generation(request: Request):
    body = await request.json()
    mode = state.take()
    if mode == "rate_limited":
        return JSONResponse({"code": "Throttling.RateQuota", "message": "Requests rate limit exceeded"},
                            status_code=429)
    if mode == "server_error":
        return JSONResponse({"code": "InternalError", "message": "internal error"}, status_code=500)
    if mode == "content_blocked":
        return JSONResponse({"code": "DataInspectionFailed", "message": "文本内容审核未通过"}, status_code=400)

    inp = body.get("input") or {}
    text = str(inp.get("text", ""))
    voice = str(inp.get("voice", ""))
    if voice not in ALLOWED_MOCK_VOICES:
        # 与真实厂商一致：非法音色返回 400 InvalidParameter（用于验证"自动回退默认音色"）
        return JSONResponse({"request_id": "mock", "code": "InvalidParameter",
                             "message": "Invalid voice specified, the requested voice does not exist "
                                        "or is not licensed for use—please select a supported voice."},
                            status_code=400)
    if not text.strip():
        return JSONResponse({"code": "InvalidParameter", "message": "text is required"}, status_code=400)

    audio_id = f"mock-tts-{int(time.time() * 1000) % 10**9}"
    url = await _render_tts_wav(audio_id, text)
    return {"request_id": audio_id,
            "output": {"audio": {"data": "", "id": audio_id, "url": url,
                                 "expires_at": int(time.time()) + 3600}},
            "usage": {"characters": len(text)}}
