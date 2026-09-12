import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';

/**
 * 可拖拽分隔条：拖动改变相邻面板尺寸，双击恢复默认。
 * 用 pointer capture 实现，拖动过程中不触发 React Flow 的画布交互。
 */
export function Resizer({
  direction,
  value,
  min,
  max,
  defaultValue,
  onChange,
  sign = 1,
  className,
}: {
  direction: 'vertical' | 'horizontal';
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  onChange: (v: number) => void;
  /** 1 = 面板在分隔条左侧/上侧（右拖/下拖变大）；-1 = 面板在右侧/下侧（左拖/上拖变大） */
  sign?: number;
  className?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef({ pos: 0, value });

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      startRef.current = { pos: direction === 'vertical' ? e.clientX : e.clientY, value };
      setDragging(true);
    },
    [direction, value],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const cur = direction === 'vertical' ? e.clientX : e.clientY;
      const delta = (cur - startRef.current.pos) * sign;
      const next = Math.max(min, Math.min(max, startRef.current.value + delta));
      onChange(Math.round(next));
    },
    [dragging, direction, min, max, onChange, sign],
  );

  const stop = useCallback(() => setDragging(false), []);

  useEffect(() => {
    if (!dragging) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = direction === 'vertical' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = prev;
      document.body.style.userSelect = '';
    };
  }, [dragging, direction]);

  return (
    <div
      role="separator"
      aria-orientation={direction === 'vertical' ? 'vertical' : 'horizontal'}
      aria-label="拖动调整面板大小（双击恢复默认）"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={() => onChange(defaultValue)}
      className={cn(
        'group relative z-20 shrink-0 transition-colors',
        direction === 'vertical' ? 'w-[6px] cursor-col-resize' : 'h-[6px] cursor-row-resize',
        dragging ? 'bg-sodium-500/60' : 'bg-bay-800 hover:bg-sodium-600/50',
        className,
      )}
      title="拖动调整大小 · 双击恢复默认"
    >
      <span
        className={cn(
          'pointer-events-none absolute rounded-full bg-bone-400/25 transition-opacity',
          direction === 'vertical'
            ? 'left-1/2 top-1/2 h-8 w-[2px] -translate-x-1/2 -translate-y-1/2'
            : 'left-1/2 top-1/2 h-[2px] w-8 -translate-x-1/2 -translate-y-1/2',
          dragging ? 'opacity-0' : 'opacity-70 group-hover:opacity-0',
        )}
      />
    </div>
  );
}
