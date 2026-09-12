/**
 * FFmpeg 渲染桥（dev-only）—— 把「真合成」这一段从 Mock 换成真的 FFmpeg。
 *
 * 为什么挂在 Vite dev server 上而不是单独起服务：
 *   · 同源，零 CORS 配置；不额外占端口、不多一个进程要管
 *   · 复用 `npm run dev` 的生命周期（真实产品里这一段属于后端 RenderService，见 docs/phase-4 §4.10）
 *   · 生产构建不包含本文件（apply: 'serve'）
 *
 * 职责边界（很重要）：
 *   · 浏览器侧负责把 SVG 帧栅格化成 PNG（浏览器天生会渲染 SVG，ffmpeg 不一定带 librsvg）
 *   · 本桥负责：Ken Burns 运镜 → 转场拼接 → 字幕(ASS/libass) → 音轨合成 → 响度归一 → H.264 编码
 *   · 产物落在项目根的 .mva-renders/<jobId>/out.mp4，经 /renders/<jobId>/out.mp4 提供（支持 Range，可拖动进度条）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

/* ─────────────── 协议类型（与前端约定） ─────────────── */

export type Motion = 'zoom_in' | 'zoom_out' | 'pan_right' | 'pan_left' | 'static';

/** 时间线上的一段：要么是静帧（做 Ken Burns 动效），要么是已存在的视频片段（trim 后拼接） */
export type Segment =
  | { kind: 'still'; imagePng: string; durationS: number; motion?: Motion; text?: string }
  | { kind: 'clip'; url: string; durationS: number; text?: string };

export interface RenderRequest {
  runId?: string;
  resolution?: string; // '1080x1920'
  fps?: number;
  transition?: 'cut' | 'dissolve' | 'slide' | 'zoom';
  transitionDurS?: number;
  subtitle?: boolean;
  loudnessLufs?: number;
  watermark?: string | null;
  bgm?: { mode: 'synth' | 'none'; mood?: string; bpm?: number; gainDb?: number };
  /** 配音轨：每段放在时间线 startS 处；BGM 会自动 sidechain 闪避（人声起来时压低） */
  voice?: { url: string; startS: number; text?: string }[];
  segments: Segment[];
}

export interface RenderResponse {
  ok: boolean;
  url?: string;
  file?: string;
  width?: number;
  height?: number;
  fps?: number;
  durationMs?: number;
  sizeBytes?: number;
  shots?: number;
  command?: string;
  logTail?: string;
  error?: string;
}

/* ─────────────── 工具 ─────────────── */

const MAX_BODY = 96 * 1024 * 1024; // 96MB
const RENDER_TIMEOUT_MS = 240_000;
const KEEP_JOBS = 20;

function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`请求体超过 ${Math.round(limit / 1024 / 1024)}MB`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, code: number, body: unknown) {
  const data = JSON.stringify(body);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(data);
}

function run(
  bin: string,
  args: string[],
  cwd: string,
  logPath: string,
  timeoutMs = RENDER_TIMEOUT_MS,
): Promise<{ code: number; log: string }> {
  return new Promise((resolve, reject) => {
    // 注意：stdio 走文件而不是 pipe —— 在受限环境下命名管道不可用，文件端更稳且天然留痕
    const fd = fs.openSync(logPath, 'a');
    const child = spawn(bin, args, { cwd, stdio: ['ignore', fd, fd] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${bin} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      fs.closeSync(fd);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.closeSync(fd);
      resolve({ code: code ?? -1, log: fs.readFileSync(logPath, 'utf8') });
    });
  });
}

const ASS_TS = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
};

const esc = (s: string) =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\r?\n/g, '\\N');

/** 生成 ASS：逐镜头字幕 + 常驻 AI 生成标识（合规要求，用 libass 一并烧录，避免 drawtext 字体路径转义地狱） */
function buildAss(opts: {
  width: number;
  height: number;
  cues: { start: number; end: number; text: string }[];
  watermark: string | null;
  total: number;
}): string {
  const { width, height, cues, watermark, total } = opts;
  const fontMain = Math.round(height * 0.036); // ≈69px @1920
  const fontLabel = Math.round(height * 0.016);
  const marginV = Math.round(height * 0.2); // 留出平台 UI 遮挡区（抖音下沿）
  const lines: string[] = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Main,Microsoft YaHei,${fontMain},&H00FFFFFF,&H000000FF,&H00202020,&H80000000,0,0,0,0,100,100,0,0,1,${Math.round(height * 0.003)},${Math.round(height * 0.0015)},2,${Math.round(width * 0.07)},${Math.round(width * 0.07)},${marginV},1`,
    `Style: Label,Microsoft YaHei,${fontLabel},&H78FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,${Math.round(width * 0.04)},0,${Math.round(width * 0.04)},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  if (watermark) {
    lines.push(`Dialogue: 0,${ASS_TS(0)},${ASS_TS(total)},Label,,0,0,0,,${esc(watermark)}`);
  }
  for (const c of cues) {
    if (!c.text?.trim()) continue;
    lines.push(`Dialogue: 0,${ASS_TS(c.start)},${ASS_TS(c.end)},Main,,0,0,0,,${esc(c.text)}`);
  }
  return lines.join('\n') + '\n';
}

/** zoompan 表达式：无逗号（避免 ffmpeg 滤镜解析歧义） */
function motionExpr(motion: Motion | undefined, frames: number): { z: string; x: string; y: string } {
  const centerX = 'iw/2-(iw/zoom/2)';
  const centerY = 'ih/2-(ih/zoom/2)';
  switch (motion) {
    case 'zoom_out':
      return { z: `max(1.22-0.0013*on,1.0)`, x: centerX, y: centerY };
    case 'pan_right':
      return { z: '1.12', x: `(iw-iw/zoom)*on/${frames}`, y: centerY };
    case 'pan_left':
      return { z: '1.12', x: `(iw-iw/zoom)*(1-on/${frames})`, y: centerY };
    case 'static':
      return { z: '1.0', x: centerX, y: centerY };
    default:
      return { z: `min(1+0.0013*on,1.22)`, x: centerX, y: centerY };
  }
}

const TRANSITION_MAP: Record<string, string> = {
  dissolve: 'fade',
  slide: 'slideleft',
  zoom: 'zoomin',
};

/* ─────────────── 主渲染流程 ─────────────── */

async function render(
  root: string,
  rendersDir: string,
  body: RenderRequest,
  onLog?: (line: string) => void,
): Promise<RenderResponse> {
  const segments = body.segments ?? [];
  if (!segments.length) return { ok: false, error: '没有可合成的片段（segments 为空）' };

  const [w, h] = (body.resolution ?? '1080x1920').split('x').map(Number);
  const fps = body.fps ?? 30;
  const td = body.transition === 'cut' ? 0 : (body.transitionDurS ?? 0.5);
  const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const workDir = path.join(rendersDir, jobId);
  await fsp.mkdir(workDir, { recursive: true });
  const logPath = path.join(workDir, 'ffmpeg.log');

  // ① 落盘素材：静帧来自浏览器栅格化的 PNG；片段来自本地渲染目录或远端 URL
  const inputs: string[] = [];
  const durations: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.kind === 'still') {
      const name = `seg_${String(i).padStart(2, '0')}.png`;
      const b64 = seg.imagePng.replace(/^data:image\/\w+;base64,/, '');
      await fsp.writeFile(path.join(workDir, name), Buffer.from(b64, 'base64'));
      inputs.push(name);
      durations.push(Math.max(0.5, seg.durationS));
    } else {
      const name = `seg_${String(i).padStart(2, '0')}.mp4`;
      const target = path.join(workDir, name);
      try {
        const local = resolveLocalClip(seg.url, root, rendersDir);
        if (local) {
          await fsp.copyFile(local, target); // 同机片段直接拷贝，不走网络
        } else {
          const res = await fetch(seg.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await fsp.writeFile(target, Buffer.from(await res.arrayBuffer()));
        }
      } catch (e) {
        return { ok: false, error: `片段下载失败（${seg.url}）：${(e as Error).message}` };
      }
      // 用 ffprobe 读真实时长：xfade 的 offset 必须基于真实时长算，不能信调用方声明
      const probed = await probeDuration(target, workDir, onLog);
      inputs.push(name);
      durations.push(Math.max(0.5, Math.min(seg.durationS, probed ?? seg.durationS)));
    }
  }

  // ② 时间轴（xfade 会吃掉重叠时长，字幕时序必须用同一条公式，否则音画/字幕错位）
  const starts: number[] = [];
  let cursor = 0;
  durations.forEach((d, i) => {
    starts.push(i === 0 ? 0 : cursor - td);
    cursor = (i === 0 ? d : cursor + d - td);
  });
  const total = durations.reduce((a, b) => a + b, 0) - td * (durations.length - 1);

  // ③ 字幕（含 AI 标识）
  const cues = segments.map((s, i) => ({ start: starts[i], end: starts[i] + durations[i], text: s.text ?? '' }));
  await fsp.writeFile(
    path.join(workDir, 'sub.ass'),
    buildAss({ width: w, height: h, cues, watermark: body.watermark ?? null, total }),
    'utf8',
  );

  // ④ 构建滤镜图
  const args: string[] = ['-hide_banner', '-y'];
  for (const f of inputs) args.push('-i', f);

  const bgm = body.bgm ?? { mode: 'synth' as const };
  const bgmExpr =
    `0.16*sin(2*PI*196*t)+0.13*sin(2*PI*247*t)+0.11*sin(2*PI*294*t)` +
    `+0.09*sin(2*PI*392*t)*(0.5+0.5*sin(2*PI*0.25*t))` +
    `+0.22*sin(2*PI*55*t)*exp(-9*(t-0.6*floor(t/0.6)))`;

  // ④-1 配音输入：逐个加载，并记录其 ffmpeg 输入序号（在视频段之后）
  const voiceTracks = body.voice ?? [];
  const voiceIdx: number[] = [];
  let nextInputIdx = segments.length;
  for (const v of voiceTracks) {
    const name = `voice_${String(voiceIdx.length).padStart(2, '0')}.wav`;
    const target = path.join(workDir, name);
    try {
      const local = resolveLocalClip(v.url, root, rendersDir);
      if (local) await fsp.copyFile(local, target);
      else {
        const res = await fetch(v.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await fsp.writeFile(target, Buffer.from(await res.arrayBuffer()));
      }
    } catch (e) {
      onLog?.(`配音片段加载失败（${v.url}）：${(e as Error).message}`);
      continue;
    }
    args.push('-i', name);
    voiceIdx.push(nextInputIdx++);
  }
  if (bgm.mode === 'synth') {
    args.push('-f', 'lavfi', '-i', `aevalsrc=${bgmExpr}:s=48000:d=${total.toFixed(3)}`);
    nextInputIdx += 1;
  }

  const chains: string[] = [];
  segments.forEach((seg, i) => {
    const d = durations[i];
    if (seg.kind === 'still') {
      const frames = Math.round(d * fps);
      const { z, x, y } = motionExpr(seg.motion, frames);
      // 先放大到 2x 再 zoompan 裁剪：避免数字变焦把 1080p 拉伸糊掉
      chains.push(
        `[${i}:v]scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,` +
          `crop=${w * 2}:${h * 2},` +
          `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${w}x${h}:fps=${fps},` +
          `setsar=1,format=yuv420p[v${i}]`,
      );
    } else {
      // 真实片段：统一画幅 + 统一帧率 + 裁剪到目标时长
      chains.push(
        `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},` +
          `fps=${fps},setsar=1,format=yuv420p,trim=duration=${d.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`,
      );
    }
  });

  let videoOut: string;
  if (td === 0) {
    chains.push(`${segments.map((_, i) => `[v${i}]`).join('')}concat=n=${segments.length}:v=1:a=0[vcat]`);
    videoOut = '[vcat]';
  } else {
    // xfade 链接法：加入第 k 段时，offset = (前 k 段时长之和) − k·td
    //   例：d=3.3,td=0.5 → offset₁=2.8（=d₀−td）、offset₂=5.6（=d₀+d₁−2td）……
    //   ⚠️ 若 offset 超过当前累积流长，xfade 会直接截断 —— 这是最容易写错的地方
    let label = '[v0]';
    let prefix = durations[0];
    for (let k = 1; k < segments.length; k++) {
      const next = k === segments.length - 1 ? '[vcat]' : `[x${k}]`;
      const offset = prefix - k * td;
      chains.push(
        `${label}[v${k}]xfade=transition=${TRANSITION_MAP[body.transition ?? 'dissolve'] ?? 'fade'}` +
          `:duration=${td}:offset=${offset.toFixed(3)}${next}`,
      );
      prefix += durations[k];
      label = next;
    }
    videoOut = '[vcat]';
  }

  chains.push(`${videoOut}ass=sub.ass[vout]`);

  // ⑤ 音频：配音为主 + BGM sidechain 闪避 → 混音 → 响度归一
  const bgmIdx = bgm.mode === 'synth' ? segments.length + voiceIdx.length : -1;
  const A48 = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
  let audioOut: string | null = null;

  if (voiceIdx.length) {
    // 每段配音按它所在镜头的起点做 adelay
    voiceIdx.forEach((idx, i) => {
      const startS = Math.max(0, voiceTracks[i].startS);
      const ms = Math.round(startS * 1000);
      chains.push(`[${idx}:a]${A48},adelay=${ms}|${ms},volume=1.9[v${idx}]`);
    });
    const voiceLabels = voiceIdx.map((idx) => `[v${idx}]`).join('');
    chains.push(`${voiceLabels}amix=inputs=${voiceIdx.length}:normalize=0:dropout_transition=0,` +
      `asplit=2[voice_mix][voice_sc]`);

    if (bgmIdx >= 0) {
      // BGM 压低 + 人声一起时自动闪避（sidechaincompress 的第二个输入是侧链）
      chains.push(
        `[${bgmIdx}:a]${A48},lowpass=f=6500,tremolo=f=3.5:d=0.22,volume=0.35[bgm_raw]`,
      );
      chains.push(
        `[bgm_raw][voice_sc]sidechaincompress=threshold=0.06:ratio=8:attack=15:release=350:makeup=1[bgm_duck]`,
      );
      chains.push(
        `[voice_mix][bgm_duck]amix=inputs=2:normalize=0:dropout_transition=0,` +
          `loudnorm=I=${body.loudnessLufs ?? -14}:TP=-1.5:LRA=11,` +
          `aresample=48000:out_chlayout=stereo[aout]`,
      );
    } else {
      chains.push(
        `[voice_mix]loudnorm=I=${body.loudnessLufs ?? -14}:TP=-1.5:LRA=11,` +
          `aresample=48000:out_chlayout=stereo[aout]`,
      );
    }
    audioOut = '[aout]';
  } else if (bgmIdx >= 0) {
    chains.push(
      // 注意顺序：loudnorm 内部工作在 192kHz，必须在它「之后」再 aresample，
      // 否则输出会变成 96kHz/192kHz（平台通用规格是 AAC-LC 48kHz 立体声）
      `[${bgmIdx}:a]${A48},` +
        `lowpass=f=6500,tremolo=f=3.5:d=0.22,` +
        `afade=t=in:st=0:d=0.8,afade=t=out:st=${Math.max(0, total - 1.2).toFixed(2)}:d=1.2,` +
        `loudnorm=I=${body.loudnessLufs ?? -14}:TP=-1.5:LRA=11,` +
        `aresample=48000:out_chlayout=stereo[aout]`,
    );
    audioOut = '[aout]';
  }

  args.push(
    '-filter_complex',
    chains.join(';'),
    '-map',
    '[vout]',
    ...(audioOut ? ['-map', audioOut] : []),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    ...(audioOut ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'] : []),
    '-t',
    total.toFixed(3),
    '-movflags',
    '+faststart',
    'out.mp4',
  );

  onLog?.(`$ ffmpeg ${args.join(' ')}`);
  let r = await run('ffmpeg', args, workDir, logPath);

  // 转场名不被支持时回退到 fade 再试一次（不同 ffmpeg 构建的 xfade 名称集合不同）
  if (r.code !== 0 && td > 0 && /transition|Invalid argument|xevd/i.test(r.log)) {
    onLog?.('[warn] 该 ffmpeg 构建不支持所请求的转场，回退为 fade 重试');
    const retry = args.map((a) => a.replace(/transition=\w+/, 'transition=fade'));
    r = await run('ffmpeg', retry, workDir, logPath);
  }

  if (r.code !== 0) {
    const tail = r.log.split('\n').filter(Boolean).slice(-6).join('\n');
    return { ok: false, error: `ffmpeg 退出码 ${r.code}`, logTail: tail };
  }

  const outPath = path.join(workDir, 'out.mp4');
  const stat = await fsp.stat(outPath);

  // ⑤ ffprobe 复核（把「真的编出来了」变成可验证的数字）
  let durationMs = Math.round(total * 1000);
  let width = w;
  let height = h;
  try {
    const probe = await run(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration',
       '-show_entries', 'format=duration', '-of', 'json', 'out.mp4'],
      workDir,
      path.join(workDir, 'ffprobe.log'),
      20_000,
    );
    const info = JSON.parse(probe.log.slice(probe.log.indexOf('{')));
    const st = info.streams?.[0] ?? {};
    width = st.width ?? w;
    height = st.height ?? h;
    durationMs = Math.round(Number(st.duration ?? info.format?.duration ?? total) * 1000);
  } catch {
    /* probe 失败不阻塞交付，保留估算值 */
  }

  // 清理旧任务（保留最近 N 个）
  try {
    const jobs = (await fsp.readdir(rendersDir)).filter((d) => d.startsWith('job_')).sort();
    for (const old of jobs.slice(0, Math.max(0, jobs.length - KEEP_JOBS))) {
      await fsp.rm(path.join(rendersDir, old), { recursive: true, force: true });
    }
  } catch {
    /* 清理失败无所谓 */
  }

  void root;
  return {
    ok: true,
    url: `/renders/${jobId}/out.mp4`,
    file: path.relative(root, outPath).replace(/\\/g, '/'),
    width,
    height,
    fps,
    durationMs,
    sizeBytes: stat.size,
    shots: segments.length,
    command: `ffmpeg ${args.join(' ')}`,
    logTail: r.log.split('\n').filter(Boolean).slice(-4).join('\n'),
  };
}

/** 把前端给的片段地址解析成本机路径：/renders/<job>/x.mp4 → <rendersDir>/<job>/x.mp4
 *  /assets/... 由模型网关产出，网关的工作目录可能是项目根或 apps/api —— 两处都找。 */
function resolveLocalClip(url: string, root: string, rendersDir: string): string | null {
  const clean = url.split('?')[0];
  const m = /^\/renders\/([\w.-]+)\/([\w.-]+)$/.exec(clean);
  if (m) {
    const p = path.join(rendersDir, m[1], m[2]);
    return fs.existsSync(p) ? p : null;
  }
  const asset = /^\/assets\/([\w./-]+)$/.exec(clean);
  if (asset) {
    for (const base of [root, path.join(root, 'apps', 'api')]) {
      const p = path.join(base, '.mva-assets', asset[1]);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/** ffprobe 读真实时长（xfade 的 offset 必须基于真实时长） */
async function probeDuration(file: string, cwd: string, onLog?: (l: string) => void): Promise<number | null> {
  try {
    const r = await run(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
      cwd,
      path.join(cwd, 'ffprobe.log'),
      20_000,
    );
    const v = Number.parseFloat(r.log.trim().split('\n').pop() ?? '');
    return Number.isFinite(v) ? v : null;
  } catch (e) {
    onLog?.(`ffprobe 读取时长失败：${(e as Error).message}`);
    return null;
  }
}

/* ─────────────── Range 支持（<video> 才能拖动进度条） ─────────────── */

async function serveFile(res: ServerResponse, req: IncomingMessage, filePath: string, mime: string) {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  const range = req.headers.range;
  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  if (!range) {
    res.setHeader('Content-Length', String(stat.size));
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const start = m?.[1] ? Number(m[1]) : 0;
  const end = m?.[2] ? Number(m[2]) : stat.size - 1;
  res.statusCode = 206;
  res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  res.setHeader('Content-Length', String(end - start + 1));
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

/* ─────────────── Vite 插件 ─────────────── */

export function ffmpegBridge(): Plugin {
  let root = process.cwd();
  let rendersDir = path.join(root, '.mva-renders');
  let ffmpegVersion = 'unknown';

  function attach(server: ViteDevServer) {
    root = server.config.root;
    rendersDir = path.join(root, '.mva-renders');
    fs.mkdirSync(rendersDir, { recursive: true });

    // 健康检查：前端用它决定「走真 FFmpeg 还是回退 Mock」
    server.middlewares.use('/api/render', (req, res, next) => {
      if (req.method === 'GET') {
        json(res, 200, { ok: true, ffmpeg: ffmpegVersion, rendersDir: path.relative(root, rendersDir) });
        return;
      }
      if (req.method !== 'POST') {
        next();
        return;
      }
      void (async () => {
        try {
          const body = JSON.parse(await readBody(req)) as RenderRequest;
          const result = await render(root, rendersDir, body, (line) => {
            server.config.logger.info(`[ffmpeg-bridge] ${line.slice(0, 400)}`);
          });
          json(res, result.ok ? 200 : 500, result);
        } catch (e) {
          json(res, 500, { ok: false, error: (e as Error).message } satisfies RenderResponse);
        }
      })();
    });

    // 产物静态服务（带 Range）
    server.middlewares.use('/renders', (req, res, next) => {
      const url = (req.url ?? '').split('?')[0];
      const rel = decodeURIComponent(url).replace(/^\/+/, '');
      if (!/^job_[\w-]+\/[\w.-]+$/.test(rel)) {
        next();
        return;
      }
      const filePath = path.join(rendersDir, rel);
      const mime = rel.endsWith('.mp4') ? 'video/mp4' : rel.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      void serveFile(res, req, filePath, mime);
    });
  }

  return {
    name: 'mva-ffmpeg-bridge',
    apply: 'serve',
    async configResolved() {
      try {
        const r = await run('ffmpeg', ['-version'], process.cwd(), path.join(process.cwd(), '.mva-renders-version.log'), 10_000);
        ffmpegVersion = r.log.split('\n')[0]?.replace('ffmpeg version ', '').slice(0, 40) ?? 'unknown';
        await fsp.rm(path.join(process.cwd(), '.mva-renders-version.log'), { force: true });
      } catch {
        ffmpegVersion = 'NOT FOUND';
      }
    },
    configureServer(server) {
      attach(server);
      const v = ffmpegVersion === 'NOT FOUND' ? '未找到 ffmpeg，合成节点将回退到 Mock 产物' : `ffmpeg ${ffmpegVersion}`;
      server.config.logger.info(`\n  \x1b[38;5;179m➜  FFmpeg 渲染桥\x1b[0m 就绪（${v}）`);
      server.config.logger.info(`  \x1b[2mPOST /api/render · 产物 /renders/<job>/out.mp4\x1b[0m\n`);
    },
  };
}
