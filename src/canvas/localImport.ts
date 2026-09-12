/**
 * 本地文件导入入口 —— 两条路径，共用 `artifactFromFile` 这一个转换实现。
 *
 *   ① attachLocalFile(nodeId, file)      写入【已有】节点产物（节点内「本地上传」按钮）
 *   ② importLocalFiles(files, origin)    新建节点 + 归组（画布拖入文件）
 *
 * 两者都属画布/交互层，故直接读写 store（与 CanvasView 一致）。
 * 节点 Body 侧只调 ①，不自拼 store 调用。
 *
 * ⚠️ 模块环：specs/basic.tsx → localImport.ts → registry/index.ts → specs。
 *    `nodeRegistry` 只在函数体内解引用（惰性），模块顶层不触碰 —— 环下不得提前求值。
 */
import { nodeRegistry } from '../registry';
import { useGraph } from '../store/graphStore';
import { useRun } from '../store/runStore';
import { useUi } from '../store/uiStore';
import type { MvaNode } from '../types/graph';
import { artifactFromFile, kindFromMime } from './fileToArtifact';

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
    const spec = nodeRegistry.get(kindFromMime(file.type || 'application/octet-stream'));
    const id = `n_${Math.random().toString(36).slice(2, 9)}`;
    const node: MvaNode = {
      id,
      type: spec.id,
      position: { x: origin.x + i * 40, y: origin.y + i * 40 },
      data: {
        type: spec.id,
        label: file.name.slice(0, 18),
        params: { ...spec.defaultParams },
        status: 'idle',
        locked: false,
        enabled: true,
        createdBy: 'user',
        ui: {},
      },
    };
    // 产物 id 需要真实节点 id，故这里只调这一次（不再先用 'tmp' 探一次 kind）
    const { kind, artifact } = artifactFromFile(file, id);
    useRun.getState().patchRuntime(id, {
      status: 'success',
      outputs: { out: { type: kind, items: [artifact] } },
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
