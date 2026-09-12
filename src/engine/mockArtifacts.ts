/**
 * Mock 产物生成器 —— 全部为本地生成的 SVG data URL。
 * 目的：Demo 不依赖任何后端/外网即可呈现「图像 / 视频 / 音频 / 报告」的真实预览形态。
 * 视觉语言：胶片格（齿孔 + 三分线 + 角标），与画布母题一致。
 */
import type { ArtifactRef } from '../types/graph';
import { stableSeed } from '../lib/utils';

const enc = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function frameShell(w: number, h: number, inner: string, caption: string, tag: string) {
  const pad = Math.round(w * 0.03);
  const holes: string[] = [];
  const holeGap = 26;
  for (let y = 16; y < h - 16; y += holeGap) {
    holes.push(`<rect x="5" y="${y}" width="7" height="13" rx="2" fill="#0E0C0B" opacity="0.85"/>`);
    holes.push(
      `<rect x="${w - 12}" y="${y}" width="7" height="13" rx="2" fill="#0E0C0B" opacity="0.85"/>`,
    );
  }
  const thirds = [1, 2]
    .map((i) => {
      const x = (w / 3) * i;
      const y = (h / 3) * i;
      return `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="#E8A33D" stroke-opacity="0.10" stroke-width="1"/>
              <line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#E8A33D" stroke-opacity="0.10" stroke-width="1"/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <radialGradient id="vg" cx="50%" cy="45%" r="72%">
      <stop offset="55%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.55"/>
    </radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="#1A1614"/>
  ${inner}
  ${thirds}
  <rect width="${w}" height="${h}" fill="url(#vg)"/>
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" fill="none" stroke="#E8A33D" stroke-opacity="0.35"/>
  <g stroke="#F2BE6B" stroke-width="2" stroke-opacity="0.75">
    <path d="M ${pad} ${pad + 12} V ${pad} H ${pad + 12}"/>
    <path d="M ${w - pad - 12} ${h - pad} H ${w - pad} V ${h - pad - 12}"/>
  </g>
  ${holes.join('')}
  <text x="${w / 2}" y="${h - 14}" font-family="JetBrains Mono, monospace" font-size="${Math.round(
    w * 0.032,
  )}" fill="#CFC7B5" text-anchor="middle" opacity="0.9">${esc(caption.slice(0, 46))}</text>
  <text x="14" y="22" font-family="JetBrains Mono, monospace" font-size="${Math.round(
    w * 0.03,
  )}" fill="#E8A33D" opacity="0.95">${esc(tag)}</text>
</svg>`;
}

export function makeImageArtifact(opts: {
  prompt: string;
  seed: number;
  label: string;
  index?: number;
  w?: number;
  h?: number;
  subject?: string;
}): ArtifactRef {
  const w = opts.w ?? 540;
  const h = opts.h ?? 960;
  const rnd = mulberry(opts.seed + (opts.index ?? 0) * 7919);
  const cx = w * (0.34 + rnd() * 0.32);
  const cy = h * (0.36 + rnd() * 0.28);
  const bw = w * (0.18 + rnd() * 0.16);
  const bh = h * (0.22 + rnd() * 0.2);
  const hum = 0.55 + rnd() * 0.4;
  const shapes = `
  <ellipse cx="${cx}" cy="${cy + bh * 0.9}" rx="${bw * 1.5}" ry="${bh * 0.16}" fill="#000" opacity="0.45"/>
  <rect x="${cx - bw / 2}" y="${cy - bh / 2}" width="${bw}" height="${bh}" rx="${bw * 0.18}"
        fill="#4C9BE8" fill-opacity="${hum}" stroke="#F2BE6B" stroke-opacity="0.5"/>
  <rect x="${cx - bw * 0.32}" y="${cy - bh * 0.1}" width="${bw * 0.64}" height="${bh * 0.26}" rx="4"
        fill="#F5F1E8" fill-opacity="0.82"/>
  <circle cx="${cx + bw * 0.9}" cy="${cy - bh * 0.6}" r="${bw * 0.26}" fill="#F2BE6B" fill-opacity="0.28"/>
  <g opacity="0.35" stroke="#CFC7B5" stroke-width="1">
    ${Array.from({ length: 7 })
      .map(
        (_, i) =>
          `<line x1="0" y1="${(h / 7) * (i + 1)}" x2="${w}" y2="${(h / 7) * (i + 1)}" stroke-opacity="0.06"/>`,
      )
      .join('')}
  </g>`;
  return {
    id: `art_${opts.label}_${opts.seed}${opts.index ?? ''}`,
    kind: 'image',
    url: enc(frameShell(w, h, shapes, opts.prompt, opts.subject ?? opts.label)),
    mime: 'image/svg+xml',
    width: w,
    height: h,
    digest: `md5-${(opts.seed % 100000).toString(16)}`,
    meta: { mock: true, seed: opts.seed, portrait: false },
  };
}

export function makeVideoArtifact(opts: {
  prompt: string;
  seed: number;
  seconds: number;
  label: string;
  tier: string;
}): ArtifactRef {
  const w = 540;
  const h = 960;
  const rnd = mulberry(opts.seed + 31);
  const shapes = `
  <rect x="0" y="0" width="${w}" height="${h}" fill="#241F1C"/>
  <circle cx="${w * (0.3 + rnd() * 0.4)}" cy="${h * 0.42}" r="${w * 0.3}" fill="#B06BE8" fill-opacity="0.22"/>
  <circle cx="${w * (0.4 + rnd() * 0.3)}" cy="${h * 0.62}" r="${w * 0.22}" fill="#E8A33D" fill-opacity="0.22"/>
  <g opacity="0.5">${Array.from({ length: 5 })
    .map((_, i) => {
      const y = h * (0.3 + i * 0.1);
      return `<path d="M0 ${y} Q ${w / 2} ${y - 34} ${w} ${y}" stroke="#F5F1E8" stroke-opacity="0.10" fill="none" stroke-width="1.5"/>`;
    })
    .join('')}</g>
  <g transform="translate(${w / 2}, ${h / 2})">
    <circle r="42" fill="#0E0C0B" fill-opacity="0.55" stroke="#F2BE6B" stroke-opacity="0.8"/>
    <path d="M -12 -18 L 22 0 L -12 18 Z" fill="#F2BE6B"/>
  </g>`;
  const slug = opts.label.replace(/[^\w\u4e00-\u9fa5]+/g, '').slice(0, 10) || 'clip';
  return {
    id: `art_vid_${slug}_${opts.seed}`,
    kind: 'video',
    url: enc(frameShell(w, h, shapes, opts.prompt, `${opts.tier} · ${opts.seconds}s`)),
    mime: 'video/mp4',
    width: 1080,
    height: 1920,
    durationMs: Math.round(opts.seconds * 1000),
    digest: `md5-v${(opts.seed % 100000).toString(16)}`,
    meta: { mock: true, seed: opts.seed, tier: opts.tier, hasAudio: false },
  };
}

export function makeAudioArtifact(opts: {
  text: string;
  seed: number;
  durationMs: number;
  label: string;
  voice?: string;
}): ArtifactRef {
  const w = 540;
  const h = 180;
  const rnd = mulberry(opts.seed + 17);
  const bars: string[] = [];
  const n = 96;
  for (let i = 0; i < n; i++) {
    const env = Math.sin((i / n) * Math.PI * 3) * 0.5 + 0.5;
    const a = (0.18 + rnd() * 0.82) * env;
    const bh = Math.max(3, a * (h - 56));
    bars.push(
      `<rect x="${8 + i * ((w - 16) / n)}" y="${(h - 30) / 2 - bh / 2 + 8}" width="${(w - 16) / n - 1.5}"
        height="${bh}" rx="1" fill="#3FBF8F" fill-opacity="${0.35 + a * 0.6}"/>`,
    );
  }
  const inner = `<rect width="${w}" height="${h}" fill="#171513"/>${bars.join('')}
    <text x="12" y="${h - 10}" font-family="JetBrains Mono, monospace" font-size="11" fill="#3FBF8F">${esc(
      `${opts.voice ?? 'qingxin'} · ${(opts.durationMs / 1000).toFixed(1)}s`,
    )}</text>`;
  return {
    id: `art_aud_${opts.seed}`,
    kind: 'audio',
    url: enc(frameShell(w, h, inner, opts.text, opts.label)),
    thumbUrl: enc(frameShell(w, h, inner, opts.text, opts.label)),
    mime: 'audio/wav',
    durationMs: opts.durationMs,
    digest: `md5-a${(opts.seed % 100000).toString(16)}`,
    meta: { mock: true, waveform: true, voice: opts.voice ?? 'qingxin' },
  };
}

export function makeTextArtifact(text: string): ArtifactRef {
  return {
    id: `art_txt_${stableSeed(text).toString(16)}`,
    kind: 'text',
    url: '',
    mime: 'text/plain',
    digest: `md5-t${(stableSeed(text) % 100000).toString(16)}`,
    meta: { length: text.length },
  };
}

export function makeJsonArtifact(value: unknown, kind: 'json' | 'report' = 'json'): ArtifactRef {
  const s = JSON.stringify(value);
  return {
    id: `art_js_${stableSeed(s).toString(16)}`,
    kind,
    url: '',
    mime: 'application/json',
    digest: `md5-j${(stableSeed(s) % 100000).toString(16)}`,
    meta: { bytes: s.length },
  };
}

export function makeReportArtifact(report: Record<string, unknown>, shotNo: number): ArtifactRef {
  const scores = report.scores as Record<string, number>;
  const keys = Object.keys(scores);
  const w = 540;
  const h = 260;
  const rows = keys
    .map((k, i) => {
      const v = scores[k];
      const y = 52 + i * 34;
      const col = v >= 0.85 ? '#3FBF8F' : v >= 0.72 ? '#D9C36A' : '#E2554B';
      return `<text x="16" y="${y + 11}" font-family="JetBrains Mono, monospace" font-size="12" fill="#CFC7B5">${esc(
        k,
      )}</text>
      <rect x="180" y="${y}" width="300" height="12" rx="2" fill="#2C2724"/>
      <rect x="180" y="${y}" width="${300 * v}" height="12" rx="2" fill="${col}"/>
      <text x="492" y="${y + 11}" font-family="JetBrains Mono, monospace" font-size="12" fill="${col}">${v.toFixed(
        2,
      )}</text>`;
    })
    .join('');
  const inner = `<rect width="${w}" height="${h}" fill="#171513"/>${rows}`;
  return {
    id: `art_qa_${shotNo}`,
    kind: 'report',
    url: enc(frameShell(w, h, inner, String(report.detail ?? ''), `QA shot_${shotNo}`)),
    mime: 'image/svg+xml',
    width: w,
    height: h,
    digest: `md5-q${shotNo}`,
    meta: report,
  };
}
