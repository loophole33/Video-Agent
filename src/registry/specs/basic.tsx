import { useRef, useState } from 'react';
import { FileText, Image as ImageIcon, Upload, Video, AudioLines } from 'lucide-react';
import type { NodeTypeSpec } from '../types';
import { attachLocalFile } from '../../canvas/localImport';
import { EmptyFrame, ImagePreview, itemsOf, JsonPreview, TextPreview, VideoPreview, AudioPreview } from '../../nodes/Preview';
import { Segmented, Slider } from '../../nodes/controls';
import { cn } from '../../lib/utils';
import { useModelStore } from '../../engine/realVideo';
import { useUi } from '../../store/uiStore';

const TIERS = [
  { value: 'T-A', label: 'T-A', title: '高质 i2v（最贵，用在 hook/CTA）' },
  { value: 'T-B', label: 'T-B', title: '标准 i2v' },
  { value: 'T-C', label: 'T-C', title: '静图动效（几乎免费）' },
];

/* ─────────────── 文本 ─────────────── */
export const textSpec: NodeTypeSpec = {
  id: 'text',
  title: '文本',
  category: 'source',
  icon: FileText,
  accent: 'slate',
  description: '手写或由 LLM 生成的文案 / 需求文本',
  inputs: [{ id: 'in', label: '上游文本', type: 'text' }],
  outputs: [{ id: 'out', label: '文本', type: 'text' }],
  defaultParams: { content: '', mode: 'manual', skill: 'mva.copy.generate', model: 'qwen-max', temperature: 0.8 },
  fields: [
    { key: 'content', label: '内容', kind: 'textarea' },
    {
      key: 'mode',
      label: '生成方式',
      kind: 'select',
      options: [
        { value: 'manual', label: '手写 / 透传' },
        { value: 'llm', label: 'LLM 生成' },
      ],
    },
    { key: 'skill', label: 'Skill', kind: 'text', hint: '版本化能力单元，与 Agent 共用' },
    { key: 'temperature', label: '温度', kind: 'slider', min: 0, max: 1, step: 0.1 },
  ],
  Body: ({ data, outputs, inputs, setParam }) => {
    const text = outputs?.out && outputs.out.type === 'text' ? outputs.out.text : '';
    const upstream = inputs.in && inputs.in.type === 'text' ? inputs.in.text : '';
    const mode = String(data.params.mode ?? 'manual');
    return (
      <div className="space-y-2">
        {text ? (
          <TextPreview text={text} />
        ) : (
          <EmptyFrame label={mode === 'llm' ? '等待 LLM 生成' : '手写内容'} hint="运行后在此预览" />
        )}
        <textarea
          className="field h-[58px] resize-none"
          placeholder={upstream ? `透传上游：${upstream.slice(0, 28)}…` : '输入文案 / 需求…'}
          value={String(data.params.content ?? '')}
          onChange={(e) => setParam('content', e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
        />
        <div className="flex items-center justify-between">
          <Segmented
            size="sm"
            value={mode}
            options={[
              { value: 'manual', label: '手写' },
              { value: 'llm', label: 'LLM' },
            ]}
            onChange={(v) => setParam('mode', v)}
          />
          <span className="tc">{String(data.params.skill ?? '')}</span>
        </div>
      </div>
    );
  },
  estimateCost: (p) => (p.mode === 'llm' ? 0.02 : 0),
  groupable: true,
};

/* ─────────────── 图像 ─────────────── */
export const imageSpec: NodeTypeSpec = {
  id: 'image',
  title: '图像生成',
  category: 'generate',
  icon: ImageIcon,
  accent: 'blue',
  description: '上传图片或调用文生图模型生成关键帧（tier 决定成本）',
  inputs: [
    { id: 'prompt', label: '提示词', type: 'text' },
    { id: 'ref', label: '参考图', type: 'image' },
    { id: 'refs', label: '参考图组', type: 'image', multi: true },
  ],
  outputs: [
    { id: 'out', label: '图像', type: 'image' },
    { id: 'meta', label: '元数据', type: 'json' },
  ],
  defaultParams: {
    prompt: '',
    tier: 'T-B',
    ratio: '9:16',
    resolution: '1080x1920',
    count: 1,
    refStrength: 0.5,
  },
  fields: [
    { key: 'prompt', label: '提示词', kind: 'textarea' },
    { key: 'tier', label: '档位', kind: 'select', affectsCost: true, hint: 'T-A 高质 / T-B 标准 / T-C 静图动效' },
    { key: 'count', label: '数量', kind: 'number', min: 1, max: 4, affectsCost: true },
    {
      key: 'ratio',
      label: '比例',
      kind: 'select',
      options: [
        { value: '9:16', label: '9:16 竖屏' },
        { value: '16:9', label: '16:9 横屏' },
        { value: '1:1', label: '1:1 方形' },
      ],
    },
    { key: 'refStrength', label: '参考强度', kind: 'slider', min: 0, max: 1, step: 0.05, hint: '越高越贴参考图' },
  ],
  Body: ({ id, data, outputs, inputs, setParam, setUi }) => {
    const items = itemsOf(outputs?.out);
    const fileRef = useRef<HTMLInputElement>(null);
    const upstream = itemsOf(inputs.prompt).length ? '' : inputs.prompt?.type === 'text' ? inputs.prompt.text : '';
    const isReal = items.some((i) => i.meta?.real === true);
    const isPlaceholder = items.some((i) => i.meta?.placeholder === true);
    const isUploaded = items.some((i) => i.meta?.uploaded === true);
    const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
      // ⚠️ 必须 attachLocalFile（写【本】节点），绝不能 importLocalFiles（会新建节点）
      // 单选：patchRuntime 是浅合并、会整体替换 outputs，多选只会留下最后一个文件
      const file = e.target.files?.[0];
      if (file) {
        if (file.size > 20 * 1024 * 1024) {
          useUi
            .getState()
            .toast('warn', `文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB，上限 20MB），已取消上传`);
          e.target.value = '';
          return;
        }
        attachLocalFile(id, file);
        setUi({ previewIndex: 0 });
      }
      e.target.value = ''; // 允许再次选择同一个文件
    };
    return (
      <div className="space-y-2">
        {items.length ? (
          <ImagePreview
            items={items}
            index={data.ui.previewIndex ?? 0}
            onIndex={(i) => setUi({ previewIndex: i })}
          />
        ) : (
          <EmptyFrame label="无关键帧" hint="本地上传或运行生成" />
        )}
        <div className="flex items-center gap-1">
          {isReal && !isPlaceholder && (
            <span className="rounded-sm border border-status-success/50 bg-status-success/10 px-1.5 py-[1px] font-mono text-[11px] text-[#1f7a5c]">
              REAL · {String(items[0]?.meta?.adapter ?? 'gateway')}
            </span>
          )}
          {isPlaceholder && (
            <span className="rounded-sm border border-sodium-700/60 bg-sodium-500/10 px-1.5 py-[1px] font-mono text-[11px] text-sodium-700">
              占位画面 · 未配置模型
            </span>
          )}
          {isUploaded && (
            <span className="rounded-sm border border-bay-700 bg-bay-900/5 px-1.5 py-[1px] font-mono text-[11px] text-bay-900/60">
              本地素材
            </span>
          )}
          {items.length > 1 && <span className="tc">共 {items.length} 张</span>}
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={pick}
        />
        <button
          type="button"
          className="flex w-full items-center justify-center gap-1 rounded border border-bay-600 bg-bone-50 px-2 py-1 font-mono text-[12px] text-bay-900/70 transition-colors hover:border-sodium-600 hover:text-sodium-700"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => fileRef.current?.click()}
        >
          <Upload className="size-3" />
          {items.length ? '换一张（本地上传）' : '本地上传'}
        </button>

        <textarea
          className="field h-[46px] resize-none"
          placeholder={upstream ? `编译自上游：${upstream.slice(0, 30)}…` : '画面描述…'}
          value={String(data.params.prompt ?? '')}
          onChange={(e) => setParam('prompt', e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
        />
        <div className="flex items-center justify-between gap-2">
          <Segmented size="sm" value={String(data.params.tier)} options={TIERS} onChange={(v) => setParam('tier', v)} />
          <span className="tc">×{String(data.params.count ?? 1)}</span>
        </div>
      </div>
    );
  },
  estimateCost: (p) => {
    const unit = p.tier === 'T-A' ? 0.09 : p.tier === 'T-B' ? 0.06 : 0.02;
    return unit * Number(p.count ?? 1);
  },
  groupable: true,
};

/* ─────────────── 视频 ─────────────── */
export const videoSpec: NodeTypeSpec = {
  id: 'video',
  title: '视频生成',
  category: 'generate',
  icon: Video,
  accent: 'violet',
  description: '图生视频 / 文生视频 / 静图动效，按 tier 选择模型档位',
  inputs: [
    { id: 'first', label: '首帧', type: 'image' },
    { id: 'last', label: '尾帧', type: 'image' },
    { id: 'prompt', label: '提示词', type: 'text' },
    { id: 'ref', label: '参考视频', type: 'video' },
    { id: 'audio', label: '音频参考', type: 'audio' },
  ],
  outputs: [{ id: 'out', label: '视频', type: 'video' }],
  defaultParams: { mode: 'i2v', tier: 'T-B', durationS: 4, ratio: '9:16', fps: 30, motionStrength: 0.6 },
  fields: [
    {
      key: 'mode',
      label: '生成模式',
      kind: 'select',
      options: [
        { value: 'i2v', label: '图生视频（一致性最好）' },
        { value: 't2v', label: '文生视频' },
        { value: 'v2v', label: '视频风格化' },
        { value: 'static_motion', label: '静图动效（零模型成本）' },
      ],
    },
    { key: 'tier', label: '档位', kind: 'select', affectsCost: true },
    // 上限 15：网关 /healthz 的 max_duration_s 跟着模型族走（wan2.7+ → 15），
    // 旧模型族仍由适配器夹回 5/10 —— 前端不要写死比网关更窄的档位，否则新模型能力用不上。
    { key: 'durationS', label: '时长', kind: 'slider', min: 2, max: 15, step: 1, affectsCost: true },
    { key: 'motionStrength', label: '运动强度', kind: 'slider', min: 0, max: 1, step: 0.05 },
    { key: 'fps', label: '帧率', kind: 'select', options: [24, 25, 30, 60].map((v) => ({ value: String(v), label: `${v}fps` })) },
  ],
  Body: ({ data, outputs, setParam }) => {
    const art = itemsOf(outputs?.out)[0];
    return (
      <div className="space-y-2">
        {art ? <VideoPreview artifact={art} /> : <EmptyFrame label="无视频" hint="i2v 需要首帧输入" />}
        <div className="flex items-center justify-between gap-2">
          <Segmented
            size="sm"
            value={String(data.params.mode)}
            options={[
              { value: 'i2v', label: 'i2v' },
              { value: 't2v', label: 't2v' },
              { value: 'static_motion', label: '动效' },
            ]}
            onChange={(v) => setParam('mode', v)}
          />
          <span className="tc">{String(data.params.tier)}</span>
        </div>
        <Slider
          value={Number(data.params.durationS ?? 4)}
          min={2}
          max={15}
          step={1}
          suffix="s"
          onChange={(v) => setParam('durationS', v)}
        />
      </div>
    );
  },
  estimateCost: (p) => {
    const sec = Number(p.durationS ?? 4);
    // 没有视频模型适配器时，这条路径实际是本地 FFmpeg 静图动效 —— 估算必须跟着变成真话
    const hasVideoModel = useModelStore.getState().videoAvailable;
    if (!hasVideoModel || p.mode === 'static_motion' || p.tier === 'T-C') return 0.05 + sec * 0.01;
    return (p.tier === 'T-A' ? 0.9 : 0.45) * sec;
  },
  groupable: true,
};

/* ─────────────── 音频 ─────────────── */
export const audioSpec: NodeTypeSpec = {
  id: 'audio',
  title: '音频',
  category: 'source',
  icon: AudioLines,
  accent: 'green',
  description: 'TTS 配音 / 音乐 / 音效，输出音频与字幕时间戳',
  inputs: [
    { id: 'text', label: '台词/歌词', type: 'text' },
    { id: 'storyboard', label: '分镜（逐镜配音）', type: 'json' },
  ],
  outputs: [
    { id: 'out', label: '音频', type: 'audio' },
    { id: 'cues', label: '时间戳', type: 'json' },
  ],
  defaultParams: { mode: 'tts', text: '', voiceId: 'Cherry', speed: 1, emotion: '清爽', loudnessLufs: -14 },
  fields: [
    {
      key: 'mode',
      label: '类型',
      kind: 'select',
      options: [
        { value: 'tts', label: '配音 TTS' },
        { value: 'music', label: '音乐 BGM' },
        { value: 'sfx', label: '音效' },
      ],
    },
    { key: 'text', label: '台词', kind: 'textarea' },
    {
      key: 'voiceId',
      label: '音色',
      kind: 'select',
      options: [
        { value: 'Cherry', label: 'Cherry（女声·清亮）' },
        { value: 'Serena', label: 'Serena（女声·温柔）' },
        { value: 'Ethan', label: 'Ethan（男声·阳光）' },
        { value: 'Chelsie', label: 'Chelsie（女声·甜）' },
      ],
      hint: 'DashScope 合法音色；非法值会自动回退到默认音色',
    },
    { key: 'speed', label: '语速', kind: 'slider', min: 0.8, max: 1.3, step: 0.05 },
    { key: 'loudnessLufs', label: '响度 LUFS', kind: 'number', min: -24, max: -9 },
  ],
  Body: ({ data, outputs, inputs, setParam }) => {
    const items = itemsOf(outputs?.out);
    const [idx, setIdx] = useState(0);
    const art = items[Math.min(idx, Math.max(0, items.length - 1))];
    const text = String(data.params.text ?? '') || (inputs.text?.type === 'text' ? inputs.text.text : '');
    const cues = outputs?.cues && outputs.cues.type === 'json'
      ? (outputs.cues.value as { cues?: { shot_no: number; duration_ms: number }[] }).cues
      : undefined;
    const totalS = cues?.length ? (cues.reduce((a, c) => a + c.duration_ms, 0) / 1000).toFixed(1) : null;
    return (
      <div className="space-y-2">
        {art ? <AudioPreview artifact={art} label={items.length > 1 ? `第 ${idx + 1} 段` : undefined} /> : <EmptyFrame label="无音频" hint="台词可来自上游分镜" />}
        {items.length > 1 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="eyebrow mr-1">逐镜配音</span>
            {items.map((_, i) => (
              <button
                key={i}
                onClick={() => setIdx(i)}
                className={cn(
                  'rounded-sm border px-1.5 py-[1px] font-mono text-[11.5px] transition-colors',
                  i === idx
                    ? 'border-sodium-500 bg-sodium-500/15 text-sodium-700'
                    : 'border-bay-700 text-bay-900/55 hover:border-sodium-600',
                )}
                title={`第 ${i + 1} 段`}
              >
                {i + 1}
              </button>
            ))}
            {totalS && <span className="tc ml-1">共 {items.length} 段 · {totalS}s</span>}
          </div>
        )}
        <textarea
          className="field h-[42px] resize-none"
          placeholder="台词（留空则用上游分镜的逐镜台词）"
          value={String(data.params.text ?? '')}
          onChange={(e) => setParam('text', e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
        />
        <div className="flex items-center justify-between">
          <span className="tc">{String(data.params.voiceId)}</span>
          <span className="tc">{text.length} 字</span>
        </div>
      </div>
    );
  },
  estimateCost: (p) => {
    const len = String(p.text ?? '').length || 60;
    return Math.max(0.01, (len / 100) * 0.02);
  },
  groupable: true,
};
