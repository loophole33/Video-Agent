/**
 * 本地文件 → 产物引用（ArtifactRef）的唯一实现。
 *
 * 为什么单独一个文件：这是「画布拖入」与「节点内上传」两个入口**唯一共享**的逻辑。
 * 若各自实现一份，两处必然漂移（HANDOFF §5 记录的重复实现类缺陷）。
 *
 * 纯函数：不碰 store、不发网络请求。`URL.createObjectURL` 走可注入参数，
 * 以便在 node 环境（无 jsdom）下直接单测。
 */
import type { ArtifactRef } from '../types/graph';

export type MediaKind = 'image' | 'video' | 'audio';

/** 文件名 → 仅保留字母数字（用于产物 id），全空则兜底 'f' */
export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40) || 'f';
}

/** 由 MIME 判定媒体种类：video/* → video，audio/* → audio，其余（含空）→ image */
export function kindFromMime(mime: string): MediaKind {
  if (mime.startsWith('video')) return 'video';
  if (mime.startsWith('audio')) return 'audio';
  return 'image';
}

export function artifactFromFile(
  file: File,
  nodeId: string,
  urlOverride?: string,
): { kind: MediaKind; artifact: ArtifactRef } {
  const mime = file.type || 'application/octet-stream';
  const kind = kindFromMime(mime);
  const url = urlOverride ?? URL.createObjectURL(file);
  const artifact: ArtifactRef = {
    // 并入体积 + lastModified + 文件名：仅按体积派生会在「同节点上传两个同字节数文件」时撞 id。
    // lastModified 是必需的 —— sanitizeName 会剥掉所有非字母数字字符，中文文件名（图片.jpg）
    // 会塌缩为扩展名 'jpg'，使文件名分量对 CJK 命名失效（Task 1 审查发现）。
    id: `art_up_${nodeId}_${file.size}_${file.lastModified}_${sanitizeName(file.name)}`,
    kind,
    url,
    thumbUrl: url,
    mime,
    digest: `local-${file.size}`,
    meta: { uploaded: true, size: file.size, portrait: false },
  };
  return { kind, artifact };
}
