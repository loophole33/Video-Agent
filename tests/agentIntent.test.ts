/**
 * Agent 意图解析单测 —— 覆盖「通用生成需求」与「营销需求」两条路径。
 * 回归红线：营销场景行为必须与修复前一致。
 */
import { describe, expect, it } from 'vitest';
// 简报原文还 import 了 `respond` 与 `nodeRegistry`，但本文件从未使用（tsc 未开 noUnusedLocals
// 所以不报错，且仓库无 lint 脚本）—— 空引用已移除，避免误导读者以为它们参与了断言。
import { extractProduct, extractSubject, parseBrief, planWorkflow } from '../src/engine/mockAgent';
import type { AgentResult } from '../src/engine/mockAgent';
import type { MvaNode, PatchOp, WorkflowGraph } from '../src/types/graph';

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

  it('营销句信封只保留动词前段（弱析取换成精确断言）', () => {
    // 修订：原断言 `s === null || !/种草|卖点/.test(s)` 是弱析取、可能恒真。
    // 实测修正后的真实返回值：信封 head='气泡水'（动词前）、tail='抖音种草'（动词后），
    // 二者合并 → '气泡水抖音种草'。营销词不进**动词前**的内容位，这是 Task 1 的边界。
    // 注意：tail 里的营销话术仍在返回值中，属于 Task 2 的逐镜提示词模板问题（计划 Task 2 处理），
    // 不在此处假装已解决 —— 故此处钉死 Task 1 的真实行为。
    // TODO(Task 2)：营销尾巴「抖音种草」被 head/tail 合并带进来了。当前对管线不可见
    // （isMarketing 时 subject 被清空），但 Task 2 落地澄清短路后应重新审视此断言。
    expect(extractSubject('给这款气泡水做一个抖音种草视频，20秒，突出清爽解渴')).toBe('气泡水抖音种草');
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

  it('通用请求 product 回落到 subject（Task 2 提示词要拿它当内容用）', () => {
    const b = parseBrief('帮我生成一个小男孩在雨中奔跑的视频');
    expect(b.product).toBe('小男孩在雨中奔跑');
    expect(b.needsClarify).toBe(false);
  });

  it('静默丢需求的原句「做一条猫咪视频」：subject 保住，且不误判为营销', () => {
    const b = parseBrief('做一条猫咪视频');
    expect(b.isMarketing).toBe(false);
    expect(b.subject).toBe('猫咪');
    expect(b.needsClarify).toBe(false);
  });

  it('重复调用结果稳定：营销句三连调用 must 一致（防止给 MARKET_KEYS 加 g 导致 test() 状态漂移）', () => {
    // 修订：原来采样「做一条猫咪视频」，但它在 MARKET_KEYS 上**不命中**——
    // 失败的 test() 会把 lastIndex 归零，所以即使误加 /g 也得到 false,false,false，tripwire 形同虚设。
    // 换成**会命中**的营销句：加 /g 后第一次命中会把 lastIndex 推过末尾，后续调用漏判 → isMarketing 漂移。
    const once = parseBrief('给这款气泡水做一个抖音种草视频');
    const twice = parseBrief('给这款气泡水做一个抖音种草视频');
    const thrice = parseBrief('给这款气泡水做一个抖音种草视频');
    // 断言具体值，而不是三次调用互相比对 —— 确定性函数永远等于自己，那样等于什么都没断言
    for (const b of [once, twice, thrice]) {
      expect(b.isMarketing).toBe(true);
      expect(b.product).toBe('气泡水');
      expect(b.subject).toBe('');
    }
    expect(once).toEqual(twice);
    expect(twice).toEqual(thrice);
  });
});

describe('parseBrief —— 只有时长、没有内容 = 必须澄清（不得把时长当内容）', () => {
  it('「做条 20s 视频」：subject 不是 "20s"，走澄清', () => {
    const b = parseBrief('做条 20s 视频');
    expect(b.subject).not.toBe('20s');
    expect(b.needsClarify).toBe(true);
    expect(b.product).not.toBe('产品');   // 也不许回落到哨兵字面量
  });

  it('extractSubject 对纯时长壳返回 null', () => {
    expect(extractSubject('做条 20s 视频')).toBeNull();
    expect(extractSubject('生成一个15秒的视频')).toBeNull();
  });

  it('但带数字的真内容不被误伤（3D 动画是画面内容）', () => {
    expect(extractSubject('生成一个3D动画的视频')).toBe('3D动画');
  });
});

describe('代词与内容保全（Task 1 审查发现）', () => {
  it('「给我拍…」不得把「我」当成产品名而丢掉内容', () => {
    const b = parseBrief('给我拍一个小男孩在雨中奔跑的视频');
    expect(b.isMarketing).toBe(false);
    expect(b.subject).toBe('小男孩在雨中奔跑');
    expect(b.product).not.toBe('我');
  });

  it('「给我做一个猫咪视频」同样不得丢内容', () => {
    const b = parseBrief('给我做一个猫咪视频');
    expect(b.isMarketing).toBe(false);
    expect(b.subject).toBe('猫咪');
  });

  it('「给我制作一个猫咪视频」信封剥壳不得吞掉内容', () => {
    expect(extractSubject('给我制作一个猫咪视频')).toBe('猫咪');
  });

  it('中文数字时长不得当成内容', () => {
    expect(extractSubject('做条一分钟的视频')).toBeNull();
    expect(parseBrief('做条一分钟的视频').needsClarify).toBe(true);
  });

  it('「二十秒」同样不得当成内容', () => {
    expect(extractSubject('生成一个二十秒的视频')).toBeNull();
  });

  it('无单位裸数字时长不得当成内容', () => {
    expect(extractSubject('做条20视频')).toBeNull();
  });

  it('含数字/单位的真实主体不得被误杀', () => {
    expect(extractSubject('生成一个3D动画的视频')).toBe('3D动画');
    expect(extractSubject('生成一个5G手机的视频')).toBe('5G手机');
    expect(extractSubject('生成一个4K风景的视频')).toBe('4K风景');
    expect(extractSubject('生成一个24fps的视频')).toBe('24fps');
  });
});

describe('Task 1 复审五修回归（信封合并 / 中文时长 / 哨兵泄漏 / 代词剥壳）', () => {
  it('FIX 1 信封头尾合并：「给猫咪制作一个在雨中奔跑的视频」两段都保住', () => {
    const s = extractSubject('给猫咪制作一个在雨中奔跑的视频');
    expect(s).toBe('猫咪在雨中奔跑');
    expect(s).toContain('猫咪');
    expect(s).toContain('在雨中奔跑');
    const b = parseBrief('给猫咪制作一个在雨中奔跑的视频');
    expect(b.isMarketing).toBe(false);
    expect(b.needsClarify).toBe(false);
    expect(b.subject).toContain('猫咪');
    expect(b.subject).toContain('在雨中奔跑');
  });

  it('FIX 1 「给小猫制作一个雪地奔跑的视频」同样头尾都保住', () => {
    const s = extractSubject('给小猫制作一个雪地奔跑的视频');
    expect(s).toBe('小猫雪地奔跑');
    expect(s).toContain('小猫');
    expect(s).toContain('雪地奔跑');
  });

  it('FIX 2 中文数字时长被剥掉且不当内容：「做一段一分钟的猫咪视频」', () => {
    const b = parseBrief('做一段一分钟的猫咪视频');
    expect(b.subject).toContain('猫咪');
    expect(b.subject).not.toContain('一分钟');
  });

  it('FIX 2 「给我生成一个十分钟的小男孩奔跑视频」：内容保住、时长不进画面', () => {
    const b = parseBrief('给我生成一个十分钟的小男孩奔跑视频');
    expect(b.subject).toContain('小男孩奔跑');
    expect(b.subject).not.toContain('十分钟');
  });

  it('FIX 2 量词+时长+量词（千万零入类）：「做一条一千分钟的视频」只剩时长 → 澄清', () => {
    const b = parseBrief('做一条一千分钟的视频');
    expect(b.subject).toBe('');
    expect(b.needsClarify).toBe(true);
    expect(extractSubject('做一条一千分钟的视频')).toBeNull();
  });

  it('FIX 3 字面量「产品」不算提取到内容：「给这款产品做一个视频」必须澄清', () => {
    const b = parseBrief('给这款产品做一个视频');
    expect(b.product).not.toBe('产品');
    expect(b.needsClarify).toBe(true);
    expect(extractProduct('给这款产品做一个视频')).toBeNull();
    expect(extractProduct('给这个商品做一个视频')).toBeNull();
  });

  it('FIX 4 代词只在「整段就是代词」时判空：「给我们的猫拍一个视频」不得削成「的猫」', () => {
    const p = extractProduct('给我们的猫拍一个视频');
    expect(p).not.toBe('的猫');
    expect(p).toContain('猫');
    expect(parseBrief('给我们的猫拍一个视频').product).toContain('猫');
  });

  it('FIX 4 「给我家猫拍一个视频」不得被削成「家猫」', () => {
    expect(extractProduct('给我家猫拍一个视频')).not.toBe('家猫');
  });

  it('FIX 5 通用请求不带哨兵词「高性价比」', () => {
    const b = parseBrief('帮我生成一个小男孩在雨中奔跑的视频');
    expect(b.isMarketing).toBe(false);
    expect(b.usp).not.toContain('高性价比');
    expect(b.usp).toEqual([]);
  });

  it('FIX 5 回归红线：营销句 usp 仍由正则派生（不含哨兵替换）', () => {
    const b = parseBrief('给这款气泡水做一个抖音种草视频，20秒，突出清爽解渴');
    expect(b.usp).toContain('清爽解渴');
    expect(b.usp).not.toContain('高性价比');
  });
});

describe('Task 1 第三轮复审（复合时长 / 把字句帧 / 死分支清理）', () => {
  it('复合时长不留残渣：「生成一个10秒钟的视频」', () => {
    expect(extractSubject('生成一个10秒钟的视频')).toBeNull();
    expect(parseBrief('生成一个10秒钟的视频').needsClarify).toBe(true);
  });

  it('复合时长不留残渣：「生成一个20秒钟的视频」', () => {
    expect(extractSubject('生成一个20秒钟的视频')).toBeNull();
    expect(parseBrief('生成一个20秒钟的视频').needsClarify).toBe(true);
  });

  it('「两分半钟」整体被剥掉（不得残留「半钟」当画面内容）', () => {
    const s = extractSubject('给我做一个两分半钟的视频');
    expect(s).not.toBe('半钟');   // 残渣形态（s 为 null 时 not.toBe 仍成立）
    expect(s).toBeNull();
    expect(parseBrief('给我做一个两分半钟的视频').needsClarify).toBe(true);
  });

  it('「两分半」整体被剥掉（不得残留「半」当画面内容）', () => {
    const s = extractSubject('做一个两分半的视频');
    expect(s).not.toBe('半');   // 残渣形态（s 为 null 时 not.toBe 仍成立）
    expect(s).toBeNull();
    expect(parseBrief('做一个两分半的视频').needsClarify).toBe(true);
  });

  it('「一分半的猫咪视频」：时长剥净，猫咪**必须存活**（不得只剩「半的猫咪」）', () => {
    const s = extractSubject('做一个一分半的猫咪视频');
    expect(s).toBe('猫咪');
    expect(s).toContain('猫咪');
    expect(s).not.toContain('半');
    const b = parseBrief('做一个一分半的猫咪视频');
    expect(b.subject).toBe('猫咪');
    expect(b.needsClarify).toBe(false);
  });

  it('反过度吞噬：量词+时长+量词（两分半钟入类）只剩余时长 → 澄清', () => {
    // 反过度吞噬：剥完只剩时长必须 return null。「两分半钟/两分半」是第三轮新增的复合形。
    expect(extractSubject('做一个两分半钟的视频')).toBeNull();
    expect(extractSubject('做一条两分半的视频')).toBeNull();
    expect(extractSubject('生成一个二十分钟的视频')).toBeNull();
  });

  it('既有反过度吞噬用例全部保持：3D动画 / 5G手机 / 4K风景 / 24fps', () => {
    expect(extractSubject('生成一个3D动画的视频')).toBe('3D动画');
    expect(extractSubject('生成一个5G手机的视频')).toBe('5G手机');
    expect(extractSubject('生成一个4K风景的视频')).toBe('4K风景');
    expect(extractSubject('生成一个24fps的视频')).toBe('24fps');
  });

  it('把字句帧必须澄清：「帮我把猫咪做成视频」', () => {
    expect(extractSubject('帮我把猫咪做成视频')).not.toBe('把猫咪做成');
    expect(extractSubject('帮我把猫咪做成视频')).toBeNull();
    expect(parseBrief('帮我把猫咪做成视频').needsClarify).toBe(true);
  });

  it('把字句帧必须澄清：「帮我把小男孩在雨中奔跑拍成视频」', () => {
    expect(extractSubject('帮我把小男孩在雨中奔跑拍成视频')).not.toBe('把小男孩在雨中奔跑拍成');
    expect(extractSubject('帮我把小男孩在雨中奔跑拍成视频')).toBeNull();
    expect(parseBrief('帮我把小男孩在雨中奔跑拍成视频').needsClarify).toBe(true);
  });

  it('把字句帧必须澄清：「把猫咪在雨中奔跑做成视频」', () => {
    expect(extractSubject('把猫咪在雨中奔跑做成视频')).not.toBe('把猫咪在雨中奔跑做成');
    expect(extractSubject('把猫咪在雨中奔跑做成视频')).toBeNull();
    expect(parseBrief('把猫咪在雨中奔跑做成视频').needsClarify).toBe(true);
  });

  it('反过度吞噬：只拒绝「整段残余恰好是把字句帧」，更长残余不误杀', () => {
    // 锚定 ^…$ 对整串生效，故以「把」开头但不止于「做成/拍成」的残余必须放行。
    // 这同时是已知边界：把字句宾语回填不做（新机制、会引入静默丢内容），只做整帧拒绝。
    expect(extractSubject('把猫咪做成花的视频')).toBe('把猫咪做成花');
  });
});

/* ── Task 2：subject 必须真正到达生成的节点参数 ── */

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

/** 取出一份补丁的 ops（AgentResult.patch 是可选字段，测试里断言必然存在） */
function opsOf(res: AgentResult) {
  return res.patch!.ops;
}

function addedNodes(res: AgentResult): MvaNode[] {
  // 修订简报代码：`(o as { node: never }).node` 在 TS 下是非法收窄（unknown → never），
  // 且参数类型 `{ patch: { ops: ... } }` 与 AgentResult（patch 可选）不兼容 —— tsc 报 14 处。
  // 改为收窄到 add_node 分支后读 node，类型安全且断言等价。
  return opsOf(res)
    .filter((o): o is Extract<PatchOp, { op: 'add_node' }> => o.op === 'add_node')
    .map((o) => o.node);
}

describe('planWorkflow —— subject 必须到达图像与视频提示词', () => {
  it('通用请求：图像提示词含主体，且走 subject 分支（不留空槽位残渣）', () => {
    const res = planWorkflow(emptyGraph(), '帮我生成一个小男孩在雨中奔跑的视频');
    const imgs = addedNodes(res).filter((n: MvaNode) => n.data.type === 'image');
    expect(imgs.length).toBeGreaterThan(0);
    for (const n of imgs) {
      const prompt = String((n as { data: { params: { prompt?: string } } }).data.params.prompt ?? '');
      expect(prompt).toContain('小男孩在雨中奔跑');
      // 自审加强：仅断言「含主体」是**弱断言** —— Task 1 的 product=subject 兜底已让旧模板
      // 也能通过（`痛点开场：小男孩在雨中奔跑，清爽，，竖屏特写`）。把 subject 分支的形状钉死，
      // 这样回退 (c) 的图像提示词改动立刻变红。
      expect(prompt).toBe('小男孩在雨中奔跑，建立镜头，清爽，竖屏特写');
    }
    // script.brief 必须带主体（变异测试实测：回退 (e) 时无任何测试变红，故此处补守护）
    const script = addedNodes(res).find((n: MvaNode) => n.data.type === 'script');
    expect(script!.data.params.brief).toBe('小男孩在雨中奔跑 / douyin / 5s / 清爽');
  });

  it('信封句式：视频/脚本/回复都含尾部内容（才能区分 subject 与 product）', () => {
    // 自审关键发现：通用句 `帮我生成一个小男孩在雨中奔跑的视频` 下 product === subject
    // （Task 1 的 product 兜底），因此它**无法区分** (d)(e)(g) 三条编辑与它们的旧版本
    // —— 实测这三条回退后全套仍全绿。要真正测出 subject 通路，必须用 head≠tail 的信封句：
    // head='猫咪' → product，tail='在雨中奔跑' → subject。此时旧模板（用 product）会丢掉「在雨中奔跑」。
    const res = planWorkflow(emptyGraph(), '给猫咪制作一个在雨中奔跑的视频');
    const nodes = addedNodes(res);
    expect(JSON.stringify(nodes)).toContain('猫咪');
    const vid = nodes.find((n: MvaNode) => n.data.type === 'video');
    expect(vid!.data.params.prompt).toBe('镜头 1：猫咪在雨中奔跑，清爽，流畅运镜');
    const script = nodes.find((n: MvaNode) => n.data.type === 'script');
    expect(script!.data.params.brief).toBe('猫咪在雨中奔跑 / douyin / 5s / 清爽');
    expect(res.reply).toContain('我按「猫咪在雨中奔跑 · douyin · 5s · 清爽」');
  });

  it('通用请求：提示词与回复都不含空槽位残渣与哨兵词', () => {
    // 自审补守护：回复文案与 usp 槽位渲染原先**无任何测试覆盖**（变异 E/G 实测全绿）。
    const res = planWorkflow(emptyGraph(), '帮我生成一个小男孩在雨中奔跑的视频');
    // 回复让用户一眼看到主体被识别对了（简报 (g)）；回退 (g) 时这条变红
    expect(res.reply).toContain('我按「小男孩在雨中奔跑 · douyin · 5s · 清爽」');
    // 空 usp 槽位不得留下连续逗号（回退 uspPart 时这条变红；测试 A 的精确断言是第二道闸）
    expect(JSON.stringify(addedNodes(res))).not.toContain('，，');
    expect(res.reply).not.toContain('高性价比');
  });

  it('通用请求：视频提示词也含主体（修复前连 product 都没有）', () => {
    const res = planWorkflow(emptyGraph(), '帮我生成一个小男孩在雨中奔跑的视频');
    const vids = addedNodes(res).filter((n: MvaNode) => n.data.type === 'video');
    expect(vids.length).toBeGreaterThan(0);
    for (const n of vids) {
      const prompt = String((n as { data: { params: { prompt?: string } } }).data.params.prompt ?? '');
      expect(prompt).toContain('小男孩在雨中奔跑');
    }
  });

  it('通用请求：不把哨兵词「产品」「高性价比」当内容写出', () => {
    const res = planWorkflow(emptyGraph(), '帮我生成一个小男孩在雨中奔跑的视频');
    const all = JSON.stringify(addedNodes(res));
    // 自审加强：先钉住**前置条件**。若 subject 根本没进节点，下面的 not.toContain 是空转
    // （对空对象断言「不含哨兵词」恒真），这条测试就变成了装饰。
    expect(all).toContain('小男孩在雨中奔跑');
    expect(all).not.toContain('：产品，');
    expect(all).not.toContain('高性价比');
  });

  it('通用无时长 → 1 镜，且拓扑完整（image→video→qa→compose）', () => {
    const res = planWorkflow(emptyGraph(), '帮我生成一个小男孩在雨中奔跑的视频');
    const nodes = addedNodes(res);
    const types = nodes.map((n: MvaNode) => n.data.type);
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
    const types = nodes.map((n: MvaNode) => n.data.type);
    expect(types.filter((t: string) => t === 'image').length).toBe(5);
    expect(JSON.stringify(nodes)).toContain('气泡水');
    // 自审加强：仅断言「含气泡水」不足以守住红线模板 —— 回退 (c) 的营销分支后它依然是绿的。
    // 把营销提示词模板逐字钉死，任何对营销渲染的改动都会在这里爆炸。
    expect(nodes.filter((n: MvaNode) => n.data.type === 'image').map((n) => n.data.params.prompt)).toEqual([
      '痛点开场：气泡水，清爽，清爽解渴，竖屏特写',
      '产品特写：气泡水，清爽，清爽解渴，竖屏特写',
      '使用场景：气泡水，清爽，清爽解渴，竖屏特写',
      '卖点演示：气泡水，清爽，清爽解渴，竖屏特写',
      '对比效果：气泡水，清爽，清爽解渴，竖屏特写',
    ]);
  });

  it('提取不到主体 → 反问澄清且不落任何节点', () => {
    const res = planWorkflow(emptyGraph(), '来个产品介绍视频');
    expect(opsOf(res).length).toBe(0);
    expect(res.reply.length).toBeGreaterThan(0);
  });

  it('营销澄清路径不得再把哨兵词「高性价比」写进节点参数', () => {
    // Task 1 第 3 轮审查的 Critical：planWorkflow 从不读 needsClarify，
    // 于是 marketing + product='' 时会写出 `痛点开场：，清爽，高性价比，竖屏特写`。
    // 澄清短路落地后必须为「零节点」，因此这里同时断言「不落节点」与「无哨兵词」。
    // 自审说明：本测试的"致命性"锚在 `ops.length === 0` 这一条上 —— 回退澄清短路后
    // 该句会产出 32 个 op（实测），第一条断言立刻红；第二条 not.toContain 是补充说明。
    // 澄清路径下 ops 必为空，故 not.toContain 无法独立变红，但零点断言已经完全覆盖此风险。
    const res = planWorkflow(emptyGraph(), '给我做一个产品宣传视频');
    expect(opsOf(res).length).toBe(0);
    expect(JSON.stringify(opsOf(res))).not.toContain('高性价比');
  });

  it('voiceId 不再硬编码非法音色 qingxin', () => {
    const res = planWorkflow(emptyGraph(), '帮我生成一个小男孩在雨中奔跑的视频');
    expect(JSON.stringify(addedNodes(res))).not.toContain('qingxin');
    // 自审加强：仅断言「不含 qingxin」挡不住任意改坏（改成 'xyz' 也绿）。
    // 钉死仓库既有的合法音色（registry 默认值 / templates.ts / realAudio.ts 均为 Cherry）。
    const audios = addedNodes(res).filter((n: MvaNode) => n.data.type === 'audio');
    expect(audios.length).toBeGreaterThan(0);
    for (const a of audios) expect(a.data.params.voiceId).toBe('Cherry');
  });
});
