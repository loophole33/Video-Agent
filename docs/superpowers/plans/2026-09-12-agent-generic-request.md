# Agent 通用生成需求支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Agent 支持任意生成需求——用户说「帮我生成一个小男孩在雨中奔跑的视频」时，该内容必须真正到达图像/视频模型，而不是被替换成营销占位词。

**Architecture:** 三处独立缺陷。① 前端 `parseBrief` 增加 `subject` 字段并从原话提取（营销请求向后兼容）；② 后端 storyboard 提示词模板的叙事结构改为「内容/营销」二分（营销路径不变）；③ 提示词编译改为逐镜，让多镜头画面不再雷同。另修 `'产品'` 哨兵值被当作内容写入提示词的歧义。

**Tech Stack:** TypeScript · React 19 · zustand/immer · Vite · Vitest · Python FastAPI · 版本化 Skill 提示词模板

## Global Constraints

- **命令必须经 `cmd /c` 执行**：本机 PowerShell 执行策略禁止 `npm.ps1` / `npx.ps1`，直接跑报 `UnauthorizedAccess`。
  统一写 `cmd /c "npm test"`、`cmd /c "npx tsc --noEmit"`、`cmd /c "npm run build"`。
- **`tsc --noEmit` 不会报告未使用的 import** —— `tsconfig.json` 未开启 `noUnusedLocals`。清理 import 必须手工 grep 数引用。
- **动到网关侧（Python / skills）就要跑** `cd apps/api; python scripts/verify_gateway.py`，必须保持 **55/55**。
- **营销场景行为不得改变**（回归红线）：
  「给这款气泡水做一个抖音种草视频，20秒，突出清爽解渴」必须与修复前**完全一致**（20s / 5 镜 / product=气泡水 / usp 生效）。
- **不得引入新依赖。**
- Skill 版本注册后 `resolve()` 自动取最新（`apps/api/mva/skills/__init__.py:188`），无需改调用方版本号。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/engine/mockAgent.ts` | `parseBrief` 加 `subject`/`explicitDuration`/`isMarketing`；路由与提取；反问澄清；镜头标签二分；voiceId 修正 | 改 |
| `src/engine/realText.ts` | `briefOf` 传递 subject；新增逐镜编译 | 改 |
| `src/engine/realImages.ts` | 按本节点序位取对应镜提示词 | 改 |
| `apps/api/mva/skills/prompts/mva.script.storyboard/1.3.0.md` | 故事板模板：内容/营销二分结构 | **新建** |
| `apps/api/mva/skills/__init__.py` | 注册 storyboard 1.3.0；storyboard 输出 schema `minItems` 3→1；brief 增 subject 字段 | 改 |
| `tests/agentIntent.test.ts` | `parseBrief` 与 `planWorkflow` 的纯函数单测 | **新建** |

---

### Task 1: `parseBrief` 支持通用需求（含路由与哨兵修正）

**Files:**
- Modify: `src/engine/mockAgent.ts:1-56`（`Brief` 接口与 `parseBrief`）
- Test: `tests/agentIntent.test.ts`（新建）

**Interfaces:**
- Produces: `Brief` 新增字段 `subject: string`、`explicitDuration: boolean`、`isMarketing: boolean`
- Produces: `extractSubject(text: string): string | null`、`extractProduct(text: string): string | null`（导出以便单测）

- [ ] **Step 1: 写失败测试**

新建 `tests/agentIntent.test.ts`：

```ts
/**
 * Agent 意图解析单测 —— 覆盖「通用生成需求」与「营销需求」两条路径。
 * 回归红线：营销场景行为必须与修复前一致。
 */
import { describe, expect, it } from 'vitest';
import { extractProduct, extractSubject, parseBrief } from '../src/engine/mockAgent';

describe('extractSubject —— 从原话提取画面内容', () => {
  it('「生成一个…的视频」提取主体', () => {
    expect(extractSubject('帮我生成一个小男孩在雨中奔跑的视频')).toBe('小男孩在雨中奔跑');
  });

  it('「做一段…的视频」也要能提取（第一版正则漏了「做」）', () => {
    expect(extractSubject('帮我做一段猫咪打哈欠的视频')).toBe('猫咪打哈欠');
  });

  it('「拍一个…的视频」提取主体', () => {
    expect(extractSubject('拍一个小男孩在雨中奔跑的视频')).toBe('小男孩在雨中奔跑');
  });

  it('图片类需求同样提取', () => {
    expect(extractSubject('生成一个赛博朋克城市夜景的图片')).toBe('赛博朋克城市夜景');
  });

  it('「画面/片段」等媒体名词也作锚点', () => {
    expect(extractSubject('生成一只柴犬在雪地里奔跑的画面')).toBe('一只柴犬在雪地里奔跑');
  });

  it('带时长后缀仍能提取干净', () => {
    expect(extractSubject('帮我生成一个小男孩在雨中奔跑的视频，15秒，小红书')).toBe('小男孩在雨中奔跑');
  });

  it('营销句里提取不出画面主体（返回 null 或不含营销词）', () => {
    const s = extractSubject('给这款气泡水做一个抖音种草视频，20秒，突出清爽解渴');
    expect(s === null || !/种草|卖点/.test(s)).toBe(true);
  });

  it('无媒体名词 → null', () => {
    expect(extractSubject('你好')).toBeNull();
  });
});

describe('extractProduct —— 显式产品名', () => {
  it('「给这款X做」提取 X', () => {
    expect(extractProduct('给这款气泡水做一个抖音种草视频')).toBe('气泡水');
  });

  it('无产品句式 → null（而不是字面量兜底）', () => {
    expect(extractProduct('帮我生成一个小男孩在雨中奔跑的视频')).toBeNull();
  });
});

describe('parseBrief —— 路由', () => {
  it('通用请求：isMarketing=false，subject 有值，无时长 → 1 镜 / 5s', () => {
    const b = parseBrief('帮我生成一个小男孩在雨中奔跑的视频');
    expect(b.isMarketing).toBe(false);
    expect(b.subject).toBe('小男孩在雨中奔跑');
    expect(b.explicitDuration).toBe(false);
    expect(b.durationS).toBe(5);
    expect(b.shots).toBe(1);
  });

  it('通用请求带时长：按秒数算镜数', () => {
    const b = parseBrief('帮我生成一个小男孩在雨中奔跑的视频，15秒');
    expect(b.isMarketing).toBe(false);
    expect(b.subject).toBe('小男孩在雨中奔跑');
    expect(b.explicitDuration).toBe(true);
    expect(b.durationS).toBe(15);
    expect(b.shots).toBeGreaterThan(1);
  });

  it('回归红线：营销请求行为不变', () => {
    const b = parseBrief('给这款气泡水做一个抖音种草视频，20秒，突出清爽解渴');
    expect(b.isMarketing).toBe(true);
    expect(b.product).toBe('气泡水');
    expect(b.subject).toBe('');
    expect(b.durationS).toBe(20);
    expect(b.shots).toBe(5);
    expect(b.usp).toContain('清爽解渴');
  });

  it('营销无时长仍默认 20s（行为不变）', () => {
    const b = parseBrief('给这款气泡水做一个抖音种草视频');
    expect(b.isMarketing).toBe(true);
    expect(b.durationS).toBe(20);
  });

  it('营销但提取不到产品名 → needsClarify=true（不再静默用哨兵词）', () => {
    const b = parseBrief('来个产品介绍视频');
    expect(b.needsClarify).toBe(true);
    expect(b.product).not.toBe('产品');   // 不得回落到哨兵字面量
  });

  it('「生成一个产品宣传视频」同样触发澄清', () => {
    expect(parseBrief('生成一个产品宣传视频').needsClarify).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cmd /c "npx vitest run tests/agentIntent.test.ts"`
Expected: FAIL — `extractSubject is not a function` / `is not exported`

- [ ] **Step 3: 实现**

修改 `src/engine/mockAgent.ts`。把 `Brief` 接口与 `parseBrief` 替换为：

```ts
export interface Brief {
  product: string;
  subject: string;          // 用户真正要拍的内容（通用请求）；营销请求为空串
  isMarketing: boolean;
  needsClarify: boolean;    // 提取不到主体 → 反问澄清，而不是编占位内容
  explicitDuration: boolean;
  durationS: number;
  platform: string;
  tone: string;
  usp: string[];
  cheap: boolean;
  shots: number;
}

const MARKET_KEYS =
  /种草|带货|卖点|转化|投放|推广|营销|商品|产品|品牌|价格|促销|优惠|折扣|销量|下单|购买|链接|优惠券/;
const MARKET_VERB = /(?:种草|带货|推广|营销|宣传)\s*(?:视频|短片|素材)/;

/** 显式产品名（无则为 null，不回落到哨兵字面量） */
export function extractProduct(text: string): string | null {
  return (
    text.match(/给(?:这款|这个|我的)?\s*([^\s，。,]{1,14}?)\s*(?:做|拍|来)/)?.[1] ??
    text.match(/(?:产品|商品)[：:]\s*([^\s，。,]{1,14})/)?.[1] ??
    null
  );
}

/**
 * 从原话提取画面内容：锚定媒体名词，再逐层剥掉动词/量词壳。
 * 注意「做」也必须是合法动词 —— 第一版只允许「生成/拍」，实测漏掉「帮我做一段猫咪打哈欠的视频」。
 */
export function extractSubject(text: string): string | null {
  const m = text.match(/^(.*?)\s*(?:的)?\s*(?:视频|短片|图片|图像|画面|片段)/);
  let s = m ? m[1] : '';
  s = s.replace(/^(?:帮我|请|麻烦|我要|我想|想要|来|给我)+/g, '');
  s = s.replace(/^(?:生成|做|制作|拍|出|画|来)+/g, '');
  s = s.replace(/^(?:一个|一段|一条|一张|个|段|条|张)/g, '');
  return s.trim() || null;
}

export function parseBrief(text: string): Brief {
  const duration = text.match(/(\d{1,3})\s*(?:s|秒)/i);
  const explicitDuration = !!duration;
  const productRaw = extractProduct(text);
  const isMarketing = MARKET_KEYS.test(text) || MARKET_VERB.test(text) || !!productRaw;

  const subject = isMarketing ? '' : (extractSubject(text) ?? '');
  // 哨兵修正：营销但拿不到 product 时不再回落到字面量 '产品'
  const product = productRaw ?? (isMarketing ? '' : (subject || ''));
  const needsClarify = !product && !subject;

  const uspRaw = text.match(/突出\s*([^，。,]{1,20})/)?.[1];
  const usp = uspRaw ? uspRaw.split(/[、和与,]/).map((s) => s.trim()).filter(Boolean) : [];
  const platform = PLATFORMS.find((p) => p.match.test(text))?.key ?? 'douyin';
  const tone = TONES.find((t) => text.includes(t)) ?? '清爽';
  const cheap = /便宜|省钱|低预算|成本低|抠一点/.test(text);

  // 时长与镜数：营销保持旧默认（20s / ≥3 镜）；通用按内容定（无时长 → 5s / 1 镜）
  const rawDur = duration ? Math.min(180, Math.max(5, Number(duration[1]))) : null;
  const dur = rawDur ?? (isMarketing ? 20 : 5);
  const shots = isMarketing
    ? Math.min(12, Math.max(3, Math.round(dur / 4.2)))
    : rawDur
      ? Math.min(12, Math.max(1, Math.round(dur / 4.2)))
      : 1;

  return {
    product,
    subject,
    isMarketing,
    needsClarify,
    explicitDuration,
    durationS: dur,
    platform,
    tone,
    usp: usp.length ? usp : ['高性价比'],
    cheap,
    shots,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cmd /c "npx vitest run tests/agentIntent.test.ts"`
Expected: PASS — 15 例全绿

- [ ] **Step 5: 类型检查 + 提交**

Run: `cmd /c "npx tsc --noEmit"` → 退出码 0（若报 `planWorkflow` 里 `b.product` 相关错误，先只修类型，行为改动留给 Task 2）

```bash
git add src/engine/mockAgent.ts tests/agentIntent.test.ts
git commit -m "feat(agent): parse arbitrary generation requests into a subject field"
```

---

### Task 2: `planWorkflow` 把 subject 写进实际提示词

**Files:**
- Modify: `src/engine/mockAgent.ts:94-212`（`planWorkflow`）
- Test: `tests/agentIntent.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `Brief.subject` / `isMarketing` / `needsClarify` / `shots`
- Produces: `planWorkflow` 在 `needsClarify` 时返回一条纯文本澄清回复、**ops 为空数组**（不落图）

- [ ] **Step 1: 写失败测试**

追加到 `tests/agentIntent.test.ts`：

```ts
import { planWorkflow, respond } from '../src/engine/mockAgent';
import { nodeRegistry } from '../src/registry';
import type { WorkflowGraph } from '../src/types/graph';

function emptyGraph(): WorkflowGraph {
  return {
    schemaVersion: '1.0.0',
    id: 'wf_test',
    name: 'test',
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
    groups: [],
    constraints: { budgetLimitCny: 8, platform: 'douyin', ratio: '9:16' },
  };
}

function addedNodes(res: { patch: { ops: { op: string; node?: unknown }[] } }) {
  return res.patch.ops.filter((o) => o.op === 'add_node').map((o) => (o as { node: never }).node);
}

describe('planWorkflow —— subject 必须到达图像与视频提示词', () => {
  it('通用请求：图像提示词含主体', () => {
    const res = planWorkflow(emptyGraph(), '帮我生成一个小男孩在雨中奔跑的视频');
    const imgs = addedNodes(res).filter((n: never) => (n as { data: { type: string } }).data.type === 'image');
    expect(imgs.length).toBeGreaterThan(0);
    for (const n of imgs) {
      const prompt = String((n as { data: { params: { prompt?: string } } }).data.params.prompt ?? '');
      expect(prompt).toContain('小男孩在雨中奔跑');
    }
  });

  it('通用请求：视频提示词也含主体（修复前连 product 都没有）', () => {
    const res = planWorkflow(emptyGraph(), '帮我生成一个小男孩在雨中奔跑的视频');
    const vids = addedNodes(res).filter((n: never) => (n as { data: { type: string } }).data.type === 'video');
    expect(vids.length).toBeGreaterThan(0);
    for (const n of vids) {
      const prompt = String((n as { data: { params: { prompt?: string } } }).data.params.prompt ?? '');
      expect(prompt).toContain('小男孩在雨中奔跑');
    }
  });

  it('通用请求：不把哨兵词「产品」「高性价比」当内容写出', () => {
    const res = planWorkflow(emptyGraph(), '帮我生成一个小男孩在雨中奔跑的视频');
    const all = JSON.stringify(addedNodes(res));
    expect(all).not.toContain('：产品，');
    expect(all).not.toContain('高性价比');
  });

  it('通用无时长 → 1 镜，且拓扑完整（image→video→qa→compose）', () => {
    const res = planWorkflow(emptyGraph(), '帮我生成一个小男孩在雨中奔跑的视频');
    const nodes = addedNodes(res);
    const types = nodes.map((n: never) => (n as { data: { type: string } }).data.type);
    expect(types.filter((t: string) => t === 'image').length).toBe(1);
    expect(types.filter((t: string) => t === 'video').length).toBe(1);
    expect(types).toContain('compose');
    expect(types).toContain('qa_check');
  });

  it('通用请求的镜头标签不是营销词', () => {
    const res = planWorkflow(emptyGraph(), '帮我生成一个小男孩在雨中奔跑的视频');
    const all = JSON.stringify(addedNodes(res));
    expect(all).not.toContain('痛点开场');
    expect(all).not.toContain('CTA');
  });

  it('回归红线：营销请求仍产出 5 镜且提示词含产品名', () => {
    const res = planWorkflow(emptyGraph(), '给这款气泡水做一个抖音种草视频，20秒，突出清爽解渴');
    const nodes = addedNodes(res);
    const types = nodes.map((n: never) => (n as { data: { type: string } }).data.type);
    expect(types.filter((t: string) => t === 'image').length).toBe(5);
    expect(JSON.stringify(nodes)).toContain('气泡水');
  });

  it('提取不到主体 → 反问澄清且不落任何节点', () => {
    const res = planWorkflow(emptyGraph(), '来个产品介绍视频');
    expect(res.patch.ops.length).toBe(0);
    expect(res.reply.length).toBeGreaterThan(0);
  });

  it('voiceId 不再硬编码非法音色 qingxin', () => {
    const res = planWorkflow(emptyGraph(), '帮我生成一个小男孩在雨中奔跑的视频');
    expect(JSON.stringify(addedNodes(res))).not.toContain('qingxin');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cmd /c "npx vitest run tests/agentIntent.test.ts"`
Expected: FAIL — 多条断言不成立（提示词里没有「小男孩在雨中奔跑」）

- [ ] **Step 3: 实现**

修改 `planWorkflow`：

**(a) 函数开头加澄清短路**（在 `const b = parseBrief(utterance);` 之后）：

```ts
  if (b.needsClarify) {
    return {
      reply:
        '这条我还判断不出要拍什么。请补充主体或产品，例如：\n' +
        '· 通用：「生成一个<主体在做什么>的视频，<时长>秒」\n' +
        '· 营销：「给这款<产品>做条<时长>秒<平台>种草视频，突出<卖点>」',
      patch: {
        patch_id: `p_${Math.random().toString(36).slice(2, 10)}`,
        base_version: graph.version,
        rationale: `「${utterance.slice(0, 28)}」缺少可提取的主体，已请求澄清`,
        author: 'agent',
        risk: 'low',
        ops: [],
      },
    };
  }
```

**(b) 镜头标签二分**（替换 `:129` 的 `shotLabels`）：

```ts
  const shotLabels = b.isMarketing
    ? ['痛点开场', '产品特写', '使用场景', '卖点演示', '对比效果', 'CTA 收尾']
    : ['建立镜头', '中景', '跟拍', '特写', '全景', '收尾'];
```

**(c) 图像提示词：subject 优先，营销原行为不变**（替换 `:138`）：

```ts
        prompt: b.subject
          ? `${b.subject}，${label}，${b.tone}，竖屏特写`
          : `${label}：${b.product}，${b.tone}，${b.usp[0]}，竖屏特写`,
```

**(d) 视频提示词：subject 优先**（替换 `:161`）：

```ts
        prompt: b.subject
          ? `镜头 ${i + 1}：${b.subject}，${b.tone}，流畅运镜`
          : `镜头 ${i + 1} 动态：${b.tone}，流畅运镜`,
```

**(e) script.brief 带上 subject**（替换 `:115`）：

```ts
      brief: b.subject
        ? `${b.subject} / ${b.platform} / ${b.durationS}s / ${b.tone}`
        : `${b.product} / ${b.platform} / ${b.durationS}s / ${b.tone} / 卖点：${b.usp.join('、')}`,
```

**(f) voiceId 修正**（`:170`）：`voiceId: 'qingxin'` → `voiceId: 'Cherry'`

**(g) 回复文案**：把 `我按「${b.platform} · ${b.durationS}s · ${b.tone}」` 改为
`我按「${b.subject || b.product} · ${b.platform} · ${b.durationS}s · ${b.tone}」`，
让用户一眼看到主体被识别对了。

- [ ] **Step 4: 运行确认通过**

Run: `cmd /c "npx vitest run tests/agentIntent.test.ts"` → 全绿
Run: `cmd /c "npm test"` → 25 + 15 + 9 + 新例数 全绿
Run: `cmd /c "npx tsc --noEmit"` → 退出码 0

- [ ] **Step 5: 提交**

```bash
git add src/engine/mockAgent.ts tests/agentIntent.test.ts
git commit -m "feat(agent): propagate subject into image/video prompts; clarify instead of placeholders"
```

---

### Task 3: 后端 storyboard 模板支持内容叙事 + schema 放宽

**Files:**
- Create: `apps/api/mva/skills/prompts/mva.script.storyboard/1.3.0.md`
- Modify: `apps/api/mva/skills/__init__.py:87-137`
- Test: `apps/api/scripts/verify_gateway.py`（既有，跑通即可）

**Interfaces:**
- Produces: `mva.script.storyboard` 版本 `1.3.0`（`resolve()` 自动取最新）
- Produces: storyboard 输出 schema `shots.minItems` 由 3 放宽为 1
- Produces: `Brief` 入参新增可选 `subject` 字段说明

- [ ] **Step 1: 新建 1.3.0 模板**

复制 `1.2.0.md` 内容，把第 2 条结构规则改为二分，并泛化一致性词典说明：

```markdown
你是一位短视频分镜导演。请把 Brief 与选定文案拆成结构化分镜（镜头表）。

硬性要求：
1. 目标总时长 {{ target_duration_s }} 秒；镜头数 {{ shot_count }}；**各镜头时长之和与目标误差 ≤ 3%**
2. 单镜时长 2.5–6 秒；叙事结构**按 Brief 内容二选一**：
   - **若 Brief 有 subject（画面主体）且不含商品/卖点语义** → 按**内容叙事**：
     建立(1) → 发展(1-2) → 高潮(1) → 收尾(1)。**不要**出现产品展示/卖点演示/CTA 这类营销环节，
     也不要虚构商品或品牌。
   - **否则**（商品/营销 Brief）→ 按**营销结构**：
     hook(1) → 场景/痛点(1-2) → 产品展示(1-2) → 卖点演示(1-2) → CTA(1)
   - 镜头数较少时（≤2）按上面的顺序取前 N 个环节即可。
3. 反复出现的实体必须给同一个 subject_ref（用于跨镜头一致性），并在 consistency_bible 里写出**逐字固定**的外观描述。
   若主体是人或动物，subject_ref 用 `hero`；若是商品，用 `hero_product`。
4. on_screen_text ≤ 14 字，必须是**观众真的会看到的字幕**（不是镜头名）。
   内容叙事类若无字幕需求，可给空串。
5. 只使用给出的镜头语言枚举值；只用 JSON 回答

Brief：
{{ brief | tojson }}

文案（已选定版本）：
{{ copy | tojson }}

输出 JSON 结构：
{
  "total_duration_s": {{ target_duration_s }},
  "narration_full": "整条旁白",
  "shots": [
    {"shot_no": 1, "duration_s": 3.3, "visual": "画面描述", "camera": "特写|中景|全景|俯拍|跟拍|缓慢推近|环绕",
     "subject_ref": "hero", "narration": "该镜台词", "on_screen_text": "该镜字幕",
     "transition_out": "cut|dissolve|slide|zoom|none"}
  ],
  "consistency_bible": {"characters": [], "props": ["反复出现主体的外观逐字描述"], "environment": [], "lighting": "光线描述"}
}
```

- [ ] **Step 2: 注册版本并放宽 schema**

`apps/api/mva/skills/__init__.py`：

1. `version="1.2.0"` → `version="1.3.0"`（`STORIES` 那个 `SkillSpec`）
2. 输入 schema 增加 subject 说明（`brief` 已是 `{"type": "object"}`，只是文档性补充）：
   ```python
   "brief": {"type": "object", "description": "含 product/subject/platform/duration_s/style 等；subject 为画面主体（通用请求）"},
   ```
3. 输出 schema：`"minItems": 3` → `"minItems": 1`
   （**必须改**：通用请求无时长时产出 1 镜，否则被 schema 拦下并触发修复重试白烧 token）

- [ ] **Step 3: 跑网关验证**

```bash
cd D:\vtest\apps\api; python scripts/verify_gateway.py
```

Expected: **55/55 通过**（既有断言覆盖 Skill 结构修复；版本号变更不应破坏它，若断言硬编码了 1.2.0 需一并更新）

- [ ] **Step 4: 重启网关并确认版本**

```bash
# 关掉旧网关后重启（注意 8010 端口占用）
cd D:\vtest; npm run api
```

Run: `curl.exe -s http://127.0.0.1:8010/healthz` 或浏览器访问
Expected: `skills` 里 `mva.script.storyboard` 的 `version` 为 **1.3.0**，`warnings` 为 `[]`

- [ ] **Step 5: 提交**

```bash
git add apps/api/mva/skills/
git commit -m "feat(skills): storyboard 1.3.0 supports content-first narrative; relax minItems to 1"
```

---

### Task 4: 逐镜提示词编译

**Files:**
- Modify: `src/engine/realText.ts`（`runCompileSkill` → 新增逐镜版本；`briefOf` 传递 subject）
- Modify: `src/engine/realImages.ts:33-34`（按序位取对应镜）
- Modify: `src/engine/mockEngine.ts`（`prompt_compile` 分支改调逐镜版本）

**Interfaces:**
- Consumes: Task 2 的 script.brief（含 subject）
- Produces: `runCompileSkillForShots(node, inputs, ctx)` →
  `outputs.out = { type:'text', text: 第1镜提示词 }`（兼容既有下游）、
  `outputs.prompts = { type:'json', value: { prompts: [{shot_no, prompt, negative_prompt}] } }`

- [ ] **Step 1: 改 `briefOf` 传递 subject**

`src/engine/realText.ts:67-86`，在返回对象里增加 subject 并把主体优先作为 product.name：

```ts
function briefOf(node: MvaNode, inputs: Record<string, PortValue | undefined>) {
  const p = node.data.params;
  const raw = String(p.brief ?? '') || textOf(inputs.brief) || textOf(inputs.in) || '';
  const subject = String(p.subject ?? '').trim() || raw.split('/')[0]?.trim() || '';
  const product =
    String(p.product ?? '').trim() ||
    (subject && !/^产品$/.test(subject) ? subject : '') ||
    '产品';
  const usp =
    String(p.usp ?? '').trim() ||
    raw.match(/主打\s*([^·,，、]+)/)?.[1]?.trim() ||
    '高性价比';
  return {
    objective: String(p.objective ?? '种草'),
    subject,
    product: { name: product, usp: usp.split(/[、和与,]/).map((s) => s.trim()).filter(Boolean) },
    platform: String(p.platform ?? 'douyin'),
    duration_s: Number(p.targetDurationS ?? p.durationS ?? 20),
    style: { tone: String(p.style ?? '清爽'), pace: '快' },
    constraints: { forbidden_words: ['最', '第一', '国家级', '100%'] },
  };
}
```

> `objective` 在通用场景应改为 `'内容'` 而非 `'种草'`：当 `subject` 非空时用 `'内容'`。

- [ ] **Step 2: 新增逐镜编译**

在 `src/engine/realText.ts` 增加（保留 `runCompileSkill` 不动，供单镜调用）：

```ts
/** 逐镜编译：每个 shot 单独调 Skill，输出每镜提示词数组。镜数 >3 时只编译前 3 镜，其余复用第 3 镜。 */
export async function runCompileSkillForShots(
  node: MvaNode,
  inputs: Record<string, PortValue | undefined>,
  ctx: TextCtx,
): Promise<TextResult<{ prompts: CompiledPrompt[] }> | null> {
  const sb = jsonOf<Storyboard>(inputs.in);
  const shots = sb?.shots ?? [];
  if (!ctx.llmAvailable || !shots.length) return null;

  const capped = shots.slice(0, 3);
  const compiled: CompiledPrompt[] = [];
  let cost = 0, latency = 0, repairs = 0;
  let adapter = 'llm', model = '—', promptFile: string | undefined;

  for (const shot of capped) {
    const res = await runSkill<CompiledPrompt>('mva.prompt.compile.video', {
      shot,
      style: { tone: String(node.data.params.stylePreset ?? '清爽') },
      consistency_bible: sb?.consistency_bible ?? {},
      target: String(node.data.params.target ?? 'video'),
      model_family: String(node.data.params.modelFamily ?? 'kling'),
      max_chars: Number(node.data.params.maxChars ?? 800),
    }, { nodeId: node.id });
    if (res.ok && res.output) {
      compiled.push(res.output);
      const m = res.meta ?? {};
      cost += Number(m.cost_cny ?? 0);
      latency += Number(m.latency_ms ?? 0);
      repairs += Number(m.schema_repairs ?? 0);
      adapter = String(m.adapter ?? adapter);
      model = String(m.model ?? model);
      promptFile = m.prompt_file ? String(m.prompt_file) : promptFile;
    } else {
      ctx.log(`第 ${shot.shot_no} 镜提示词编译失败（${res.error?.class ?? 'error'}）：${res.error?.message ?? '未知'}`, 'error');
    }
  }
  if (!compiled.length) {
    ctx.log('逐镜编译全部失败 → 回退本地拼装', 'error');
    return null;
  }
  if (shots.length > capped.length) {
    ctx.log(`共 ${shots.length} 镜，仅编译前 ${capped.length} 镜以控成本，其余复用第 ${capped.length} 镜模板`, 'warn');
  }
  summarizeSkill({ costCny: cost, adapter, model, latencyMs: latency, repairs, promptFile }, ctx.log);
  return {
    parsed: { prompts: compiled },
    outputs: {
      out: { type: 'text', text: compiled[0].prompt },
      prompts: { type: 'json', value: { prompts: compiled } },
      negative: { type: 'text', text: compiled[0].negative_prompt },
      params: { type: 'json', value: compiled[0].params_hint ?? {} },
    },
    actual: { costCny: cost, adapter, model, latencyMs: latency },
  };
}
```

- [ ] **Step 3: 图像节点按序位取对应镜**

`src/engine/realImages.ts:33-34` 目前是 `const compiled = upstreamText(inputs, 'prompt')`。
改为优先读 `inputs['prompts']` 的 json 并按下标取：

```ts
  // 逐镜：优先按本节点在分镜中的序位取对应镜提示词
  const cannedPrompts = (() => {
    const v = inputs['prompts'];
    if (v && v.type === 'json') {
      const list = (v.value as { prompts?: { prompt: string }[] })?.prompts;
      if (Array.isArray(list) && list.length) return list.map((x) => x.prompt);
    }
    return [];
  })();
  const shotIndex = Number(node.data.params.shotIndex ?? 0);
  const compiled = cannedPrompts.length
    ? cannedPrompts[Math.min(shotIndex, cannedPrompts.length - 1)]
    : upstreamText(inputs, 'prompt');
```

`mockAgent.ts` 建 image 节点时写入 `shotIndex: i`，并把 `prompts` 端口接到每个 image 节点：

```ts
        prompt: ...,
        shotIndex: i,
```

- [ ] **Step 4: 运行测试**

Run: `cmd /c "npm test"` → 全绿
Run: `cmd /c "npx tsc --noEmit"` → 退出码 0

- [ ] **Step 5: 手动端到端验证（关键）**

1. `npm run dev` + `npm run api` 都在跑
2. 新建画布 → 对 Agent 说「帮我生成一个小男孩在雨中奔跑的视频」
3. **预期**：回复里出现「小男孩在雨中奔跑」；画布只有 1 镜（1 图 + 1 视频 + 配音 + 质检 + 合成）
4. 接受提案 → 检查 image 节点的 `prompt` 参数**含「小男孩在雨中奔跑」**
5. 运行 → 日志里 `prompt=` 显示真实主体；产出图**不含商品**

- [ ] **Step 6: 提交**

```bash
git add src/engine/realText.ts src/engine/realImages.ts src/engine/mockAgent.ts
git commit -m "feat(engine): compile prompts per shot and route each image node to its own shot"
```

---

### Task 5: 全量门禁 + 文档

**Files:**
- Modify: `docs/HANDOFF.md`

- [ ] **Step 1: 全量门禁**

```bash
cmd /c "npx tsc --noEmit"
cmd /c "npm test"
cmd /c "npm run build"
cd apps/api; python scripts/verify_gateway.py    # 必须 55/55
```

- [ ] **Step 2: HANDOFF §5 追加**

```
16. **Agent 只认营销模板，任意生成需求的"画面内容"全部丢失**：用户说「生成一个小男孩在雨中奔跑的视频」，
    Agent 搭出的 13 个节点里 `小男孩`/`雨`/`奔跑` 全为 false —— `parseBrief` 只抽 7 个营销字段、
    没有"视频讲什么"，未匹配时把哨兵字面量 `产品`/`高性价比` 当内容写进提示词；storyboard 模板又硬编码
    `产品展示→卖点演示→CTA` 结构；`runCompileSkill` 只取 shots[0] 导致多镜共用一句提示词。
    → 新增 `subject` 字段与营销/通用路由；storyboard 1.3.0 二分叙事；逐镜编译；提取不到主体改为反问澄清。
```

- [ ] **Step 3: 提交**

```bash
git add docs/HANDOFF.md
git commit -m "docs: record agent generic-request support in HANDOFF"
```

---

## Self-Review

**1. Spec coverage**

| Spec 章节 | 对应任务 |
|---|---|
| §4.1 parseBrief 加 subject + 路由 | Task 1 |
| §4.1b 哨兵歧义 → 反问澄清 | Task 1（`needsClarify`）+ Task 2(a) |
| §4.2 时长/镜头数按内容定 + 镜头标签二分 | Task 1（时长）+ Task 2(b) |
| §4.3 兜底措辞 subject 优先 | Task 2(c)(d) |
| §4.4 原始需求下传 script（briefOf） | Task 4 Step 1 |
| §4.4 voiceId 修正 | Task 2(f) |
| §4.5 storyboard 1.3.0 内容叙事 | Task 3 |
| §4.6 schema minItems 3→1 | Task 3 Step 2 |
| §4.7 逐镜编译 | Task 4 Step 2-3 |
| §6 测试策略 | Task 1/2 单测 + Task 3 verify_gateway + Task 5 |
| §7 已知边界 | 文档化于 §7，Task 5 HANDOFF |

**2. Placeholder scan**：无 TBD/TODO；所有代码步骤含完整代码。

**3. Type consistency**：`Brief` 新字段（`subject`/`isMarketing`/`needsClarify`/`explicitDuration`）在 Task 1 定义，
Task 2 全部使用；`extractSubject`/`extractProduct` Task 1 导出、Task 1 测试导入；
`runCompileSkillForShots` Task 4 定义与调用一致；`CompiledPrompt`/`Storyboard` 复用 `realText.ts` 既有类型。

**4. 风险点**
- Task 3 改后端提示词后，**营销链路的实际产出文案会变**（LLM 解读差异）。回归红线只保证**前端行为参数**一致（20s/5 镜/气泡水），不保证 LLM 逐字输出相同 —— 这是可接受的，因为 1.3.0 对营销路径的要求与 1.2.0 逐字相同。
- Task 4 逐镜编译使 LLM 调用次数由 1 变 3（上限），**成本上升**。已限定 ≤3 镜并在日志说明。
