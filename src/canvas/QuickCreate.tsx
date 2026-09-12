import { useEffect, useMemo, useRef, useState } from 'react';
import type { MvaNode } from '../types/graph';
import { nodeRegistry } from '../registry';
import { useGraph } from '../store/graphStore';
import { useUi } from '../store/uiStore';
import { cn } from '../lib/utils';

/** 双击空白处：搜索式新建节点（回车即建，自动落在双击点） */
export function QuickCreate() {
  const qc = useUi((s) => s.quickCreate);
  const close = useUi((s) => s.closeQuickCreate);
  const apply = useGraph((s) => s.applyLocal);
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (qc) {
      setQ('');
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [qc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const groups = useMemo(() => {
    const all = nodeRegistry.byGroup();
    if (!q.trim()) return all;
    const needle = q.trim().toLowerCase();
    return all
      .map((g) => ({
        ...g,
        items: g.items.filter(
          (s) => s.title.toLowerCase().includes(needle) || s.id.includes(needle) || s.description.includes(needle),
        ),
      }))
      .filter((g) => g.items.length);
  }, [q]);

  if (!qc) return null;

  const create = (type: MvaNode['data']['type']) => {
    const spec = nodeRegistry.get(type);
    const node: MvaNode = {
      id: `n_${Math.random().toString(36).slice(2, 9)}`,
      type,
      position: { x: Math.round(qc.flow.x / 8) * 8, y: Math.round(qc.flow.y / 8) * 8 },
      data: {
        type,
        label: spec.title,
        params: { ...spec.defaultParams },
        status: 'idle',
        locked: false,
        enabled: true,
        createdBy: 'user',
        ui: {},
      },
    };
    apply([{ op: 'add_node', node }], `新建 ${spec.title}`);
    useUi.getState().setSelection([node.id]);
    close();
  };

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={close} />
      <div
        className="fixed z-50 w-[300px] animate-rise overflow-hidden rounded-lg border border-bay-700 bg-bay-900 shadow-dock"
        style={{
          left: Math.min(qc.screen.x, window.innerWidth - 320),
          top: Math.min(qc.screen.y, window.innerHeight - 380),
        }}
      >
        <div className="border-b border-bay-800 p-2">
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && groups[0]?.items[0]) create(groups[0].items[0].id);
            }}
            placeholder="搜索节点… 回车创建"
            className="field"
          />
        </div>
        <div className="max-h-[320px] overflow-y-auto p-1">
          {groups.map((g) => (
            <div key={g.category} className="mb-1">
              <p className="eyebrow px-2 py-1">{g.label}</p>
              {g.items.map((s) => (
                <button
                  key={s.id}
                  onClick={() => create(s.id)}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                    'hover:bg-bay-800',
                  )}
                >
                  <s.icon className="mt-[2px] size-3.5 shrink-0 text-sodium-500" />
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] text-bone-200">{s.title}</span>
                    <span className="block truncate text-[12.5px] text-bone-400">{s.description}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}
          {!groups.length && <p className="px-2 py-3 text-[13px] text-bone-400">没有匹配的节点类型</p>}
        </div>
      </div>
    </>
  );
}
