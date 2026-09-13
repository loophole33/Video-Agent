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

  it('营销句信封只保留动词前段（弱析取换成精确断言）', () => {
    // 修订：原断言 `s === null || !/种草|卖点/.test(s)` 是弱析取、可能恒真。
    // 实测修正后的真实返回值：信封 head='气泡水'（动词前）、tail='抖音种草'（动词后），
    // 二者合并 → '气泡水抖音种草'。营销词不进**动词前**的内容位，这是 Task 1 的边界。
    // 注意：tail 里的营销话术仍在返回值中，属于 Task 2 的逐镜提示词模板问题（计划 Task 2 处理），
    // 不在此处假装已解决 —— 故此处钉死 Task 1 的真实行为。
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
