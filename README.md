# MVA · 营销视频工作流画布（Demo）

> AI 营销视频智能体的**可视化工作流节点界面** —— 对应设计文档 `docs/phase-5-frontend-canvas.md`。
> 四条腿全部打通：①**编排层**（画布/补丁/调度/事件流）②**模型网关**（适配器层，真 HTTP + 限流重试降级 + 成本账本）
> ③**合成层**（本地 FFmpeg 真出片，含运镜/转场/字幕/响度）④**配音**（TTS 逐镜合成 + BGM sidechain 闪避）。

---

## 全真实链路实测（用真实厂商 key）

**字号整体放大**（原来的 10px 基线在 1080p 上久看很累）：

| 位置 | 原 | 现 |
|---|---|---|
| 段落小标题 `.eyebrow` / 时间码 `.tc` | 10px | **12px** |
| 节点参数、日志、表格 | 10.5px | **12.5px** |
| 节点标题 / 面板标题 | 12.5px | **14.5px** |
| 正文/输入框 | 11.5px | **13.5px** |

同时放大了配套尺寸：顶栏 52→60px、左栏 248→268px、右栏 300→330px、日志面板 186→230px、节点卡 320→352px、端口方块 11→13px。

**面板可随意伸缩**：三条可拖拽分隔条（左栏 / 右栏 / 底部日志），拖动即改、**双击恢复默认**、尺寸存 localStorage；
左右栏还能整体折叠（折叠后在画布角落出现「▸ 侧栏」「◂ 检查器」按钮）。范围：左栏 200–480px、右栏 260–560px、日志 120–520px。

**多画布**：左栏顶部「画布」列表 —— 新建（空白 / 套用任一模板）、切换、复制、双击重命名、删除、导出/导入 JSON。
每张画布是**独立的图 + 独立的运行态快照**（节点状态、日志、花费都跟着画布走），来回切换不丢进度，全部持久化到 localStorage（刷新后仍在）。
运行中的画布不允许切换（执行引擎按节点 id 写运行态，中途换图会串台），会明确提示。

| 快捷键 | 作用 |
|---|---|
| `Cmd/Ctrl + Shift + N` | 新建画布 |
| `Cmd/Ctrl + S` | 保存当前画布快照 |
| `Cmd/Ctrl + Z / Shift+Z` | 撤销 / 重做（含整批撤销 Agent 提案） |
| `Cmd/Ctrl + G` · `D` · `Delete` · `F` | 打组 · 复制节点 · 删除 · 适配视图 |

---


| 环节 | 适配器 · 模型 | 实测 |
|---|---|---|
| 文案 / 分镜 / 提示词编译 | `llm-openai-compat` · `qwen3.8-flash` | 3 版文案 + 6 镜分镜（字幕即文案）+ 一致性词典，¥0.05 |
| 关键帧 | `openai-compat` · `qwen-image-3.0` | 6/6 真实出图，1080×1920，**约 60s/张**，¥0.06/张 |
| 视频片段（i2v） | `dashscope-video` · `wan2.2-i2v-plus` | 3 段真片段 5.0s/1072×1920，**53s/段**（轮询 11 次），¥2.25/段 |
| 配音（逐镜） | `dashscope-tts` · `qwen3-tts-flash` | 6 段逐镜语音，各自落在**自己镜头的起点**，¥0.0009 |
| 合成导出 | `ffmpeg(local)` | 17.5s / 1080×1920 / h264 High + AAC-LC 48kHz 立体声，**-14.6 LUFS / -1.4 dBTP** |

**一次全量运行：342s（5.7 分钟）· ¥7.30**（6 图 + 3 段 i2v + LLM + TTS + 合成）。
成品：`out/demo-full-real.mp4`（12.96 MB，画布 `合成导出` 节点内可直接播放）。

**人声确实入片的客观证据**（高通 1kHz 后的电平，人声是宽带信号、合成 BGM 全在 400Hz 以下）：
```
混音版(片段+配音+BGM)  mean=-24.6 dB   max=-3.4 dB
仅 BGM 版(无配音)      mean=-39.8 dB   max=-28.6 dB   → 差 15 dB
```


---

## 快速开始

```bash
npm install
python -m pip install -r apps/api/requirements.txt   # 模型网关依赖（FastAPI/Pillow/httpx）
npm run api            # 终端 A：模型网关 → http://127.0.0.1:8010
npm run dev            # 终端 B：画布 + FFmpeg 渲染桥 → http://localhost:5173
npm test               # 24 个前端纯核心单测
npm run verify:gateway # 网关行为验证（23 项：重试/降级/阻断/记账）
```

前置：**ffmpeg / ffprobe**（`ffmpeg -version` 可跑）。网关不起也能用——图像节点会回退到占位画面并明确标注。

---

## 第 2 步：模型网关（适配器层）—— 已落地

### 一次性看清「谁在生成图片」

点「运行全部」，图像节点的行为是：

```
image 节点 → 前端 /mva-api/api/v1/images/generate（Vite 同源代理）
   ↓
模型网关（FastAPI）
   ① 选型    按 capability + quality_tier + 预算 + 健康度 从注册表挑适配器
   ② 限流    按 rpm 令牌桶 + 并发信号量（超限降速重排，不是失败）
   ③ 调用    适配器.submit() → HTTP → 厂商
   ④ 重试    429/5xx 指数退避；402/鉴权失败 → 自动切同能力备用厂商
   ⑤ 归一    厂商错误码 → 6 类（transient/rate_limited/quota/content_blocked/invalid/fatal）
   ⑥ 落盘    b64/URL → 内容寻址对象存储（sha256，天然去重）
   ⑦ 记账    每次调用（含失败）写 cost_ledger，前端按返回的真实成本显示
   ↓ { artifacts:[{url,width,height,digest}], meta:{adapter,model,cost_cny,latency_ms,retries,degraded} }
画布：节点里出现真实图片，并挂上 `REAL · <adapter>` 徽标；节点页脚显示真实适配器/耗时/花费
```

### 三个适配器（换厂商 = 改 .env 三个变量）

| 适配器 | 用途 | Key | 状态 |
|---|---|---|---|
| `openai-compat` | **任意 OpenAI 兼容厂商**：OpenAI / 通义万相 / 火山方舟豆包 / 硅基流动 / 智谱… | 需要 | 已实现并验证 |
| `sd-webui` | 本地 AUTOMATIC1111 / SD.Next（`--api`），零 Key、零费用，需 GPU | 不需要 | 已实现（`probe()` 自动探测，未运行则剔除） |
| `local-poster` | Pillow 渲染占位画面，**明确标注"非 AI 生成"**；作为降级链最后一环 | 不需要 | 已实现，默认兜底 |
| `mock-provider`（`/mock-provider/*`） | **自测用假厂商**：OpenAI 兼容形状 + 故障注入 | 不需要 | 已实现，仅用于验证 |

切到真实厂商（改完重启网关即可，**代码零改动**）：

```bash
# .env（从 .env.example 复制）
MVA_IMAGE_PROVIDER=openai
MVA_IMAGE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1   # 或厂商 base_url
MVA_IMAGE_API_KEY=sk-xxxx
MVA_IMAGE_MODEL=wanx2.1-t2i-turbo
MVA_PRICE_OPENAI=0.06        # 单价（¥/张），用于成本账本与预算闸门
```

### 无 Key 如何验证「真实厂商路径」

`npm run verify:gateway`（**23 项全过**）把网关指向自带的假厂商，用真 HTTP 走完整链路并注入故障：

| 场景 | 断言 |
|---|---|
| 正常路径 | 2 张图、`adapter=openai-compat`、尺寸 1080×1920、b64 解析、落盘、¥0.12 记账、产物可 HTTP 取回且 PNG 文件头正确 |
| 429 限流 ×2 | 自动重试 3 次后成功，重试轨迹可观测 |
| 5xx 连续失败 | **自动切备用适配器**（`degraded=true`），仍出图，成本随之归零 |
| 402 配额不足 | 同样切备用适配器 |
| 400 审核拒绝 | 归类 `content_blocked`，**不重试、不降级**，厂商只被调用 1 次 |
| 成本账本 | 按适配器汇总调用数/失败数/花费 |

### 实测（本机，`mock-openai` 走真 HTTP）

画布全量运行 **18.2s**：3 个图像节点拿到 **6 张真实 PNG**（1080×1920，88KB/张，`meta.real=true`），
节点徽标显示 `REAL · openai-compat`；随后 FFmpeg 用这些真实 PNG 出片 → **17.3s / 1080×1920 / 2.17MB / 可播放**；
网关账本 21 条记录、累计 ¥0.60（含故障注入产生的失败记录）。

### 真 key 实测（qwen-image-3.0）

`6 镜模板`全量运行 **118s / ¥0.72**：6 个图像节点各出一张真实关键帧（¥0.06/张，**单张约 60s**），
3 个 video 节点各出一段**真 MP4 片段**（本地 FFmpeg，¥0.05/段），合成节点把 **3 段片段 + 3 段关键帧动效**
拼成 17.3s / 1080×1920 / 8.2MB 成片，字幕来自分镜（libass + Microsoft YaHei 已确认解析成功）。

---

## 视频是怎么来的：三条路，别混为一谈

| 路线 | 画面运动来源 | 现在状态 | 需要什么 |
|---|---|---|---|
| **A 本地静图动效（T-C）** | FFmpeg `zoompan` 推拉摇移 + xfade 转场 | ✅ **已实现**（video 节点与 compose 都走这条） | 无需任何模型，¥0.05/段 |
| **B 文生图 + 动效** | 真实 AI 关键帧 + 本地运动 | ✅ **已实现**（`qwen-image-3.0` 出图 → FFmpeg 运动） | 一个图像模型（已有） |
| **C 图生视频 i2v（T-A/T-B）** | **模型生成的画面运动** | ⏳ 待接线（适配器形状已定，`submit→task_id→轮询/回调→片段URL`） | **视频模型 key**：阿里 wan2.2-i2v / 可灵 Kling / 即梦 Seedance / Vidu 任一 |

> `qwen-image-3.0` 是**文生图**模型——它只出静态图。要"AI 生成的运动"，必须有视频模型（路线 C）。

### 目标 → 落地顺序

| 步骤 | 状态 | 说明 |
|---|---|---|
| 图像真实化 | ✅ 已完成 | `openai-compat` 适配器 + `qwen-image-3.0` |
| 合成真实化 | ✅ 已完成 | 本地 FFmpeg：多段拼接 / 静帧动效 / 字幕 / BGM / 响度 |
| 片段真实化 | ✅ 已完成 | video 节点用真实关键帧渲出真 MP4 片段，compose 优先拼接片段 |
| i2v 真实化 | ⏳ 需视频模型 key | 新增一个异步 video 适配器即可，其余不动 |
| 文案/分镜真实化 | ⏳ 需 LLM key | 同样是 OpenAI 兼容形状的 chat completions 适配器（现在仍是规则版 mock） |
| 配音真实化 | ⏳ 需 TTS key | TTS 适配器 + sidechaincompress 闪避（链路已留） |



---

## 真实出片（本地 FFmpeg，零 API）

点「运行全部」，跑到 `合成导出` 节点时会发生这几件事：

```
浏览器侧：把上游关键帧（SVG）在 canvas 上栅格化成 1080×1920 PNG
   ↓ POST /api/render（同源，dev server 中间件）
FFmpeg 侧：
   ① 逐镜头 Ken Burns 运镜   zoompan（推近/拉远/左右平移，2x 超采样避免糊）
   ② 镜头拼接               xfade 叠化/滑动/推近（或 concat 硬切）
   ③ 烧录字幕 + AI 标识      libass（ASS，自动避开平台 UI 遮挡区）
   ④ 音轨                   aevalsrc 合成 BGM + 淡入淡出 + EBU R128 响度归一(-14 LUFS)
   ⑤ 编码                   libx264 High / CRF20 / 30fps / yuv420p / +faststart，音频 AAC-LC 48kHz 立体声
   ↓ 返回 /renders/<job>/out.mp4（带 Range，可拖动进度条）
画布：合成节点内出现一个**真的播放器**，标签显示 `REAL MP4 17.3s · 1080×1920 · 1.45MB`
```

**实测数据**（本机 ffmpeg 8.1.1，示例图 6 镜头 / 17.3s）：渲染耗时 ~7s，输出 1.46 MB，519 帧，
`ffprobe` 复核：`h264 High 1080×1920 30fps 519帧 17.3s` + `aac LC 48kHz stereo`，
响度 `-14.2 LUFS / -3.8 dBTP`；9 个时间点抽帧 md5 **互不相同**（证明画面真的在动、转场真的生效）。

产物位置：`.mva-renders/<job>/out.mp4`（保留最近 20 个），交付样例：`out/demo-final.mp4`。
节点日志里会打印**完整的 ffmpeg 命令行**，可直接复制到终端复现。

**为什么把桥挂在 Vite dev server 上**：同源零 CORS、不额外占端口/进程、生产构建不包含（`apply:'serve'`）。
真实产品里这一段属于后端 `RenderService`（`docs/phase-4 §4.10`、`docs/phase-6 §6.10`）——本桥就是它的最小可用替身，接口形状一致。

**这算不算"生成视频"**：算"合成出真视频"，不算"AI 生成内容"。当前画面来自 Mock 占位帧 + 真实运镜；
一旦上游换成真实模型产出的 JPEG / 视频片段，这条链路一行不用改（改的是取帧来源）。

---


## 五分钟演示脚本

| # | 操作 | 看点 |
|---|---|---|
| 1 | 点 **运行全部** | 节点按拓扑分层依次 `QUEUED → RUNNING(进度条) → DONE`，底部日志逐行滚动，成本条与顶部时间码同步走动 |
| 1b | 等跑到 `合成导出` | **真的用 FFmpeg 出片**：节点里出现可播放的 MP4（17.3s / 1080×1920），日志里有完整 ffmpeg 命令行 |
| 2 | 看**胶片格预览** | 图像节点内联缩略图（多张可左右切换）、视频节点内联播放器（点击播放）、音频节点波形、质检节点 5 维分数条 |
| 3 | 拖动画布 / 滚轮缩放 / 按 **F** | 无限画布；右下缩略图看全貌；左上角是端口类型图例 |
| 4 | 双击空白 → 输入 `img` 回车 | 搜索式建节点；或从左侧「节点」面板**拖入**画布 |
| 5 | 把 `音频` 节点的 `out` 拖到 `图像` 节点的 `prompt` | **类型不匹配被拒绝**并给出原因；再把 `图像.out` 拖到 `视频.first` 则允许（静图可作 i2v 首帧） |
| 6 | 选中 2 个以上节点 → **Ctrl/Cmd+G** | 打组；再点右侧「存为模板」 |
| 7 | 左侧**模板库**点任一张 | 一键实例化整条流水线（含分组，可整体拖动） |
| 8 | 在右下 **Agent** 输入「太贵了，便宜点」 | 生成**提案卡**：改动清单 + 成本增量 + 风险等级 + 「幽灵预览」；点「接受并应用」→ **Ctrl/Cmd+Z 整批撤销** |
| 9 | 点节点工具条的 🐞（注入故障）→ 运行全部 | **单点失败不阻塞无关分支**（其他节点照跑），run 变 `partial`；点该节点「重试」→ 恢复 `DONE` |
| 10 | 点顶部 **WS #N** 按钮（断线演练）→ 运行全部 → 再点一次 | 断线期间 UI 停在 `queued`；重连后按 `since` **补发全部缺口事件**，界面瞬间追平 |
| 11 | 把顶部预算改成 `1` → 运行全部 | **预算闸门**拦截运行并弹窗给出三条出路（不产生任何费用） |
| 12 | 导出 JSON → 清空 → 导入 | 图结构完整往返 |

---

## 已实现（对照设计文档）

**画布与交互**
- 无限画布：缩放/平移/框选/多选/吸附（8px 网格）/对齐参考；`onlyRenderVisibleElements` 性能优化
- 双击空白 → 搜索式新建节点；外部图片/视频/音频**拖入即建节点**（用 `URL.createObjectURL` 真实预览）
- 节点：折叠/展开、标题内联改名、锁定（Agent 不可改）、禁用（跳过执行）、复制、删除
- 浮动工具条（运行/重试/锁定/复制/打组/禁用/注入故障/删除）
- 键盘：`Cmd+Z` / `Cmd+Shift+Z`、`Cmd+G` 打组、`Cmd+D` 复制、`Delete`、`Cmd+S`、`F`、`Esc`

**节点体系（注册表驱动，约束 8）**
- 8 类节点：文本 / 图像 / 视频 / 音频 / 脚本 / 提示词编译 / 质检 / 合成导出
- `registry/index.ts` 是唯一注册点；新增一种节点 = 写一个 `NodeTypeSpec`（端口 + 参数声明 + Body 组件）+ `register()`，**画布核心、校验、调度、Inspector 全部零改动**
- 参数表单由 `spec.fields` **声明式生成**（Inspector 与节点内联控件同源），等价于设计里的 Zod schema 单一真相源

**数据流与校验**
- 端口类型矩阵（text/image/video/audio/json/any）；`video` 可接 `image`（静图动效/i2v 首帧）
- 校验：类型匹配、环检测、端口占用（替换）、锁定节点拒改、真人素材未授权 → 仅 warn
- 输入解析优先级：**用户钉住值 > 上游产物**；「钉为输入」按钮写在 `pinnedInputs`
- `stale` 传播：撤销/改参数后下游节点变黄 `STALE`，提示可重跑

**执行引擎（前端部分）**
- `buildPlan()` Kahn 拓扑排序 + **分层**（右侧 Inspector 与底部「执行计划」页签可视化）
- 分层并行执行、进度事件、单节点运行、子图运行（自动补全上游）、取消、单点重试
- 运行前预检：环 / 缺必需输入 / 预算闸门（与后端 `create_run` 校验顺序一致）
- 事件流带 `seq`，支持**断线重连按 since 补发**（本地总线等价替代 WebSocket，接口与设计一致）

**人机协同（约束 10）**
- Agent 只产出 `GraphPatch`（不直接改图），画布与 Agent 共用同一份图与同一套补丁类型
- 提案卡：人类可读的改动清单 + `Δ成本` + 风险等级 + 幽灵预览（不落图）；可整批撤销

**持久化**
- 导出/导入工作流 JSON；UI 状态与运行态分离（`graphStore` / `runStore` / `uiStore` / `agentStore`）

---

## 与设计文档的差异（本 Demo 的边界）

| 设计中的能力 | Demo 现状 |
|---|---|
| 后端执行引擎、队列、断点续跑、幂等键 | 由 `engine/mockEngine.ts` 本地模拟（同样分层调度 + 事件流），**接口对齐**，可替换为真实 `POST /runs` + WS |
| **合成导出** | ✅ **已接真实 FFmpeg**（`tools/ffmpeg-bridge.ts`），产出可播放 MP4；仅缺「多段真实视频片段的 trim/调速/音画对轨」 |
| 真实模型调用（图像/视频/语音） | ❌ 仍是 Mock：产物为本地 SVG 胶片格；骨架已按 `BaseAdapter` 形状写好（`submit/poll/fetch/estimate_cost/normalize_error`），接真实厂商只需补 adapter |
| 音轨 | FFmpeg 合成的真实 BGM；**配音仍是占位**（接 TTS 后走 sidechaincompress 闪避，链路已留） |
| Patch 三方合并 / 多人协作 | 仅实现快路径（应用 + 逆操作撤销）；三方合并算法见 `docs/phase-6 §6.3` |
| 模板版本管理 / 模板库持久化 | 内置 3 个模板可实例化；「存为模板」写 localStorage，未做服务端版本表 |
| 变量抽取与模板实例化表单 | 模板变量使用默认值，未做填写表单 |
| 视觉回归 / E2E | 已留 `data-testid`（`node-{id}`、`palette-{type}`、`agent-input`…）与 `window.__mva`（dev only）句柄，Playwright 用例见 `docs/phase-8 §8.4` |

---

## 目录结构

```
src/
├── types/{graph.ts, events.ts}      # 工作流 DSL 与 WS 事件契约（与后端同构）
├── registry/
│   ├── nodeRegistry.ts              # 注册表（唯一扩展点）
│   ├── index.ts                     # 8 类节点的注册入口
│   └── specs/{basic.tsx, pipeline.tsx}
├── canvas/
│   ├── CanvasView.tsx               # React Flow 装配 + 交互 + 快捷键
│   ├── QuickCreate.tsx              # 双击空白的新建菜单
│   ├── applyPatch.ts                # applyPatch / invertOps（纯函数，前后端同构）
│   ├── validation.ts                # 类型矩阵 + 连线校验
│   └── topo.ts                      # 拓扑分层 + stale 传播
├── nodes/{BaseNode.tsx, Preview.tsx, controls.tsx}
├── edges/TypedEdge.tsx              # 端口配色 + 运行中引线动画 + stale 虚线
├── store/{graph, run, ui, agent}Store.ts
├── engine/
│   ├── mockEngine.ts                # 本地执行引擎 + 事件总线（seq / 断线重放）
│   ├── mockArtifacts.ts             # SVG 胶片格产物（图像/视频/音频/质检报告）
│   ├── realRender.ts                # ⭐ 真实合成：取帧 → 栅格化 → 交给 FFmpeg
│   ├── ffmpegBridge.ts              # ⭐ 渲染桥客户端（健康检查 / 栅格化 / POST）
│   ├── mockAgent.ts                 # 一句话 → GraphPatch（规则版规划器）
│   ├── actions.ts                   # 运行预检 / 启动 / 取消
│   └── bridge.ts                    # 事件 → store 归约（真实环境的 WS 客户端位）
├── panels/{TopBar, LeftRail, Inspector, RunLogPanel, ProposalCard, AgentChat, Overlays}
└── data/templates.ts                # 3 个内置工作流模板
tools/ffmpeg-bridge.ts               # ⭐ FFmpeg 渲染桥（Vite dev 中间件，dev-only）
tests/pure.test.ts                   # 24 个纯核心单测
```

---

## 设计取向（为什么长这样）

- **母题**：剪辑调色棚。深暖炭底 + 骨白卡片 + 片头琥珀；连线用「引线」，状态与耗时用**时间码**，预览区做成**胶片格（齿孔 + 三分线 + 角标）**。
- **唯一的强调色只用在「正在发生的事」上**：运行中脉冲、进度、成本预警、Agent 提案。
- **端口颜色是功能色**，不是装饰：text 灰 / image 蓝 / video 紫 / audio 绿 / json 琥珀。
- **克制**：画布之外的面板一律安静（细边框、等宽小字、无渐变），把注意力让给卡片与连线。

---

## 已知取舍

1. `formatCny` 对小于 1 分钱的成本显示 4 位小数，是为了让「静图动效几乎免费」这件事在界面上看得见。
2. 示例图的镜头时长来自分镜（`total_duration_s / shots`），6 个镜头各 3.3s，5 次 0.5s 叠化 → 成片 17.3s；
   产物 `meta` 里如实记录 `shots` / `size_bytes` / `file` / 响度 / AI 标识。
3. `mockEngine` 用「分层屏障」简化并发（真实后端用依赖计数事件驱动，见 `docs/phase-6 §6.5.2`）。
4. 渲染桥是 dev-only：生产构建不含它（`apply:'serve'`），线上应替换为后端 `RenderService`。
5. 渲染期间合成节点的进度条停在 100%（真实编码进度需要解析 ffmpeg 的 `-progress` 输出，属下一步）。

---

## 下一步（把"合成"之外的环节也变真）

| 步骤 | 做什么 | 产出 |
|---|---|---|
| **2** | 接 1 个真实**文生图** adapter（`BaseAdapter` 子类）+ 一个只做 `POST /runs` / `/webhooks` 的最小 FastAPI 后端 | 真实画面 + 本地 FFmpeg = **可发布的 MP4**，成本约 ¥0.3–0.8/条 |
| **3** | 接 1 个**视频生成** adapter（i2v，异步 + 回调）+ 对象存储 + 队列 | 真实运镜，按 ¥8 预算做镜头分级配比 |
| **4** | 接 **TTS**（或本地 CosyVoice/Piper），音轨走 sidechaincompress 闪避 | 真配音 + 真字幕对齐 |
| **5** | 换掉 `mockEngine`：`POST /runs` + WebSocket（store 归约与事件契约都不用改） | 真后端、断点续跑、幂等键落地 |
