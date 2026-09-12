import clsx, { type ClassValue } from 'clsx';

export const cn = (...args: ClassValue[]) => clsx(args);

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function uid(prefix: string, len = 8): string {
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `${prefix}_${out}`;
}

/** 稳定种子：同一 subject_ref / 节点始终同种子（一致性策略 L3 的前端体现） */
export function stableSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 2147483647;
}

/** 时间码 00:00:04:12（24fps 语义，符合剪辑母题） */
export function timecode(ms: number, fps = 24): string {
  const total = Math.max(0, Math.floor(ms));
  const f = Math.floor((total % 1000) / (1000 / fps));
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}:${p(f)}`;
}

export function formatCny(v: number): string {
  if (v === 0) return '¥0.00';
  if (v < 0.01) return `¥${v.toFixed(4)}`;
  return `¥${v.toFixed(2)}`;
}

export function formatMs(ms?: number): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function download(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
