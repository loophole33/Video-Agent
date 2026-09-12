/**
 * 本地文件 → 产物引用 的纯转换单测。
 * 刻意不依赖 jsdom：只喂最小 File 形状 + 注入 url。
 */
import { describe, expect, it } from 'vitest';
import { artifactFromFile, sanitizeName } from '../src/canvas/fileToArtifact';

/** 最小 File 形状 —— 实现只读 name/size/type/lastModified 四个字段 */
function fakeFile(name: string, size: number, type: string, lastModified = 0): File {
  return { name, size, type, lastModified } as unknown as File;
}

const URL_STUB = 'blob:http://localhost:5173/fake-1';

describe('artifactFromFile', () => {
  it('image/jpeg → kind=image，mime 保留', () => {
    const { kind, artifact } = artifactFromFile(fakeFile('a.jpg', 1234, 'image/jpeg'), 'n_1', URL_STUB);
    expect(kind).toBe('image');
    expect(artifact.mime).toBe('image/jpeg');
    expect(artifact.kind).toBe('image');
  });

  it('image/png → kind=image', () => {
    const { kind } = artifactFromFile(fakeFile('b.png', 10, 'image/png'), 'n_1', URL_STUB);
    expect(kind).toBe('image');
  });

  it('video/mp4 → kind=video', () => {
    const { kind, artifact } = artifactFromFile(fakeFile('c.mp4', 10, 'video/mp4'), 'n_1', URL_STUB);
    expect(kind).toBe('video');
    expect(artifact.kind).toBe('video');
  });

  it('audio/wav → kind=audio', () => {
    const { kind, artifact } = artifactFromFile(fakeFile('d.wav', 10, 'audio/wav'), 'n_1', URL_STUB);
    expect(kind).toBe('audio');
    expect(artifact.kind).toBe('audio');
  });

  it('空 mime → 兜底 image + application/octet-stream', () => {
    const { kind, artifact } = artifactFromFile(fakeFile('e', 10, ''), 'n_1', URL_STUB);
    expect(kind).toBe('image');
    expect(artifact.mime).toBe('application/octet-stream');
  });

  it('url 与 thumbUrl 都取注入值', () => {
    const { artifact } = artifactFromFile(fakeFile('a.jpg', 1, 'image/jpeg'), 'n_1', URL_STUB);
    expect(artifact.url).toBe(URL_STUB);
    expect(artifact.thumbUrl).toBe(URL_STUB);
  });

  it('digest 由体积派生（与既有拖入行为一致）', () => {
    const { artifact } = artifactFromFile(fakeFile('a.jpg', 4096, 'image/jpeg'), 'n_1', URL_STUB);
    expect(artifact.digest).toBe('local-4096');
  });

  it('meta.uploaded=true 且记录体积、portrait=false', () => {
    const { artifact } = artifactFromFile(fakeFile('a.jpg', 77, 'image/jpeg'), 'n_1', URL_STUB);
    expect(artifact.meta?.uploaded).toBe(true);
    expect(artifact.meta?.size).toBe(77);
    expect(artifact.meta?.portrait).toBe(false);
  });

  it('同一节点上传两个同体积的不同文件 → id 不同（不撞 id）', () => {
    const a = artifactFromFile(fakeFile('cat.jpg', 500, 'image/jpeg', 1000), 'n_1', URL_STUB).artifact;
    const b = artifactFromFile(fakeFile('dog.jpg', 500, 'image/jpeg', 2000), 'n_1', URL_STUB).artifact;
    expect(a.id).not.toBe(b.id);
  });

  it('中文文件名塌缩为同一 sanitizedName 时，靠 lastModified 仍不撞 id', () => {
    // 图片.jpg / 照片.jpg 都 sanitize 成 'jpg' —— 这是本用例存在的理由
    const a = artifactFromFile(fakeFile('图片.jpg', 500, 'image/jpeg', 1000), 'n_1', URL_STUB).artifact;
    const b = artifactFromFile(fakeFile('照片.jpg', 500, 'image/jpeg', 2000), 'n_1', URL_STUB).artifact;
    expect(a.id).not.toBe(b.id);
  });

  it('同一节点重复上传同一文件 → id 稳定（幂等）', () => {
    const a = artifactFromFile(fakeFile('cat.jpg', 500, 'image/jpeg', 1000), 'n_1', URL_STUB).artifact;
    const b = artifactFromFile(fakeFile('cat.jpg', 500, 'image/jpeg', 1000), 'n_1', URL_STUB).artifact;
    expect(a.id).toBe(b.id);
  });

  it('id 以 art_up_ 开头且含节点 id', () => {
    const { artifact } = artifactFromFile(fakeFile('a.jpg', 1, 'image/jpeg'), 'n_xyz', URL_STUB);
    expect(artifact.id.startsWith('art_up_')).toBe(true);
    expect(artifact.id).toContain('n_xyz');
  });
});

describe('sanitizeName', () => {
  it('去掉非字母数字，截断到 40', () => {
    expect(sanitizeName('my photo (1).jpg')).toBe('myphoto1jpg');
  });

  it('文件名全为特殊字符 → 兜底 f', () => {
    expect(sanitizeName('***')).toBe('f');
  });

  it('超长名截断到 40 字符', () => {
    expect(sanitizeName('a'.repeat(100)).length).toBe(40);
  });
});
