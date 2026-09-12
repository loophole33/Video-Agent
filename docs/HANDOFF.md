# MVA 项目续接文档（HANDOFF）

> 用途：**新会话开场读这一份就能接着干**，不需要上一轮对话的上下文。
> 最后更新：实时视频链路（i2v）+ 配音（TTS）+ 多画布 + 可伸缩面板 全部落地并验证之后。

---

## 0. 一句话现状

`D:\vtest` 里是一个**可运行的全真实链路营销视频智能体 Demo**：
画布手动编排 + Agent 一句话生成工作流 + 模型网关（适配器层）+ 本地 FFmpeg 合成 + TTS 配音。
**实测一次全量运行：342s / ¥7.30，产出 17.5s / 1080×1920 / 12.96MB 带人声的 MP4。**

---

## 1. 怎么起（两个进程）

```powershell
# 终端 A：模型网关（读 D:\vtest\.env）
cd D:\vtest; npm run api          # → http://127.0.0.1:8010
# 终端 B：画布 + FFmpeg 渲染桥
cd D:\vtest; npm run dev          # → http://localhost:5173
```

启动成功的标志（网关启动日志）：
```
MVA 网关 v0.3.0 装配完成：image=openai llm=openai video=dashscope
  已注册适配器：llm:llm-openai-compat(qwen3.8-flash), image:openai-compat(qwen-image-3.0), video:dashscope-video(wan2.2-i2v-plus), tts:dashscope-tts(qwen3-tts-flash), image:local-poster(...)
```
配错的值会以 `⚠` 打印，也会出现在 `GET /healthz` 的 `warnings` 里。

**常见坑**：`npm run api` 报 `10048 端口占用` = 已有网关在跑（先关掉再起，或改 `MVA_API_PORT`）。

---

## 2. 当前 .env 配置（真实厂商，已跑通）

| 能力 | provider | base_url | model | 备注 |
|---|---|---|---|---|
| 图像 | `openai` | `https://ws-xxx.maas.aliyuncs.com/compatible-mode/v1` | `qwen-image-3.0` | 约 **60s/张**，¥0.06/张 |
| LLM | `openai` | 同一个 MaaS 端点 | `qwen3.8-flash` | 文案/分镜/提示词编译；**必须用非推理模型**，否则 token 花在 reasoning 上、content 为空 |
| 视频 i2v | `dashscope` | `https://ws-xxx.maas.aliyuncs.com/api/v1` | `wan2.2-i2v-plus` | 异步：submit→轮询→video_url；**约 53s/段**，按 ¥0.45/s×5s=¥2.25/段（价格表可改） |
| 配音 TTS | `dashscope` | `https://ws-xxx.maas.aliyuncs.com/api/v1` | `qwen3-tts-flash` | 音色 `Cherry`；¥0.0009/6 段 |

**接口形状（实测，别再猜）**
- 图像 / LLM：OpenAI 兼容（`/images/generations`、`/chat/completions`）
- 视频：DashScope 原生 `POST {base}/services/aigc/video-generation/video-synthesis`（带 `X-DashScope-Async: enable`）+ `GET {base}/tasks/{id}`
- TTS：DashScope 原生 `POST {base}/services/aigc/multimodal-generation/generation` → `output.audio.url`（**OpenAI 兼容的 `/audio/speech` 在该端点 404**）
- 该 MaaS 端点 `/models` 有 ~249 个模型，**没有视频模型**，但 `/api/v1` 上的 DashScope 原生视频接口是**存在**的（早期误判已纠正）

---

## 3. 已验证的结论（可直接引用，不用重跑）

| 项 | 结果 |
|---|---|
| 网关行为验证 `npm run verify:gateway` | **55/55 通过**（选型/限流重试/降级链/审核阻断不重试/成本账本/Skill 结构修复/异步视频/TTS 非法音色回退） |
| 前端单测 `npm test` | **25/25**（applyPatch/invertOps/拓扑/连线校验/Agent 规划/成本模型/注册表） |
| 全真实链路 | 342s / ¥7.30；6 张真图 + 3 段真 i2v（5.0s/1072×1920）+ 6 段逐镜配音 + 成片 17.5s / 1080×1920 / 12.96MB |
| 成片规格 | h264 High + AAC-LC 48kHz 立体声，**-14.6 LUFS / -1.4 dBTP**（合平台规格） |
| 人声入片证据 | 高通 1kHz 电平：混音版 -24.6dB vs 仅 BGM 版 -39.8dB（差 15dB） |
| 画面运动真实性 | 各时间点抽帧 md5 全不同 |
| 产物 | `out/demo-full-real.mp4`（12.96MB，最终交付）、`out/demo-real-6shots.mp4`、`out/demo-llm-i2v-6shots.mp4` 等历史版本 |

---

## 4. 目录与关键文件（谁负责什么）

```
D:\vtest
├── docs/phase-1..9-*.md          9 阶段设计文档（需求/架构/Agent/流水线/画布/后端/骨架/测试/部署）
├── docs/HANDOFF.md               ← 本文件
├── .env                          真实厂商配置（唯一需要改的配置处）
├── apps/api/mva/
│   ├── config.py                 环境变量 → Settings（价格表也在这里）
│   ├── main.py                   FastAPI：/healthz /api/v1/{models,skills,images,videos,tts,costs}
│   ├── skill_runner.py           渲染版本化 Prompt → LLM → Schema 校验 → 失败回灌“修复重试”
│   ├── schema.py                 极简 JSON Schema 校验器（给 LLM 输出兜底）
│   ├── skills/__init__.py        3 个 Skill 定义（文案/分镜/提示词编译）+ 输入输出 Schema
│   ├── skills/prompts/<key>/<v>.md   版本化 Prompt 模板（1.1.0 / 1.2.0 / 1.0.0）
│   ├── adapters/base.py          ModelSpec / GenerationRequest / BaseAdapter（统一契约）
│   ├── adapters/errors.py        6 类错误 + 重试矩阵
│   ├── adapters/gateway.py       选型→限流→重试→熔断→降级链→记账（含异步轮询 _await_result）
│   ├── adapters/registry.py      按 .env 装配适配器 + **配置体检告警**
│   ├── adapters/image/           openai_compat.py · sd_webui.py · local_poster.py（零 Key 兜底）
│   ├── adapters/llm/             openai_compat_llm.py（含推理模型空 content 自动加倍 max_tokens）
│   ├── adapters/video/           dashscope_video.py（异步 + 时长夹到 5/10s + 首帧 base64 化）
│   ├── adapters/audio/           dashscope_tts.py（音色非法自动回退）
│   ├── mock_provider.py          假厂商：图像/LLM/异步视频/TTS + 故障注入（自测用，真实配置下也在挂载）
│   ├── storage.py cost.py imaging.py   对象存储 / 账本 / ffprobe 探尺寸时长
│   └── scripts/                  verify_gateway.py · smoke_real_{skills,video,tts}.py · probe_audio_surfaces.py
├── tools/ffmpeg-bridge.ts        FFmpeg 渲染桥（Vite dev 中间件）：运镜/转场/字幕/配音混音+BGM 闪避/响度/编码
├── src/
│   ├── store/{graph,run,ui,agent,canvas}Store.ts   图 / 运行态 / UI 布局 / Agent 提案 / 多画布
│   ├── registry/                 节点注册表（新增节点类型只改这里 + specs）
│   ├── canvas/{CanvasView,QuickCreate,applyPatch,validation,topo}
│   ├── engine/
│   │   ├── mockEngine.ts         本地执行引擎 + 事件总线（seq / 断线重放）—— 也是各节点的分派处
│   │   ├── realImages.ts         图像节点 → 网关
│   │   ├── realVideo.ts          video 节点 → i2v（有视频模型）或本地动效；+ useModelStore 能力探测
│   │   ├── realText.ts           文案/分镜/提示词节点 → Skill
│   │   ├── realAudio.ts          audio 节点 → 逐镜 TTS + cues（音画对齐依据）
│   │   ├── realRender.ts         compose 节点 → 按镜头装配时间线（片段优先、绝不混占位）→ FFmpeg
│   │   ├── actions.ts            运行前预检（环/缺输入/预算闸门）
│   │   └── ffmpegBridge.ts       渲染桥客户端（健康检查 / 栅格化 / POST）
│   ├── nodes/{BaseNode,Preview,controls}.tsx   节点外壳 + 预览（图像/视频/真波形音频）
│   └── panels/{TopBar,LeftRail,Inspector,RunLogPanel,ProposalCard,AgentChat,Overlays,Resizer}.tsx
└── out/                          交付成片（*.mp4）与各类自检输出（*.txt）
```

---

## 5. 一路修掉的真实 bug（避免重复踩）

1. **applyPatch 在 immer producer 内被 structuredClone** → DataCloneError，所有编辑静默失效 → 改为 producer 外计算
2. **预算闸门用了上一轮的累计花费** → 第二次运行被自己挡住 → 改成「每次运行上限」，仅运行中计入已花
3. **单产物被写入两次**（patchRuntime + node.artifact 追加）→ 统一为「只发事件、由 reducer 累加」
4. **产物 id 冲突**（同类型节点共用默认种子）→ 按节点派生稳定种子
5. **xfade offset 公式错**（应为「前 k 段之和 − k·td」）→ 错法会把成片截断成一段
6. **loudnorm 之后才 aresample** → 否则输出 96kHz；音频必须 48kHz 立体声
7. **kind='final' 被当成端口类型** → 成片预览渲染成"未合成" → reducer 做 kind→portType 映射 + itemsOf 按结构判断
8. **compose 把真图与占位海报混用、且按帧池循环铺镜头** → 改为「每镜绑自己的关键帧/片段，有真帧就不用占位」
9. **`/mva-api` 前缀没剥掉** → 渲染桥认不出片段路径 → backendPath() 归一
10. **FastAPI + `from __future__ import annotations` + 函数内定义的 Pydantic 模型** → 被当成 query 参数（422）→ 模型必须定义在模块级（已踩两次）
11. **推理模型 content 为空**（deepseek-flash 全花在 reasoning）→ 自动加倍 max_tokens 重试 + 可操作报错
12. **非法音色**（qingxin 不在厂商许可列表）→ 逐级回退到默认音色
13. **wan i2v 只接受 5/10s**，模板写的 4s 会被拒 → 适配器夹到合法档位并按夹后计费
14. **provider 值写错会静默失效** → 现在启动打印告警 + /healthz.warnings

---

## 6. 下一步候选（按优先级，未做）

1. **画布改动进 URL**（`/w/<画布id>`）：可分享/收藏具体画布
2. **画布列表缩略图**：列表里显示小图，多画布更好认
3. **字幕策略**：现在字幕是烧死的；可改成平台原生字幕（可关闭/可改样式）
4. **多版本 A/B**：一次运行出 3 版 hook 供挑选，接 `eval_result` 做胜率统计
5. **把 mockEngine 换成真后端**：`POST /runs` + WebSocket（store 归约与事件契约都不用改），后端断点续跑 / 幂等键 / 队列落地
6. **价格表校准**：按真实账单改 `MVA_PRICE_VIDEO_SEC` 等（现在按 ¥0.45/s 记账，3 段就 ¥6.75，接近 ¥8 预算）

---

## 7. 新会话开场白模板（直接粘贴）

> 接手 `D:\vtest` 的 MVA 项目。请先读 `docs/HANDOFF.md`（含现状、服务启动方式、已验证结论、目录职责、已修 bug、下一步候选），
> 再按需读 `docs/phase-1..9-*.md`。现状：全真实链路已跑通（qwen-image-3.0 + qwen3.8-flash + wan2.2-i2v-plus + qwen3-tts-flash + 本地 FFmpeg）。
> 本次要做的是：**<在这里写你的需求>**。约束：不要重复实现已有能力；改完要跑 `npx tsc --noEmit`、`npm test`、`npm run build`；涉及网关的改动跑 `npm run verify:gateway`。
