import { useEffect, useRef, useState } from 'react';
import { Film, ImageOff, Play, Volume2, FileJson, ChevronLeft, ChevronRight } from 'lucide-react';
import type { ArtifactRef, PortValue } from '../types/graph';
import { cn, formatMs } from '../lib/utils';

/** 通用刷新盒：所有预览都住在“胶片格”里（签名元素） */
export function FilmFrame({
  children,
  className,
  tag,
}: {
  children: React.ReactNode;
  className?: string;
  tag?: string;
}) {
  return (
    <div className={cn('relative overflow-hidden rounded-md border border-bay-700 bg-bay-950', className)}>
      <div className="sprocket pointer-events-none absolute inset-y-0 left-0 w-[7px] z-10" />
      <div className="sprocket pointer-events-none absolute inset-y-0 right-0 w-[7px] z-10" />
      <div className="px-[9px] py-1">{children}</div>
      {tag && (
        <span className="absolute bottom-1 left-[10px] z-20 rounded-sm bg-bay-950/80 px-1 font-mono text-[11px] tracking-wide text-sodium-500">
          {tag}
        </span>
      )}
    </div>
  );
}

export function EmptyFrame({ label = '待运行', hint }: { label?: string; hint?: string }) {
  return (
    <FilmFrame>
      <div className="flex h-[92px] flex-col items-center justify-center gap-1 text-bone-400/70">
        <ImageOff className="size-4" />
        <span className="font-mono text-2xs uppercase tracking-widest">{label}</span>
        {hint && <span className="text-[12px] text-bone-400/50">{hint}</span>}
      </div>
    </FilmFrame>
  );
}

export function ImagePreview({
  items,
  index = 0,
  onIndex,
  onPin,
}: {
  items: ArtifactRef[];
  index?: number;
  onIndex?: (i: number) => void;
  onPin?: (a: ArtifactRef) => void;
}) {
  const cur = items[Math.min(index, items.length - 1)];
  return (
    <div className="group/frame relative">
      <FilmFrame tag={`IMG ${String(index + 1).padStart(2, '0')}/${String(items.length).padStart(2, '0')}`}>
        <img
          src={cur.url}
          alt={String(cur.meta?.prompt ?? 'generated frame')}
          loading="lazy"
          className="h-[132px] w-full object-cover"
        />
      </FilmFrame>
      {items.length > 1 && (
        <>
          <button
            className="absolute left-2 top-1/2 z-20 -translate-y-1/2 rounded-sm bg-bay-950/80 p-0.5 text-bone-300 opacity-0 transition group-hover/frame:opacity-100"
            onClick={() => onIndex?.((index - 1 + items.length) % items.length)}
            aria-label="上一张"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <button
            className="absolute right-2 top-1/2 z-20 -translate-y-1/2 rounded-sm bg-bay-950/80 p-0.5 text-bone-300 opacity-0 transition group-hover/frame:opacity-100"
            onClick={() => onIndex?.((index + 1) % items.length)}
            aria-label="下一张"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </>
      )}
      {onPin && (
        <button
          className="absolute right-2 top-1 z-20 rounded-sm border border-bay-600 bg-bay-950/85 px-1.5 py-0.5 font-mono text-[11px] text-bone-300 opacity-0 transition group-hover/frame:opacity-100 hover:border-sodium-600 hover:text-sodium-400"
          onClick={() => onPin(cur)}
        >
          钉为输入
        </button>
      )}
    </div>
  );
}

export function VideoPreview({ artifact }: { artifact: ArtifactRef }) {
  const [playing, setPlaying] = useState(false);
  const isReal = artifact.meta?.real === true || artifact.url?.endsWith('.mp4');
  const sizeMb = artifact.meta?.size_bytes ? Number(artifact.meta.size_bytes) / 1024 / 1024 : null;

  // 真实 FFmpeg 产物：直接给一个能播放的视频元素（可播放/拖动/全屏）
  if (isReal) {
    return (
      <FilmFrame
        tag={`REAL MP4 ${formatMs(artifact.durationMs)} · ${artifact.width}×${artifact.height}${
          sizeMb ? ` · ${sizeMb.toFixed(2)}MB` : ''
        }`}
      >
        <video
          src={artifact.url}
          controls
          playsInline
          preload="metadata"
          className="h-[132px] w-full bg-bay-950 object-cover"
        />
      </FilmFrame>
    );
  }

  return (
    <button
      className="group/vid block w-full text-left"
      onClick={() => setPlaying((p) => !p)}
      aria-label={playing ? '暂停预览' : '播放预览'}
    >
      <FilmFrame tag={`VID ${formatMs(artifact.durationMs)} · ${artifact.width}×${artifact.height}`}>
        <div className="relative">
          <img src={artifact.url} alt="video poster" className="h-[132px] w-full object-cover" />
          <div
            className={cn(
              'absolute inset-0 flex items-center justify-center transition-opacity',
              playing ? 'opacity-0' : 'opacity-100 group-hover/vid:opacity-90',
            )}
          >
            <span className="grid size-9 place-items-center rounded-full border border-sodium-500/70 bg-bay-950/60">
              <Play className="size-4 translate-x-[1px] text-sodium-400" />
            </span>
          </div>
          {playing && (
            <div className="absolute inset-x-0 bottom-0 h-[3px] bg-bay-700">
              <div className="h-full w-1/3 animate-leader bg-sodium-500" />
            </div>
          )}
        </div>
      </FilmFrame>
    </button>
  );
}

export function AudioPreview({ artifact, label }: { artifact: ArtifactRef; label?: string }) {
  const isReal = artifact.meta?.real === true;
  if (!isReal) {
    return (
      <FilmFrame tag={`AUD ${formatMs(artifact.durationMs)} · ${String(artifact.meta?.voice ?? 'tts')}`}>
        <div className="relative">
          <img src={artifact.thumbUrl ?? artifact.url} alt="waveform" className="h-[74px] w-full object-cover" />
          <span className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded-sm bg-bay-950/80 px-1 font-mono text-[11px] text-port-audio">
            <Volume2 className="size-3" />
            {label ?? '占位波形'}
          </span>
        </div>
      </FilmFrame>
    );
  }
  return <RealAudioPreview artifact={artifact} />;
}

/** 真实配音：<audio> 可播放 + 用 WebAudio 解码画出真实波形 */
function RealAudioPreview({ artifact }: { artifact: ArtifactRef }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const peaksRef = useRef<number[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    (async () => {
      try {
        const res = await fetch(artifact.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new Ctx();
        const audio = await ctx.decodeAudioData(buf.slice(0));
        const data = audio.getChannelData(0);
        const buckets = 120;
        const step = Math.max(1, Math.floor(data.length / buckets));
        const peaks: number[] = [];
        for (let i = 0; i < buckets; i++) {
          let max = 0;
          for (let j = 0; j < step; j++) max = Math.max(max, Math.abs(data[i * step + j] ?? 0));
          peaks.push(max);
        }
        peaksRef.current = peaks;
        void ctx.close();
        if (!cancelled) setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artifact.url]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const peaks = peaksRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#14110F';
    ctx.fillRect(0, 0, w, h);
    if (!peaks) {
      ctx.fillStyle = '#3A342F';
      ctx.fillRect(0, h / 2 - 1, w, 2);
      return;
    }
    const bw = w / peaks.length;
    peaks.forEach((p, i) => {
      const bh = Math.max(1.5, p * (h - 8) * 1.6);
      ctx.fillStyle = p > 0.6 ? '#5FD9A8' : '#3FBF8F';
      ctx.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 1), bh);
    });
    // 中线
    ctx.fillStyle = 'rgba(245,241,232,0.12)';
    ctx.fillRect(0, h / 2 - 0.5, w, 1);
  }, [state]);

  return (
    <div className="space-y-1">
      <FilmFrame tag={`VOICE ${formatMs(artifact.durationMs)} · ${String(artifact.meta?.voice ?? 'tts')}`}>
        <canvas ref={canvasRef} className="h-[58px] w-full" />
      </FilmFrame>
      <audio src={artifact.url} controls preload="none" className="h-[26px] w-full" />
      {state === 'error' && (
        <span className="block font-mono text-[11.5px] text-status-failed">波形解码失败（音频仍可播放）</span>
      )}
    </div>
  );
}

export function TextPreview({ text, rows = 5 }: { text: string; rows?: number }) {
  return (
    <FilmFrame tag={`TXT ${text.length} 字`}>
      <div
        className="overflow-hidden whitespace-pre-wrap break-words px-0.5 py-0.5 font-mono text-[12.5px] leading-[1.55] text-bone-300"
        style={{ maxHeight: rows * 17 }}
      >
        {text || '—'}
      </div>
    </FilmFrame>
  );
}

export function JsonPreview({ value, label }: { value: unknown; label?: string }) {
  const pretty = JSON.stringify(value, null, 1);
  return (
    <FilmFrame tag={label ?? 'JSON'}>
      <pre
        className="overflow-hidden whitespace-pre px-0.5 py-0.5 font-mono text-[12.5px] leading-[1.5] text-bone-300"
        style={{ maxHeight: 88 }}
      >
        {pretty}
      </pre>
    </FilmFrame>
  );
}

export function ReportPreview({ value }: { value: Record<string, unknown> }) {
  const scores = (value.scores ?? {}) as Record<string, number>;
  const verdict = String(value.verdict ?? 'pass');
  const tone =
    verdict === 'pass' ? 'text-status-success' : verdict === 'warn' ? 'text-status-stale' : 'text-status-failed';
  return (
    <FilmFrame tag={`QA · verdict=${verdict.toUpperCase()}`}>
      <div className="space-y-1 py-1">
        {Object.entries(scores).map(([k, v]) => (
          <div key={k} className="flex items-center gap-2">
            <span className="w-[86px] shrink-0 font-mono text-[11.5px] text-bone-400">{k}</span>
            <span className="h-[7px] flex-1 rounded-sm bg-bay-700">
              <span
                className={cn(
                  'block h-full rounded-sm',
                  v >= 0.85 ? 'bg-status-success' : v >= 0.72 ? 'bg-status-stale' : 'bg-status-failed',
                )}
                style={{ width: `${Math.min(100, v * 100)}%` }}
              />
            </span>
            <span className={cn('w-8 shrink-0 text-right font-mono text-[11.5px]', tone)}>{v.toFixed(2)}</span>
          </div>
        ))}
        <div className="flex items-center gap-1 pt-0.5 font-mono text-[11.5px] text-bone-400">
          <FileJson className="size-3" />
          total {String(value.total ?? '—')}
        </div>
      </div>
    </FilmFrame>
  );
}

/** 从端口值中取出图像/视频/音频 items（按结构判断而非按 kind，避免 final/report 之类被漏掉） */
export function itemsOf(v: PortValue | undefined): ArtifactRef[] {
  if (!v) return [];
  return 'items' in v ? v.items : [];
}

export function FilmIcon() {
  return <Film className="size-3.5" />;
}
