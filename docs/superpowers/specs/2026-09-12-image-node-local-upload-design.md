# 图像节点本地上传 —— 设计文档

- 日期：2026-09-12
- 范围：`D:\vtest`（MVA 画布 Demo）
- 状态：已确认，待实现
- 关联：HANDOFF §6 下一步候选之外的独立小项

---

## 1. 问题陈述

**用户原始描述**：「图像是可以拖进去，但是无法本地上传图片。」

**实测现状**（有代码证据）：

| 能力 | 状态 | 证据 |
|---|---|---|
| 拖文件到画布空白处 → 建媒体节点 + 立即显示 | **可用** | `src/canvas/CanvasView.tsx:202-258` |
| 在**图像节点内**选择本地文件上传 | **不存在** | `src/registry/specs/basic.tsx:118-159` Body 只有 textarea + tier Segmented |

图像节点的 Body 没有任何文件输入控件。用户要上传本机图片，唯一路径是「把文件从资源管理器拖到画布**空白处**」——这既不可发现（无任何提示 UI），也不在节点上（用户预期在节点里传图），且拖到已有节点上会被 React Flow 当成拖动而非文件投放。

节点自身的空态文案写着「运行生成或**钉入参考图**」（`basic.tsx:132`），暗示节点内本应有传图入口 —— 该入口从未实现。

---

## 2. 目标与非目标

### 目标
在图像节点内提供「本地上传」入口（点击选文件），行为与拖入画布**完全一致**：上传的图成为该节点的**产物**（`outputs.out`），可立即预览，并可作为上游供下游节点（i2v / compose）消费。

### 非目标（本次明确不做）
- **不做 I2I**：节点声明的 `ref` / `refs` 参考图端口仍不接模型（保持现状的「死端口」）。`refStrength` 滑块亦然。
- **不做后端上传接口**：不新增 `POST /api/v1/assets`。
- **不覆盖视频 / 音频节点**：本次仅图像节点。（架构上抽出的公共函数可复用，留待后续。）
- **不做版权/肖像授权留痕**：需求 `phase-1 A7`（上传即勾选授权 + 落 `consent_record`）未纳入本次，与拖入现状一致地缺失。

---

## 3. 核心设计判断

### 3.1 真问题是重复代码，不是缺功能

拖入画布的文件分支（`CanvasView.tsx:202-258`）已经实现了「File → ArtifactRef → patchRuntime → group → toast」的完整链路。若在节点内**复制一份**，就会产生两份必须同步维护的实现 —— 这正是 HANDOFF §5 记录的反复出问题模式（applyPatch 双写、产物 id 冲突等）。

**决定**：抽出唯一实现，两个入口共用。

### 3.2 上传语义 = 节点产物（已与用户确认）

图像节点的视觉元素「上传的图」有两种可能语义：

- **(A) 作为节点产物** —— 与拖入画布行为一致，下游可直接用。
- (B) 作为 `ref` 参考图，跑 I2I 生成新图。

用户选择 **(A)**。理由：与既有拖入行为一致、改动最小、风险最低；且 (B) 需要后端上传接口 + 适配器传 `image` 字段，属独立工作。

---

## 4. 架构与组件

### 4.1 新增 `src/canvas/localImport.ts` —— 单一真相源

两个入口需求不同，故**三个函数**，其中「File → ArtifactRef」是唯一共享的真相源：

```ts
/** ① File → ArtifactRef（不触网，纯前端）。两个入口共用，是可纯测的核心。 */
export function artifactFromFile(
  file: File,
  nodeId: string,
  urlOverride?: string,          // 测试注入用；默认 URL.createObjectURL(file)
): { kind: 'image' | 'video' | 'audio'; artifact: ArtifactRef };

/** ② 把一个本地文件写进【已存在】节点的产物（节点内「本地上传」按钮用） */
export function attachLocalFile(nodeId: string, file: File): void;

/** ③ 批量导入并【新建】节点 + 归组 + toast（画布拖入用） */
export function importLocalFiles(files: File[], origin: { x: number; y: number }): void;
```

> **为什么必须分开 ② 与 ③**：节点内的上传按钮必须写入**用户点击的那个节点**，绝不能新建节点。若节点按钮误用 ③，会在画布上凭空多出一个节点，而原节点仍然空的 —— 这正是本节要避免的实现错误。

**② `attachLocalFile`**：`artifactFromFile` → `useRun.getState().patchRuntime(nodeId, { status:'success', outputs:{ out:{ type:kind, items:[artifact] } }, runMeta:{ attempt:1, latencyMs:0, costCny:0, adapter:'local-upload', model:'—' } })` → 可选 `applyGraph([{ op:'update_node_params', node_id:nodeId, params:{ uploadedName: file.name } }])` 以便刷新后仍知道原文件名 → `toast`。

**① `artifactFromFile`** —— 两个入口共用的唯一实现，只做「File → ArtifactRef」这一件事：
- `kind` 由 `file.type` 前缀判定：`video/*` → video，`audio/*` → audio，其余 → image
- `mime: file.type || 'application/octet-stream'`
- `url` / `thumbUrl`：`urlOverride ?? URL.createObjectURL(file)`
- `id: art_up_${nodeId}_${file.size}`（按节点 + 体积派生，避免多个上传互相撞 id —— HANDOFF §5 第 4 条记录过产物 id 冲突）
- `digest: local-${file.size}`，`meta: { uploaded: true, size: file.size, portrait: false }`

**③ `importLocalFiles` 的细节**，等价于 `CanvasView.tsx:205-258` 的搬迁，保持既有行为不变：
- `nodeRegistry.get(kind)` 取 `defaultParams` 建节点，label 取文件名前 18 字符，落点 `{ x: base.x + i*40, y: base.y + i*40 }`
- 对每个文件走 ①，再 `useRun.getState().patchRuntime(新id, { status:'success', outputs:{ out:{ type:kind, items:[artifact] } }, runMeta:{ attempt:1, latencyMs:0, costCny:0, adapter:'local-upload', model:'—' } })`
- `applyGraph([{ op:'add_node', node }, { op:'group', group_id:'g_media', node_ids:[新id], label:'我的素材' }], '导入素材')`
- `useUi.getState().toast('success', \`已导入素材 ${file.name.slice(0,20)}（L1 审核通过）\`)`

**依赖方向说明**：`localImport.ts` 位于 `src/canvas/`，直接读写 store（`useRun` / `useUi` / `useGraph`）。这与既有分层略有出入（`registry/types.ts:25` 注明「spec 不直接依赖 store」），但该规则针对的是 **spec Body 的参数写回约定**（必须走注入的 `setParam` 以进 undo 栈）；`localImport` 是画布/交互层代码，`CanvasView` 本身即直接使用 store，故一致。节点 Body 内的按钮调用 `attachLocalFile`（而非自己拼 store 调用）来遵守同一约定。

### 4.2 修改 `src/canvas/CanvasView.tsx`

`onDrop` 中：
- **保留**：`application/mva-node` 分支（节点类型拖入，第 178-200 行）
- **替换**：文件分支（第 202-258 行）→ `importLocalFiles(files, base)`，其中 `base = screenToFlowPosition({ x: event.clientX, y: event.clientY })`

净效果：`CanvasView.tsx` 自身**减少约 55 行**（实现搬迁到 `localImport.ts`，新增文件约 55 行）；因两个入口共用，相比复制方案净省一份实现。

### 4.3 修改 `src/registry/specs/basic.tsx` —— 图像节点 Body

在预览区与提示词 textarea 之间插入上传入口：

- 隐藏 `<input type="file" accept="image/png,image/jpeg,image/webp" multiple />`，用 `useRef` 触发
- 按钮：`Upload` 图标（lucide-react 已装）+ 文案「本地上传」；无产物时更醒目，已有产物时作为「换一张」
- 变更处理：`Array.from(e.target.files ?? [])` → 逐个 `attachLocalFile(id, file)`（**只用 ②，不建节点**）；随后 `e.target.value = ''` 以便重复选同一文件
- `onPointerDown={(e) => e.stopPropagation()}` 防拖动干扰（沿用既有 textarea 写法）
- 上传后 `status` 置 `success`、`adapter` 标 `local-upload`，与拖入一致
- 位置无需传给 `attachLocalFile`（写的是既有节点，不涉及落点）—— 这消除了 ③ 在节点内使用时的 `origin` 来源问题

---

## 5. 数据流

```
[节点内「本地上传」按钮] ──▶ attachLocalFile(nodeId, file)      ┐
                                                              ├─▶ File → artifactFromFile()
[拖文件到画布] ──────────▶ importLocalFiles(files, origin)     ┘        （唯一共享实现）
                                                                          │
                                                        URL.createObjectURL(file) ← 纯浏览器内存，不触网
                                                                          ▼
                                                            blob:http://localhost:5173/xxxx
                                                                          │
                                              ArtifactRef{ url, mime, digest, meta:{uploaded:true} }
                                                                          │
                                    路径②：patchRuntime(既有 nodeId)  ┐
                                    路径③：add_node(新 id) + patchRuntime(新 id) ┘
                                                                          │
                    ┌─────────────────────────────────────────────────────┤
                    ▼                                                     ▼
   节点内 <img src={blob}> 立即显示                        下游经 mockEngine.resolveInputs()
   （ImagePreview 原生支持 blob URL）                      （mockEngine.ts:107）拿到该 artifact
```

---

## 6. 错误处理与边界

| 情形 | 处理 |
|---|---|
| 用户取消选择 | `files` 为空 → 直接 return，无副作用 |
| 非图片文件（如 .txt） | 隐藏 input 已 `accept` 过滤；拖入路径按 mime 兜底归为 `image`（与现状一致） |
| 空 mime（部分系统） | `file.type \|\| 'application/octet-stream'`，kind 归 image（与现状一致） |
| 重复选同一文件 | 选后重置 `input.value = ''` |
| `createObjectURL` 泄漏 | 与现状一致**不回收**。节点删除时不 revoke —— 本次不引入新泄漏面，但也不修复既有面 |

---

## 7. 测试策略

现有测试全部为纯函数（`tests/pure.test.ts`，25 例）。本特性主体是 UI 交互 + 浏览器 API，可纯测的部分是 `artifactFromFile`。

**新增用例**（新增 `tests/localImport.test.ts`）：
1. `image/jpeg` → `kind='image'`，`mime='image/jpeg'`
2. `image/png` → `kind='image'`
3. `video/mp4` → `kind='video'`
4. `audio/wav` → `kind='audio'`
5. 空 mime → `kind='image'`，`mime='application/octet-stream'`
6. `digest` 对同一文件稳定（`local-<size>`）
7. `meta.uploaded === true`

`artifactFromFile` 需接受最小 `File` 形状（`{ name, size, type }`）以便在 node 环境测试 —— 实现只读这三个字段 + `URL.createObjectURL`。**为使测试无需真实 `File`/`URL.createObjectURL`，`artifactFromFile` 接受可选的 `urlOverride` 注入参数**（默认 `URL.createObjectURL(file)`）—— 避免为测试引入 jsdom 依赖。

**手动验证**（UI 部分，不产生费用）：
1. `npm run dev` → 拖一个图像节点到画布 → 点「本地上传」→ 选一张本机 PNG → 预览立即出图
2. 再点一次选另一张 → 预览替换（而非新增第二个节点 —— 验证用的是 ② 不是 ③）
3. 从资源管理器拖一张图到画布空白处 → 仍照旧新建节点（回归验证 ③）
4. 刷新页面 → 观察 §8 第 1 条行为（图丢失，属已知边界）

**可选**（产生真实费用 ¥2.25／段，需网关在线）：把上传图连到 video 节点 `first` 端口跑一次 i2v —— 预期**失败**，正是 §8 第 2 条记录的原因。此项不必执行，仅用于确认边界描述准确。

---

## 8. 已知边界（明确不解决）

1. **刷新后上传图丢失**
   `canvasStore.ts:123-129` 把 `graph` 与 `runtime` 一并持久化到 `localStorage`，`loadFromStorage`（第 106-121 行）恢复。但 `blob:` URL 是会话级的，刷新后失效 → 预览破图、下游取不到真字节。
   **与拖入现状一致**，本设计不加重也不修复。
   真正修复需后端上传接口：`storage.save_bytes()` 已具备内容寻址（sha256）能力，只缺一个 `POST /api/v1/assets` 路由。

2. **上传图不能作为 i2v 首帧**
   `realVideo.ts:97` 传 `backendPath(first.url)`，而 `backendPath`（`realVideo.ts:54-56`）只做 `url.replace(/^\/mva-api/, '')` —— 对 `blob:` URL 原样返回。厂商侧 `to_vendor_ref`（`dashscope_video.py:49-65`）只认 `data:` / `http` / `/assets/` 三种，`blob:` 落空 → 厂商收到无法解析的 URL。
   **根因与第 1 条相同**（缺上传接口）。生成图当首帧**不受影响**（它有真实 `/assets/...` URL，HANDOFF §3 已验证跑通）。

3. **无版权/肖像授权留痕**
   需求 `phase-1 A7` 要求「上传即勾选授权 + 落 `consent_record`」。拖入现状没有，本设计也没有。`meta.portrait` 硬编码 `false`。

**第 1、2 条同根因，建议作为下一个独立任务**：新增 `POST /api/v1/assets`（复用 `storage.save_bytes`）→ 前端上传即落盘为 `/assets/...` → 刷新不丢 + 可作 i2v 首帧。

---

## 9. 验收标准

1. `npx tsc --noEmit` 通过
2. `npm test` 通过（原 25 例 + 新增 ≥7 例）
3. `npm run build` 通过
4. 未改网关 → 无需跑 `npm run verify:gateway`；但**不得**破坏其既有 55/55（本设计零后端改动，风险为零）
5. 手动：图像节点内可点选本机图片并立即预览；再选可替换（不新建节点）
6. `CanvasView.tsx` 拖入行为回归不变（共用 ①③，行为等价）
7. **无重复实现**：`kind`/`mime` 判定与 ArtifactRef 构造只存在于 `artifactFromFile` 一处；两入口均调用它（这是本设计的主要收益，优先于行数）
