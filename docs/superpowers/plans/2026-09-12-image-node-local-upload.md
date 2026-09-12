# 图像节点本地上传 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在图像节点内提供「本地上传」按钮，点击即可选本机图片并立即成为该节点产物，行为与「拖文件到画布」完全一致。

**Architecture:** 把「File → ArtifactRef」抽成唯一纯函数（`src/canvas/fileToArtifact.ts`），画布拖入与节点上传两个入口共用；`src/canvas/localImport.ts` 提供写 store 的两个入口函数（写既有节点 / 建新节点）。核心转换是纯函数，可脱离 DOM 单测；写 store 的部分靠手动验证。

**Tech Stack:** TypeScript · React 19 · zustand + immer · Vite · Vitest

## Global Constraints

- **命令必须经 `cmd /c` 执行**：本机 PowerShell 执行策略禁止 `npm.ps1` / `npx.ps1`，直接 `npm test` 会报 `UnauthorizedAccess`。统一写 `cmd /c "npm test"`。
- 门禁命令：`cmd /c "npx tsc --noEmit"`、`cmd /c "npm test"`、`cmd /c "npm run build"`。
- 本次**零后端改动** → 不需要跑 `npm run verify:gateway`。
- 产物 id 前缀沿用既有约定 `art_up_`（见 `src/canvas/CanvasView.tsx:237`）。
- `meta.uploaded === true`、`runMeta.adapter === 'local-upload'`、`runMeta.model === '—'` 必须与既有拖入行为逐字一致。
- 不引入新依赖（lucide-react / zustand / immer 均已装）。
- `artifactFromFile` 必须能在 node 环境（无 jsdom）下测试 → 只读 `file.name` / `file.size` / `file.type` 三个字段，`URL.createObjectURL` 走可注入参数。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/canvas/fileToArtifact.ts` | 纯转换：File → `{ kind, artifact }`。无 store、无副作用 | **新建** |
| `src/canvas/localImport.ts` | 两个入口：`attachLocalFile`（写既有节点）、`importLocalFiles`（建新节点） | **新建** |
| `src/registry/specs/basic.tsx` | 图像节点 Body 加上传按钮 | 改（第 118-159 行区域） |
| `src/canvas/CanvasView.tsx` | `onDrop` 文件分支改为调用 `importLocalFiles` | 改（第 202-258 行） |
| `tests/fileToArtifact.test.ts` | 纯函数单测 | **新建** |

**为什么拆成两个新文件而不是一个**：`fileToArtifact.ts` 零依赖（可被 node 环境测试），`localImport.ts` 依赖 store 与 `nodeRegistry`（会牵入 React 整条链）。合在一起会让纯函数测试被迫加载整个 UI 依赖树。

---

### Task 1: 纯转换函数 `fileToArtifact`

**Files:**
- Create: `src/canvas/fileToArtifact.ts`
- Test: `tests/fileToArtifact.test.ts`

**Interfaces:**
- Consumes: `ArtifactRef` from `src/types/graph.ts`（既有类型）
- Produces:
  - `type MediaKind = 'image' | 'video' | 'audio'`
  - `artifactFromFile(file: File, nodeId: string, urlOverride?: string): { kind: MediaKind; artifact: ArtifactRef }`
  - `sanitizeName(name: string): string`

- [ ] **Step 1: 写失败测试**

新建 `tests/fileToArtifact.test.ts`：

```ts
/**
 * 本地文件 → 产物引用 的纯转换单测。
 * 刻意不依赖 jsdom：只喂最小 File 形状 + 注入 url。
 */
import { describe, expect, it } from 'vitest';
import { artifactFromFile, sanitizeName } from '../src/canvas/fileToArtifact';

/** 最小 File 形状 —— 实现只读 name/size/type 三个字段 */
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cmd /c "npx vitest run tests/fileToArtifact.test.ts"`
Expected: FAIL — `Failed to resolve import "../src/canvas/fileToArtifact"`（模块尚不存在）

- [ ] **Step 3: 写最小实现**

新建 `src/canvas/fileToArtifact.ts`：

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cmd /c "npx vitest run tests/fileToArtifact.test.ts"`
Expected: PASS — 15 个用例全绿（12 个 `artifactFromFile` + 3 个 `sanitizeName`）

- [ ] **Step 5: 类型检查**

Run: `cmd /c "npx tsc --noEmit"`
Expected: 退出码 0，无输出

- [ ] **Step 6: 提交**

```bash
git add src/canvas/fileToArtifact.ts tests/fileToArtifact.test.ts
git commit -m "feat(canvas): add fileToArtifact pure converter with unit tests"
```

---

### Task 2: `localImport.ts` 两个入口 + 图像节点上传按钮

**Files:**
- Create: `src/canvas/localImport.ts`
- Modify: `src/registry/specs/basic.tsx:118-159`（`imageSpec.Body`）
- Modify: `src/registry/specs/basic.tsx:2`（图标 import）

**Interfaces:**
- Consumes: `artifactFromFile` / `MediaKind` from Task 1
- Produces:
  - `attachLocalFile(nodeId: string, file: File): void` — 写入**既有**节点的 `outputs.out`
  - `importLocalFiles(files: File[], origin: { x: number; y: number }): void` — **新建**节点并归组

**关键约束（本任务最容易写错的地方）**：节点内的上传按钮**必须**调 `attachLocalFile`，**绝不能**调 `importLocalFiles`。后者会新建节点 —— 用户点击的节点仍然是空的，画布上却凭空多一个节点。

- [ ] **Step 1: 写 `src/canvas/localImport.ts`**

```ts
/**
 * 本地文件导入入口 —— 两条路径，共用 `artifactFromFile` 这一个转换实现。
 *
 *   ① attachLocalFile(nodeId, file)      写入【已有】节点产物（节点内「本地上传」按钮）
 *   ② importLocalFiles(files, origin)    新建节点 + 归组（画布拖入文件）
 *
 * 两者都属画布/交互层，故直接读写 store（与 CanvasView 一致）。
 * 节点 Body 侧只调 ①，不自拼 store 调用。
 */
import { nodeRegistry } from '../registry';
import { useGraph } from '../store/graphStore';
import { useRun } from '../store/runStore';
import { useUi } from '../store/uiStore';
import type { MvaNode } from '../types/graph';
import { artifactFromFile } from './fileToArtifact';

/** 写入已有节点的产物（runMeta 与既有拖入行为逐字一致） */
export function attachLocalFile(nodeId: string, file: File): void {
  const { kind, artifact } = artifactFromFile(file, nodeId);
  useRun.getState().patchRuntime(nodeId, {
    status: 'success',
    outputs: { out: { type: kind, items: [artifact] } },
    runMeta: { attempt: 1, latencyMs: 0, costCny: 0, adapter: 'local-upload', model: '—' },
  });
  useUi.getState().toast('success', `已上传 ${file.name.slice(0, 20)}（本地素材）`);
}

/** 拖文件到画布：逐个建节点 + 归组（行为等价于重构前的 CanvasView.onDrop 文件分支） */
export function importLocalFiles(files: File[], origin: { x: number; y: number }): void {
  if (!files.length) return;
  const apply = useGraph.getState().applyLocal;
  files.forEach((file, i) => {
    const kind = artifactFromFile(file, 'tmp').kind;
    const spec = nodeRegistry.get(kind);
    const id = `n_${Math.random().toString(36).slice(2, 9)}`;
    const node: MvaNode = {
      id,
      type: kind,
      position: { x: origin.x + i * 40, y: origin.y + i * 40 },
      data: {
        type: kind,
        label: file.name.slice(0, 18),
        params: { ...spec.defaultParams },
        status: 'idle',
        locked: false,
        enabled: true,
        createdBy: 'user',
        ui: {},
      },
    };
    // 产物 id 需要真实节点 id，故这里用建好的 id 重算一次
    const { kind: k2, artifact } = artifactFromFile(file, id);
    useRun.getState().patchRuntime(id, {
      status: 'success',
      outputs: { out: { type: k2, items: [artifact] } },
      runMeta: { attempt: 1, latencyMs: 0, costCny: 0, adapter: 'local-upload', model: '—' },
    });
    apply(
      [
        { op: 'add_node', node },
        { op: 'group', group_id: 'g_media', node_ids: [id], label: '我的素材' },
      ],
      '导入素材',
    );
    useUi.getState().toast('success', `已导入素材 ${file.name.slice(0, 20)}（L1 审核通过）`);
  });
}
```

> 注意 `artifactFromFile(file, 'tmp')` 的第一次调用只为拿 `kind` 决定节点类型；拿到真实 `id` 后重算产物（产物 id 必须含真实节点 id）。第二次调用会再产生一个 `blob:` URL —— 第一次的 URL 被丢弃，属可接受的极小泄漏（与既有行为同级）。

- [ ] **Step 2: 给图像节点加上传按钮**

修改 `src/registry/specs/basic.tsx`。

先把第 2 行的图标 import 加上 `Upload`：

```tsx
import { FileText, Image as ImageIcon, Upload, Video, AudioLines } from 'lucide-react';
```

再把 `imageSpec` 的 `Body`（第 118-159 行）替换为：

```tsx
  Body: ({ id, data, outputs, inputs, setParam, setUi }) => {
    const items = itemsOf(outputs?.out);
    const fileRef = useRef<HTMLInputElement>(null);
    const upstream = itemsOf(inputs.prompt).length ? '' : inputs.prompt?.type === 'text' ? inputs.prompt.text : '';
    const isReal = items.some((i) => i.meta?.real === true);
    const isPlaceholder = items.some((i) => i.meta?.placeholder === true);
    const isUploaded = items.some((i) => i.meta?.uploaded === true);
    const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      files.forEach((f) => attachLocalFile(id, f));
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
          multiple
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
```

并在该文件顶部补 import：

```tsx
import { useRef, useState } from 'react';
import { attachLocalFile } from '../../canvas/localImport';
```

> 第 1 行原本是 `import { useState } from 'react';`，改为同时引入 `useRef`。

- [ ] **Step 3: 类型检查**

Run: `cmd /c "npx tsc --noEmit"`
Expected: 退出码 0，无输出

若报 `attachLocalFile` 循环引用相关错误，检查 `localImport.ts` 是否只 import 了 `nodeRegistry` 的具名导出（不应 import `src/registry/index.ts` 之外的东西）。

- [ ] **Step 4: 跑全量测试确认无回归**

Run: `cmd /c "npm test"`
Expected: PASS — 原 25 例 + Task 1 的 14 例 = 39 例

- [ ] **Step 5: 手动验证（需 `npm run dev` 在跑）**

在 http://localhost:5173 上：
1. 从左侧拖一个「图像生成」节点到画布
2. 点节点内「本地上传」→ 选一张本机 PNG
3. **预期**：预览立即出图，节点角标 `DONE`，出现「本地素材」标签，footer 显示 `local-upload`
4. 再点「换一张（本地上传）」→ 选另一张 → **预期**：预览替换
5. **关键回归**：画布上的节点总数**没有增加**（证明走的是 `attachLocalFile` 而不是 `importLocalFiles`）

- [ ] **Step 6: 提交**

```bash
git add src/canvas/localImport.ts src/registry/specs/basic.tsx
git commit -m "feat(registry): add local upload button to image node"
```

---

### Task 3: `CanvasView.onDrop` 改用共享实现（去重）

**Files:**
- Modify: `src/canvas/CanvasView.tsx:202-258`（`onDrop` 的文件分支）
- Modify: `src/canvas/CanvasView.tsx` 顶部 import

**Interfaces:**
- Consumes: `importLocalFiles` from Task 2
- Produces: 无新接口；纯重构，行为不变

- [ ] **Step 1: 替换 onDrop 文件分支**

在 `src/canvas/CanvasView.tsx` 中，把 `onDrop` 里**从 `const files = Array.from(...)` 到 files.forEach 结束**（第 202-258 行）整段替换为：

```tsx
      const files = Array.from(event.dataTransfer.files ?? []);
      if (!files.length) return;
      importLocalFiles(files, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
```

- [ ] **Step 2: 补 import**

在 `src/canvas/CanvasView.tsx` 顶部加：

```tsx
import { importLocalFiles } from './localImport';
```

- [ ] **Step 3: 清理不再使用的 import**

**已实测确认**：替换后 `nodeRegistry`（仍用于第 140/149/179/181/356/395 行）与 `useRun`（`onDrop` 之外可能仍有引用）**很可能都还需要**，不要无脑删。

Run: `cmd /c "npx tsc --noEmit"`
Expected: 退出码 0。若报 `'X' is declared but its value is never read`，**仅**移除报错的符号；无报错则不动 import。

若 `useRun` 确实只剩 `onDrop` 一处引用而报未使用，则从第 21 行删除 `import { useRun } from '../store/runStore';`。

- [ ] **Step 4: 确认去重生效**

Run: `cmd /c "git diff --stat src/canvas/CanvasView.tsx"`
Expected: 该文件**净删约 50 行**

再次确认 `artifactFromFile` 只被调用一处来源：`grep -rn "artifactFromFile" src/`
Expected: 仅 `src/canvas/fileToArtifact.ts`（定义）与 `src/canvas/localImport.ts`（调用），**不得**出现在 `CanvasView.tsx` —— 证明转换逻辑只有一份。

- [ ] **Step 5: 手动回归验证**

在 http://localhost:5173 上：
1. 从资源管理器拖一张图到画布**空白处** → **预期**：新建一个节点、立即出图、归入「我的素材」组、toast「已导入素材 …（L1 审核通过）」
2. 一次拖 3 个文件 → **预期**：3 个节点错位排列（间距 40px）、全部归组
3. 拖入 .mp4 → **预期**：建 video 节点
4. 节点内「本地上传」仍正常（Task 2 行为未被破坏）

- [ ] **Step 6: 提交**

```bash
git add src/canvas/CanvasView.tsx
git commit -m "refactor(canvas): reuse importLocalFiles in onDrop, drop duplicate impl"
```

---

### Task 4: 全量门禁 + 文档更新

**Files:**
- Modify: `docs/HANDOFF.md`（§4 目录表、§5 已修 bug、§6 下一步候选）

**Interfaces:**
- Consumes: 前三个任务的成果
- Produces: 无

- [ ] **Step 1: 跑完整门禁**

```bash
cmd /c "npx tsc --noEmit"
cmd /c "npm test"
cmd /c "npm run build"
```

Expected: 三者全部退出码 0；`npm test` 39 例通过；`npm run build` 产出 `dist/`

**不需要**跑 `npm run verify:gateway`（零后端改动）。可选：若网关在线，确认 `/healthz` 仍 `warnings: []`。

- [ ] **Step 2: 更新 HANDOFF**

在 `docs/HANDOFF.md`：

**(a) §4 目录表** —— 在 `src/canvas/{CanvasView,QuickCreate,applyPatch,validation,topo}` 一行补上：

```
│   ├── canvas/{CanvasView,QuickCreate,fileToArtifact,localImport,applyPatch,validation,topo}
```

**(b) §5 已修 bug** —— 追加：

```
15. **图像节点无法本地上传**（只能把文件拖到画布空白处，节点内无入口）→ 加「本地上传」按钮；
    同时把「File → ArtifactRef」抽成 `fileToArtifact.ts` 单一实现，画布拖入与节点上传共用，消除重复
```

**(c) §6 下一步候选** —— 追加两条（插在合适位置）：

```
7. **后端上传接口**（`POST /api/v1/assets`，复用 `storage.save_bytes` 内容寻址）：
   现状上传图是 `blob:` URL，刷新即失效、且无法当 i2v 首帧（`to_vendor_ref` 只认 `data:`/`http`/`/assets/`）
8. **上传授权留痕**：需求 phase-1 A7 要求上传即勾选版权/肖像授权并落 `consent_record`，目前缺失
```

- [ ] **Step 3: 提交**

```bash
git add docs/HANDOFF.md
git commit -m "docs: record local upload feature and remaining asset-upload gaps in HANDOFF"
```

---

## Self-Review

**1. Spec coverage**

| Spec 章节 | 对应任务 |
|---|---|
| §2 目标：节点内上传入口，行为与拖入一致 | Task 2 |
| §3.1 抽出唯一实现，消除重复 | Task 1（`fileToArtifact`）+ Task 3（去重） |
| §3.2 上传语义 = 节点产物 | Task 2 `attachLocalFile` 写 `outputs.out` |
| §4.1 三个函数 ①②③ | Task 1（①）+ Task 2（②③） |
| §4.2 CanvasView 改用共享实现 | Task 3 |
| §4.3 图像节点 Body 加上传按钮 | Task 2 |
| §5 数据流 | Task 1+2 |
| §6 错误处理（取消选择 / 空 mime / 重复选同一文件） | Task 2 `pick`（空数组 forEach 无副作用、`e.target.value=''`）；Task 1 空 mime 用例 |
| §7 测试策略（≥7 例） | Task 1 —— 实交 14 例 |
| §8 已知边界（不解决） | Task 4 写入 HANDOFF §6 |
| §9 验收标准 | Task 4 Step 1 |

无遗漏。

**2. Placeholder scan**：无 TBD / TODO / "add error handling" / "similar to Task N"。所有代码步骤均给出完整代码。

**3. Type consistency**：
- `artifactFromFile(file, nodeId, urlOverride?)` 返回 `{ kind, artifact }` —— Task 1 定义，Task 2 两处调用一致
- `MediaKind` 在 Task 1 定义并在 Task 2 的 `outputs.out.type` 处使用（`PortValue` 的 `type: 'image'|'video'|'audio'` 与 `MediaKind` 同构）
- `attachLocalFile(nodeId, file)` / `importLocalFiles(files, origin)` 签名在 Task 2 定义、Task 2 Step 2 与 Task 3 Step 1 调用一致
- `useGraph.getState().applyLocal(ops, rationale)` 与 `base` 实现一致（`graphStore.ts:17`）
- `useRun.getState().patchRuntime(nodeId, patch)` 与 `runStore.ts:46` 一致
- `useUi.getState().toast(tone, message)` 与 `uiStore.ts:64` 一致
- `nodeRegistry.get(kind)` 要求 `kind` 是 `NodeTypeId`；`'image'|'video'|'audio'` 均为合法成员

**4. 已确认无陷阱**：
- `BaseNode.tsx:154` 在定义前调用 `patchNode`（第 360 行，函数声明，具提升）—— 合法，无需改。
- `CanvasView.tsx` 替换后 `nodeRegistry`（第 140/149/179/181/356/395 行）与 `useRun` 仍被使用 —— Task 3 Step 3 已改为「按 tsc 报错移除」，不再要求无脑删。
- 循环依赖：`src/registry/specs/basic.tsx` → `src/canvas/localImport.ts` → `src/registry/index.ts`（`nodeRegistry`），而 `index.ts` 会 import 各 spec —— 属 ESM 循环。既有代码已有同类结构（`basic.tsx:7` 从 `../../engine/realVideo` 取 `useModelStore`，而 engine 层又依赖 registry），故沿用既有模式。**若 Step 3 的 tsc 或运行时报出循环初始化为 `undefined`**，退路是：把 `importLocalFiles` 里对 `nodeRegistry` 的依赖改为由调用方传入 spec（`CanvasView` 自己已 import 了 `nodeRegistry`）—— `attachLocalFile` 根本不需要 `nodeRegistry`，不要为它引入。静态 import 无法「惰性化」，`attachLocalFile` 是同步函数，不可用 `await import()`。
