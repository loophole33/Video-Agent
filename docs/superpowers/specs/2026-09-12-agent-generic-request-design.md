# Agent 通用生成需求支持 —— 设计文档

- 日期：2026-09-12
- 范围：`D:\vtest`（MVA 画布 Demo）
- 状态：待实现
- 触发：用户反馈「和 Agent 对话生成『小男孩在雨中奔跑的视频』，工作流搭好了，但生成的视频完全不符合要求」

---

## 1. 问题陈述（实测复现，非推测）

在真实界面对 Agent 说：

> 帮我生成一个小男孩在雨中奔跑的视频

Agent 回复：

> 我按「douyin · 20s · 清爽」搭了一条流水线：分镜 → 提示词编译 → 5 个镜头（1 个 T-A / 2 个 T-B / 2 个静图动效）→ 配音 → 质检 → 合成。预估 ¥7.75。

对生成的 13 个节点做全量字符串扫描，检查 `小男孩` / `雨` / `奔跑`：**三者全部 `false`**。

实际写入节点的内容：

| 节点 | 实际值 |
|---|---|
| script.brief | `产品 / douyin / 20s / 清爽 / 卖点：高性价比` |
| image[0..4].prompt | `痛点开场：产品，清爽，高性价比，竖屏特写` … `对比效果：产品，…` |
| video[0..2].prompt | `镜头 1 动态：清爽，流畅运镜` |
| audio.emotion / voiceId | `清爽` / `qingxin` |

其中 `产品` 与 `高性价比` 是**字面量兜底值**（正则在用户输入上未匹配），**这两个占位词本身被写进了提示词**。

**结论：这条链路上没有任何环节接触过用户说的内容。**

---

## 2. 根因（三层，各自独立）

### 根因 A：意图解析只有「营销参数」，没有「画面内容」

`src/engine/mockAgent.ts:35` 的 `parseBrief` 只抽 7 个字段，全部是营销参数：
`product / durationS / platform / tone / usp / cheap / shots`。**没有任何字段承载"视频讲什么"。**

- `product`：`/给(?:这款|这个|我的)?\s*(...)\s*(?:做|拍|来)/` 要求出现「做/拍/来」；
  「帮我生成一个小男孩在雨中奔跑的视频」不含这些词 → 落到字面量 `'产品'`
- `usp`：未匹配 → 落到字面量 `'高性价比'`
- `durationS`：未写时长 → 默认 `20`（营销默认值）

`planWorkflow`（`:94`）把这两个占位值写进 script.brief 与每个 image 节点的兜底 prompt：

```ts
prompt: `${label}：${b.product}，${b.tone}，${b.usp[0]}，竖屏特写`   // :138
prompt: `镜头 ${i + 1} 动态：${b.tone}，流畅运镜`                    // :161
```

注意 `:161` 的视频提示词**连 product 都不含**，纯风格词。

### 根因 B：LLM 兜底路径拿不到原始需求

`mockAgent.ts:115` 只把 `brief` 字符串传给 script 节点，**原始 `utterance` 从未下传**。
下游 `realText.ts:67-86` 的 `briefOf()` 从 `p.brief` 取，最终得到 `product: '产品'`。

因此即使 LLM（qwen3.8-flash）正常调用，它拿到的 subject 也是「产品」——只能围绕占位词编营销文案。

### 根因 C：Skill 的提示词模板把「产品」写死在叙事结构里

`apps/api/mva/skills/prompts/mva.script.storyboard/1.2.0.md:5`：

```
2. 单镜时长 2.5–6 秒；叙事结构：hook(1) → 场景/痛点(1-2) → 产品展示(1-2) → 卖点演示(1-2) → CTA(1)
```

**即使用户需求被完整传下去，LLM 也被明确指示按"产品营销"结构产出分镜。**这是最深层的一层。

（对照：`mva.prompt.compile.video/1.0.0.md:4` 的规则是「主体 + 动作 + 镜头运动 + 光线」——
**已经是内容优先的**，所以问题不在 compile，集中在 storyboard 的结构约束。）

### 根因 D：逐镜差异化从未真正落地（次要但真实）

`realText.ts:192-193` 的 `runCompileSkill` **只取 `shots[0]`**，只输出**单个** `text`；
而 `mockAgent.ts:147` 把**同一个端口连到全部 image 节点**：

```ts
for (let i = 0; i < b.shots; i++) edges.push(edge(prompt.id, 'out:text', img.id, 'in:prompt', 'text'));
```

`realImages.ts:33-34` 优先取上游编译文本 → **5 个镜头共用一句提示词**，分镜的逐镜差异被丢弃。

> 注意：这不影响"主题正确性"（修好 A/B 后主体会出现），但会让多镜头画面雷同。
> 用户已确认要修。

---

## 3. 目标与非目标

### 目标
用户用自然语言提出**任意**生成需求（促销商品 / 人物情节 / 场景 / 纯图片），Agent 搭出的工作流在**实际生成时体现该需求**。

具体验收：说「帮我生成一个小男孩在雨中奔跑的视频」后，
最终到达图像/视频模型的提示词中**必须出现「小男孩」「雨」「奔跑」所代表的画面内容**。

### 非目标
- 不改动「分镜 → 提示词编译 → 图像 → i2v → 配音 → 质检 → 合成」的**拓扑结构**（链路本身是对的）
- 不引入新依赖、不改后端适配器契约
- 不做真实的语义理解（不引入二次 LLM 调用做意图分类）；用规则 + 让 LLM 在已有 Skill 里补全

---

## 4. 设计

### 4.1 前端：`parseBrief` 增加 `subject`（根因 A）

**已在真实浏览器中用 10 条真实输入验证过下述策略**（验证结果见 §8）。

```ts
// Brief 接口新增
subject: string;            // 用户真正要拍的内容
explicitDuration: boolean;  // 用户是否显式写了时长
```

**路由优先，而非单表达式**（这一点很关键——第一版设计用单一 subject 正则，
实测在「帮我做一段猫咪打哈欠的视频」上**失败**，因为只允许了「生成/拍」而漏了「做」）：

```ts
const MARKET_KEYS  = /种草|带货|卖点|转化|投放|推广|营销|商品|产品|品牌|价格|促销|优惠|折扣|销量|下单|购买|链接|优惠券/;
const MARKET_VERB  = /(?:种草|带货|推广|营销|宣传)\s*(?:视频|短片|素材)/;

function extractProduct(t) {          // 显式产品名，命中即视为营销
  return t.match(/给(?:这款|这个|我的)?\s*([^\s，。,]{1,14}?)\s*(?:做|拍|来)/)?.[1]
      ?? t.match(/(?:产品|商品)[：:]\s*([^\s，。,]{1,14})/)?.[1] ?? null;
}
function extractSubject(t) {          // 剥壳式：锚定媒体名词，逐层剥掉动词/量词
  const m = t.match(/^(.*?)\s*(?:的)?\s*(?:视频|短片|图片|图像|画面|片段)/);
  let s = m ? m[1] : '';
  s = s.replace(/^(?:帮我|请|麻烦|我要|我想|想要|来|给我)+/g, '');
  s = s.replace(/^(?:生成|做|制作|拍|出|画|来)+/g, '');
  s = s.replace(/^(?:一个|一段|一条|一张|个|段|条|张)/g, '');
  return s.trim() || null;
}
```

判定：`isMarketing = MARKET_KEYS.test(t) || MARKET_VERB.test(t) || !!extractProduct(t)`
- 营销 → `subject = null`，`product` 走既有逻辑（**向后兼容**）
- 通用 → `subject = extractSubject(t)`

### 4.1c 三处修正（Task 1 审查实测发现，均源于本节最初的正则）

在真实浏览器/Node 中复现后确认，下列三条会把用户内容丢掉，已在计划中修正：

| 输入 | 修正前 | 修正后 |
|---|---|---|
| `给我拍一个小男孩在雨中奔跑的视频` | `product='我'` → 误判营销 → `subject=''` → **内容全丢**（与原 bug 同类！） | `product=null` → 走通用 → `subject='小男孩在雨中奔跑'` |
| `给我制作一个猫咪视频` | 信封剥壳把内容吞掉 → 假澄清 | `subject='猫咪'` |
| `做条一分钟的视频` | `subject='一分钟'`（兜底只认阿拉伯数字） | `subject=null` → 澄清 |

要点：① `extractProduct` 捕获后必须**剥掉代词**，否则「我」会被当成产品名；② 信封剥壳**仅当捕获段剥掉代词后仍有内容**时才执行；③ 时长兜底必须认**中文数字**（`一分钟`/`二十秒`）。

误判方向是安全的：修完后未知措辞一律走澄清，而不是编造内容。

### 4.1b 关键修正：消除「哨兵值当内容」的歧义

**当前 `'产品'` 与 `'高性价比'` 同时充当两种语义**：①「正则没匹配到」的哨兵，②真实内容值。
在写入提示词的位置**无法区分**，于是占位词被当成内容写进了提示词（§1 实测）。

必须改为：**兜底时不得把哨兵词当内容写出**。

- **营销且未提取到 product 时**（实测 `来个产品介绍视频` / `生成一个产品宣传视频` 会走到这里）：
  **不生成工作流，改为反问澄清** —— "这条要突出哪个产品/品牌？卖点是什么？"
  凭空编内容比问一句更糟。
- **通用且 subject 为空**：同样反问澄清，不生成占位工作流。

（这是相对现状的**行为改变**：现在会静默生成一堆占位内容。改为提问更诚实，也避免用户白花 ¥7.75。）

### 4.2 前端：时长与镜头数按内容定（用户已确认）

```ts
if (isMarketing) {
  dur = clamp(5..180, explicit ?? 20);          // 营销默认 20s，行为不变
  shots = clamp(3..12, round(dur / 4.2));       // 营销下限 3 镜，行为不变
} else {
  dur = explicit ?? 5;                          // 通用：无时长 → 5s
  shots = explicit ? clamp(1..12, round(dur / 4.2)) : 1;   // 无时长 → 1 镜
}
```

- 无时长 → 1 镜 / 5s（约 ¥2.3：1 张图 ¥0.06 + 5s i2v ¥2.25）
- **`planWorkflow` 的 `shotLabels` 循环**：`shotLabels[i % 6]` 在 1 镜时只会取到「痛点开场」，
  而该标签是**营销词**。通用场景下标签需改为镜头语言（`建立镜头/中景/跟拍/特写/收尾`），
  且 `shotLabels` 目前是 `planWorkflow` 内的局部常量（`:129`），需按 isMarketing 选择两组。

### 4.3 前端：提示词兜底措辞不再把占位词当内容（根因 A）

```ts
// 有 subject 时以它为主，标签降级为景别提示
const base = b.subject || b.product;
prompt: b.subject
  ? `${b.subject}，${label}，${b.tone}，竖屏特写`
  : `${label}：${b.product}，${b.tone}，${b.usp[0]}，竖屏特写`   // 营销原行为不变
```

视频节点同理：`b.subject ? `镜头 ${i+1}：${b.subject}，${b.tone}，流畅运镜` : 原值`。

### 4.4 前端：原始需求下传给 script 节点（根因 B）

script 节点的 `brief` 参数需带上 subject，使 `briefOf()` 拿到真实内容：

```ts
brief: `${b.subject || b.product} / ${b.platform} / ${b.durationS}s / ${b.tone}` +
       (b.subject ? '' : ` / 卖点：${b.usp.join('、')}`)
```

**同时** `realText.ts` 的 `briefOf` 需扩展 `Brief` 结构：新增
`subject: String(p.subject ?? raw.split('/')[0]?.trim() ?? '')`，
并把 `product.name` 在有 subject 时取 subject（保持 skill 入参 schema 兼容——`brief` 是 `{type:'object'}`，加字段不破坏校验）。

顺带修 `mockAgent.ts:170` 的硬编码非法音色 `voiceId: 'qingxin'` → `'Cherry'`
（HANDOFF §5 第 12 条记录过 `qingxin` 不在厂商许可列表，现靠适配器逐级回退才没炸）。

### 4.5 后端：storyboard 提示词支持内容优先结构（根因 C）

新建 `apps/api/mva/skills/prompts/mva.script.storyboard/1.3.0.md`，在 `__init__.py` 注册 `version="1.3.0"`
（`resolve()` 自动取最新版本，见 `__init__.py:188`）。

模板改动要点：
- 第 2 条结构规则改为**二分**：
  - 若 brief 含 `subject` 且无商品/卖点语义 → 按**内容叙事**：`建立(1) → 发展(1-2) → 高潮(1) → 收尾(1)`
  - 否则 → 保持现有产品营销结构（**向后兼容，不破坏已验证的营销链路**）
- `consistency_bible` 的 `props` 说明改为兼容「主体外观」而非仅「产品主体外观」
- `subject_ref` 示例从 `hero_product` 泛化为 `hero`/`subject`

### 4.6 后端：输出 schema 放宽 shot 下限（支撑 1 镜）

`apps/api/mva/skills/__init__.py:111` 现在是 `"minItems": 3`。
无时长请求会产出 1 镜 → 会被 schema 拦下 → 触发"修复重试"白烧 token。
**必须放宽为 `minItems: 1`**（`maxItems: 12` 不变）。

### 4.7 前端 + 后端：逐镜编译（根因 D，用户已确认要修）

- `realText.ts` 新增 `runCompileSkillForShots(node, inputs, ctx)`：
  遍历 `sb.shots`，对每个 shot 单独调 `mva.prompt.compile.video`，返回**每镜提示词数组**
  （输出形状：`{ type:'json', value: { prompts: [{shot_no, prompt, negative_prompt}] } }`，
  以及为兼容保留的 `out.text` = 第 1 镜）
- `realImages.ts` 取上游时**按本节点在分镜中的序位**取对应镜提示词，而非恒取第一句
- 为避免 N 次 LLM 调用的成本失控：**镜数 > 3 时只编译前 3 镜**，其余按第 3 镜的模板复用并在日志说明

---

## 5. 数据流（修复后）

```
用户：「帮我生成一个小男孩在雨中奔跑的视频」
        │
        ▼  parseBrief
   { subject: '小男孩在雨中奔跑', durationS: 5, shots: 1, explicitDuration: false }
        │
        ├─▶ script.brief = '小男孩在雨中奔跑 / douyin / 5s / 清爽'
        │        │
        │        ▼  storyboard 1.3.0（内容叙事结构，主体已正确）
        │   { shots: [{ visual: '小男孩在雨中奔跑…', ... }] }
        │        │
        │        ▼  compile（逐镜，1 镜 1 次）
        │   prompt: '小男孩在雨中奔跑，中景跟拍，雨夜路灯，电影感'
        │        │
        ├─▶ image.prompt 兜底 = '小男孩在雨中奔跑，痛点开场，清爽，竖屏特写'（subject 优先）
        │        │
        └─▶ video.prompt 兜底 = '镜头 1：小男孩在雨中奔跑，清爽，流畅运镜'
                 │
                 ▼  realImages 优先取上游 compile 结果（:33-34 既有行为）
              真实图像 → i2v → 合成
```

---

## 6. 测试策略

| 层 | 测法 |
|---|---|
| `parseBrief` | 纯函数单测：通用请求（视频/图片/带时长/不带时长）、营销请求（回归不变）、占位兜底不得泄漏为内容 |
| `planWorkflow` | 断言生成的 image/video 节点 `params.prompt` 含 subject；`shots===1` 时拓扑完整（image→video→qa→compose 链路不断） |
| 后端 schema | 断言 1 镜输出通过校验（`minItems` 已放宽）；断言 `mva.script.storyboard` 解析到 1.3.0 |
| 后端 skill | `scripts/verify_gateway.py` 已有 Skill 结构检查，需确认新增字段/版本后仍 55/55 |

**回归红线**：营销场景（「给这款气泡水做一个抖音种草视频，20秒，突出清爽解渴」）的行为必须与现在**一致**（`subject` 为空 → 走原分支）。

---

## 7. 已知边界（本次不解决）

1. `subject` 提取是**规则**，不是语义理解：极口语化或长句仍可能提取不全或提取错。
   真正的修法是二次 LLM 调用做意图/主体抽取，本次不做。
2. 逐镜编译 >3 镜时复用第 3 镜模板，长视频的镜头差异会退化。
3. 无时长请求默认 5s/1 镜，与营销默认 20s 不同——这是**有意的行为改变**（用户已确认）。
4. 反问澄清意味着某些输入**不再自动产出工作流**。这是有意的：好过静默生成占位内容让用户白花钱。

---

## 8. 实测验证记录（2026-09-12，真实浏览器）

在 `http://localhost:5173` 上对 10 条真实输入跑通路由 + 提取策略：

| 输入 | isMarketing | product | subject |
|---|---|---|---|
| 帮我生成一个小男孩在雨中奔跑的视频 | false | — | **小男孩在雨中奔跑** |
| 生成一个赛博朋克城市夜景的图片 | false | — | **赛博朋克城市夜景** |
| 帮我做一段猫咪打哈欠的视频 | false | — | **猫咪打哈欠** |
| 生成一只柴犬在雪地里奔跑的画面，10秒 | false | — | 一只柴犬在雪地里奔跑 |
| 给这款气泡水做一个抖音种草视频，20秒，突出清爽解渴 | **true** | **气泡水** | — |
| 拍一个小男孩在雨中奔跑的视频 | false | — | 小男孩在雨中奔跑 |
| 帮我生成一个小男孩在雨中奔跑的视频，15秒，小红书 | false | — | 小男孩在雨中奔跑 |
| 来个产品介绍视频 | **true** | null | null → **触发反问澄清** |
| 生成一个产品宣传视频 | **true** | null | null → **触发反问澄清** |
| 做一条猫咪视频 | false | — | 猫咪 |

**第一版设计用单一正则，实测在「帮我做一段猫咪打哈欠的视频」上返回 null**（只允许「生成/拍」，漏了「做」）。
改为「锚定媒体名词 + 剥壳」后通过。此表即回归基线。

**另外实证复现了主 bug**（在同一浏览器会话内调用 Agent 的 `send`）：

- 输入「帮我生成一个小男孩在雨中奔跑的视频」
- Agent 回复：`我按「douyin · 20s · 清爽」搭了一条流水线：…5 个镜头…预估 ¥7.75`
- 13 个节点的全量 JSON 扫描：`小男孩` / `雨` / `奔跑` **全部 false**
- `script.brief` = `产品 / douyin / 20s / 清爽 / 卖点：高性价比`
- `image[*].prompt` = `痛点开场：产品，清爽，高性价比，竖屏特写`（5 个）
- `video[*].prompt` = `镜头 1 动态：清爽，流畅运镜`（3 个）
