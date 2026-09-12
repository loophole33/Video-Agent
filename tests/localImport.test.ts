/**
 * localImport 的 store 层确定性测试。
 * 覆盖本任务最核心的不变量：节点内上传【不得】新建节点。
 * 不需要 jsdom —— zustand 直接 getState()，node 环境可构造真实 File。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { attachLocalFile, importLocalFiles } from '../src/canvas/localImport';
import { useGraph } from '../src/store/graphStore';
import { useRun } from '../src/store/runStore';
import type { ArtifactRef } from '../src/types/graph';

function realFile(name = 'a.png', bytes = 32, type = 'image/png'): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/** 图里塞一个最小可用的 image 节点，模拟「用户点击的那个节点」 */
function seedImageNode(id = 'n_x'): void {
  useGraph.setState((s) => {
    s.graph.nodes.push({
      id,
      type: 'image',
      position: { x: 0, y: 0 },
      data: {
        type: 'image',
        label: id,
        params: {},
        status: 'idle',
        locked: false,
        enabled: true,
        createdBy: 'user',
        ui: {},
      },
    } as never);
  });
}

beforeEach(() => {
  useGraph.setState((s) => {
    s.graph.nodes = [];
    s.graph.edges = [];
    s.graph.groups = [];
  });
  useRun.setState({ runtime: {} });
});

describe('attachLocalFile —— 写入既有节点，绝不新建节点', () => {
  it('节点数不变（本任务最容易写错的一点）', () => {
    seedImageNode('n_x');
    attachLocalFile('n_x', realFile());
    const nodes = useGraph.getState().graph.nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe('n_x');
  });

  it('产物 id key 的是被点击的节点', () => {
    seedImageNode('n_x');
    attachLocalFile('n_x', realFile());
    const out = useRun.getState().runtime['n_x']?.outputs?.out;
    expect(out && 'items' in out).toBe(true);
    expect(out && 'items' in out ? out.items[0].id : '').toMatch(/^art_up_n_x_/);
  });

  it('runMeta 与拖入路径逐字一致（防未来漂移）', () => {
    seedImageNode('n_x');
    attachLocalFile('n_x', realFile());
    expect(useRun.getState().runtime['n_x']?.runMeta).toEqual({
      attempt: 1,
      latencyMs: 0,
      costCny: 0,
      adapter: 'local-upload',
      model: '—',
    });
  });

  it('状态置 success，且 meta.uploaded=true', () => {
    seedImageNode('n_x');
    attachLocalFile('n_x', realFile());
    const rt = useRun.getState().runtime['n_x'];
    expect(rt?.status).toBe('success');
    const out = rt?.outputs?.out;
    expect(out && 'items' in out ? out.items[0].meta?.uploaded : undefined).toBe(true);
  });

  it('与拖入路径产出真正一致（不是各自钉字面量）', () => {
    seedImageNode('n_x');
    const f = realFile('same.png');
    attachLocalFile('n_x', f);
    importLocalFiles([f], { x: 0, y: 0 });

    const rt = useRun.getState().runtime;
    const viaButton = rt['n_x'];
    const viaDrop = Object.entries(rt).find(([id]) => id !== 'n_x')?.[1];

    expect(viaDrop).toBeDefined();

    const a = viaButton.outputs!.out as { items: ArtifactRef[] };
    const b = viaDrop!.outputs!.out as { items: ArtifactRef[] };
    // 必须逐个断言长度，否则两条路径都产出 items: [] 时下面会恒真
    expect(a.items).toHaveLength(1);
    expect(b.items).toHaveLength(1);

    // runMeta 是共享契约（LOCAL_UPLOAD_RUN_META），必须逐字一致
    expect(viaDrop!.runMeta).toEqual(viaButton.runMeta);

    // url/thumbUrl 是会话内一次性 blob 句柄，不是产物语义 —— 故意排除在跨路径比较之外
    const { url: ua, thumbUrl: ta, ...sa } = a.items[0];
    const { url: ub, thumbUrl: tb, ...sb } = b.items[0];
    expect({ ...sb, id: '' }).toEqual({ ...sa, id: '' });
    // 但每条路径内部必须 url === thumbUrl
    expect(ta).toBe(ua);
    expect(tb).toBe(ub);
  });
});

describe('importLocalFiles —— 新建节点并归组', () => {
  it('恰好新增 1 个节点，且节点 id 与产物 id 中嵌入的一致', () => {
    importLocalFiles([realFile('drop.png')], { x: 10, y: 20 });
    const nodes = useGraph.getState().graph.nodes;
    expect(nodes.length).toBe(1);
    const node = nodes[0];
    const out = useRun.getState().runtime[node.id]?.outputs?.out;
    const artId = out && 'items' in out ? out.items[0].id : '';
    expect(artId).toContain(node.id);
  });

  it('归入 g_media 组', () => {
    importLocalFiles([realFile('drop.png')], { x: 10, y: 20 });
    const groups = useGraph.getState().graph.groups;
    expect(groups.some((g) => g.id === 'g_media')).toBe(true);
  });

  it('多个文件各自建节点', () => {
    const origin = { x: 10, y: 20 };
    importLocalFiles([realFile('a.png'), realFile('b.png'), realFile('c.png')], origin);
    const nodes = useGraph.getState().graph.nodes;
    expect(nodes).toHaveLength(3);
    expect(nodes[1].position).toEqual({ x: origin.x + 40, y: origin.y + 40 });
  });

  it('空数组不产生副作用', () => {
    importLocalFiles([], { x: 0, y: 0 });
    expect(useGraph.getState().graph.nodes.length).toBe(0);
  });
});
