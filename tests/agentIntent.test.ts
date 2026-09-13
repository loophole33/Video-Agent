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

  it('重复调用结果稳定（防止给 MARKET_KEYS 加 g 标志导致 test() 状态漂移）', () => {
    const once = parseBrief('给这款气泡水做一个抖音种草视频，20秒');
    const twice = parseBrief('给这款气泡水做一个抖音种草视频，20秒');
    const thrice = parseBrief('给这款气泡水做一个抖音种草视频，20秒');
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
