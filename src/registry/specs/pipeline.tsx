import { Clapperboard, Wand2, ShieldCheck, Layers } from 'lucide-react';
import type { NodeTypeSpec } from '../types';
import { EmptyFrame, JsonPreview, ReportPreview, TextPreview, VideoPreview, itemsOf } from '../../nodes/Preview';
import { Segmented, Slider } from '../../nodes/controls';

interface StoryboardShape {
  total_duration_s?: number;
  shots?: { shot_no: number; duration_s: number; visual: string; camera: string; on_screen_text: string }[];
}

/* ─────────────── 分镜脚本 ─────────────── */
export const scriptSpec: NodeTypeSpec = {
  id: 'script',
  title: '分镜脚本',
  category: 'process',
  icon: Clapperboard,
  accent: 'amber',
  description: '输入大纲/需求，产出结构化分镜（镜号·时长·画面·运镜·字幕）',
  inputs: [
    { id: 'brief', label: '需求', type: 'text' },
    { id: 'copy', label: '文案', type: 'text' },
    { id: 'assets', label: '素材摘要', type: 'json' },
  ],
  outputs: [
    { id: 'out', label: '分镜', type: 'json' },
    { id: 'narration', label: '旁白', type: 'text' },
  ],
  defaultParams: {
    targetDurationS: 20,
    shotCount: 6,
    style: '清爽',
    brief: '',
    product: '',
    usp: '',
    platform: 'douyin',
    skill: 'mva.script.storyboard',
  },
  fields: [
    { key: 'brief', label: '需求 / 大纲', kind: 'textarea' },
    { key: 'product', label: '产品名', kind: 'text', hint: '缺省时从大纲里猜' },
    { key: 'usp', label: '核心卖点', kind: 'text', hint: '多个用「、」分隔' },
    {
      key: 'platform',
      label: '平台',
      kind: 'select',
      options: [
        { value: 'douyin', label: '抖音' },
        { value: 'shipinhao', label: '视频号' },
        { value: 'xiaohongshu', label: '小红书' },
        { value: 'generic', label: '通用' },
      ],
    },
    { key: 'targetDurationS', label: '目标时长', kind: 'slider', min: 5, max: 120, step: 5, affectsCost: true },
    { key: 'shotCount', label: '镜头数', kind: 'number', min: 3, max: 12, affectsCost: true },
    { key: 'style', label: '风格', kind: 'text' },
    { key: 'skill', label: 'Skill', kind: 'text', hint: '版本化能力单元，与 Agent 共用' },
  ],
  Body: ({ data, outputs, setParam }) => {
    const sb = (outputs?.out && outputs.out.type === 'json' ? outputs.out.value : undefined) as StoryboardShape | undefined;
    const shots = sb?.shots ?? [];
    return (
      <div className="space-y-2">
        {shots.length ? (
          <div className="rounded-md border border-bay-700 bg-bay-950 px-2 py-1.5">
            <div className="mb-1 flex items-center justify-between">
              <span className="eyebrow">storyboard</span>
              <span className="tc-amber">
                {shots.length} 镜 · {sb?.total_duration_s ?? 0}s
              </span>
            </div>
            <ul className="space-y-[3px]">
              {shots.slice(0, 6).map((s) => (
                <li key={s.shot_no} className="flex items-center gap-2 font-mono text-[12px] text-bone-300">
                  <span className="w-4 shrink-0 text-sodium-500">{String(s.shot_no).padStart(2, '0')}</span>
                  <span className="w-9 shrink-0 text-bone-400">{s.duration_s}s</span>
                  <span className="truncate">{s.visual}</span>
                  <span className="ml-auto shrink-0 text-bone-400/70">{s.camera}</span>
                </li>
              ))}
              {shots.length > 6 && (
                <li className="font-mono text-[12px] text-bone-400/60">… 还有 {shots.length - 6} 镜</li>
              )}
            </ul>
          </div>
        ) : (
          <EmptyFrame label="无分镜" hint="运行后产出结构化分镜" />
        )}
        <Slider
          value={Number(data.params.targetDurationS ?? 20)}
          min={5}
          max={120}
          step={5}
          suffix="s"
          onChange={(v) => setParam('targetDurationS', v)}
        />
        <div className="flex items-center justify-between">
          <span className="tc">{String(data.params.shotCount)} 镜</span>
          <span className="tc">{String(data.params.style)}</span>
        </div>
      </div>
    );
  },
  estimateCost: (p) => 0.03 + Number(p.shotCount ?? 6) * 0.002,
  groupable: true,
};

/* ─────────────── 提示词编译 ─────────────── */
export const promptCompileSpec: NodeTypeSpec = {
  id: 'prompt_compile',
  title: '提示词编译',
  category: 'process',
  icon: Wand2,
  accent: 'cyan',
  description: '把文案/分镜/一致性词典编译为目标模型可用的正向与负向提示词',
  inputs: [
    { id: 'in', label: '任意上游', type: 'any', required: true },
    { id: 'style', label: '风格', type: 'json' },
  ],
  outputs: [
    { id: 'text', label: '正向提示词', type: 'text' },
    { id: 'negative', label: '负向提示词', type: 'text' },
    { id: 'params', label: '参数建议', type: 'json' },
  ],
  defaultParams: { target: 'video', stylePreset: '清爽', modelFamily: 'kling', maxChars: 800, includeCamera: true },
  fields: [
    {
      key: 'target',
      label: '目标',
      kind: 'select',
      options: [
        { value: 'image', label: '图像模型' },
        { value: 'video', label: '视频模型' },
      ],
    },
    { key: 'stylePreset', label: '风格预设', kind: 'text' },
    {
      key: 'modelFamily',
      label: '模型族',
      kind: 'select',
      options: [
        { value: 'kling', label: 'kling' },
        { value: 'jimeng', label: 'jimeng' },
        { value: 'runway', label: 'runway' },
        { value: 'pika', label: 'pika' },
      ],
      hint: '编译期读能力表，不写死厂商',
    },
    { key: 'maxChars', label: '长度上限', kind: 'number', min: 100, max: 2000 },
    { key: 'includeCamera', label: '包含运镜', kind: 'toggle' },
  ],
  Body: ({ data, outputs, setParam }) => {
    const pos = outputs?.text && outputs.text.type === 'text' ? outputs.text.text : '';
    const neg = outputs?.negative && outputs.negative.type === 'text' ? outputs.negative.text : '';
    return (
      <div className="space-y-2">
        {pos ? <TextPreview text={pos} rows={4} /> : <EmptyFrame label="未编译" hint="运行后产出 prompt" />}
        {neg && (
          <div className="rounded-md border border-bay-700 bg-bay-950 px-2 py-1">
            <span className="eyebrow">negative</span>
            <p className="mt-0.5 line-clamp-2 font-mono text-[12px] text-bone-400">{neg}</p>
          </div>
        )}
        <div className="flex items-center justify-between">
          <Segmented
            size="sm"
            value={String(data.params.target)}
            options={[
              { value: 'image', label: '图像' },
              { value: 'video', label: '视频' },
            ]}
            onChange={(v) => setParam('target', v)}
          />
          <span className="tc">{String(data.params.modelFamily)}</span>
        </div>
      </div>
    );
  },
  estimateCost: () => 0.02,
  groupable: true,
};

/* ─────────────── 质检 ─────────────── */
export const qaCheckSpec: NodeTypeSpec = {
  id: 'qa_check',
  title: '质检',
  category: 'check',
  icon: ShieldCheck,
  accent: 'rose',
  description: '一致性 / 画质 / 文案准确 / 音画同步 / 合规 五项打分，可阻断',
  inputs: [{ id: 'in', label: '待检内容', type: 'any', required: true, multi: true }],
  outputs: [
    { id: 'report', label: '质检报告', type: 'json' },
    { id: 'pass', label: '透传', type: 'any' },
  ],
  defaultParams: { blockOnFail: true, adLawCheck: true, safeAreaCheck: true, rules: ['consistency', 'quality', 'text', 'sync', 'compliance'] },
  fields: [
    { key: 'blockOnFail', label: '不达标即阻断', kind: 'toggle' },
    { key: 'adLawCheck', label: '广告法词库', kind: 'toggle', hint: '最/第一/国家级/100% 等绝对化用语' },
    { key: 'safeAreaCheck', label: '平台安全区', kind: 'toggle', hint: '抖音上下 250px 不放关键文字' },
  ],
  Body: ({ data, outputs, setParam }) => {
    const report = outputs?.report && outputs.report.type === 'json' ? (outputs.report.value as Record<string, unknown>) : undefined;
    return (
      <div className="space-y-2">
        {report ? <ReportPreview value={report} /> : <EmptyFrame label="未质检" hint="接入上游产物后运行" />}
        <div className="flex items-center justify-between">
          <span className="eyebrow">block on fail</span>
          <Segmented
            size="sm"
            value={String(Boolean(data.params.blockOnFail))}
            options={[
              { value: 'true', label: '阻断' },
              { value: 'false', label: '仅告警' },
            ]}
            onChange={(v) => setParam('blockOnFail', v === 'true')}
          />
        </div>
      </div>
    );
  },
  estimateCost: () => 0.12,
  groupable: true,
};

/* ─────────────── 合成导出 ─────────────── */
export const composeSpec: NodeTypeSpec = {
  id: 'compose',
  title: '合成导出',
  category: 'output',
  icon: Layers,
  accent: 'amber',
  description: '拼接多镜头 + 字幕 + BGM + 转场，导出平台规格成片',
  inputs: [
    { id: 'video', label: '视频', type: 'video' },
    { id: 'videos', label: '多段视频', type: 'video', multi: true },
    { id: 'audio', label: '配音/BGM', type: 'audio' },
    { id: 'image', label: '封面', type: 'image' },
    { id: 'storyboard', label: '分镜', type: 'json' },
  ],
  outputs: [{ id: 'out', label: '成片', type: 'video' }],
  defaultParams: {
    subtitle: true,
    transition: 'dissolve',
    bgmId: 'music_summer_01',
    brandKitId: 'demo_brand',
    ratio: '9:16',
    resolution: '1080x1920',
    loudnessLufs: -14,
  },
  fields: [
    {
      key: 'resolution',
      label: '分辨率',
      kind: 'select',
      options: [
        { value: '1080x1920', label: '1080×1920 竖屏' },
        { value: '720x1280', label: '720×1280 竖屏' },
        { value: '1920x1080', label: '1920×1080 横屏' },
      ],
    },
    { key: 'subtitle', label: '烧录字幕', kind: 'toggle' },
    {
      key: 'transition',
      label: '转场',
      kind: 'select',
      options: [
        { value: 'cut', label: '硬切' },
        { value: 'dissolve', label: '叠化' },
        { value: 'slide', label: '滑动' },
        { value: 'zoom', label: '推近' },
      ],
    },
    { key: 'bgmId', label: 'BGM', kind: 'text', hint: '仅使用已授权曲库曲目' },
    { key: 'loudnessLufs', label: '响度', kind: 'number', min: -24, max: -9, hint: '短视频平台常用 -14 LUFS' },
  ],
  Body: ({ data, outputs, setParam }) => {
    const art = itemsOf(outputs?.out)[0];
    return (
      <div className="space-y-2">
        {art ? <VideoPreview artifact={art} /> : <EmptyFrame label="未合成" hint="需要至少一段视频输入" />}
        <div className="flex flex-wrap items-center gap-1">
          <span className="chip">{String(data.params.resolution)}</span>
          <span className="chip">{String(data.params.transition)}</span>
          <span className="chip">{String(data.params.loudnessLufs)} LUFS</span>
          <span className="chip">{String(data.params.bgmId)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="eyebrow">subtitle</span>
          <Segmented
            size="sm"
            value={String(Boolean(data.params.subtitle))}
            options={[
              { value: 'true', label: 'ON' },
              { value: 'false', label: 'OFF' },
            ]}
            onChange={(v) => setParam('subtitle', v === 'true')}
          />
        </div>
      </div>
    );
  },
  estimateCost: () => 0.02,
  groupable: true,
};

export { JsonPreview };
