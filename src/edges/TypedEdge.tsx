import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import type { MvaEdge } from '../types/graph';
import { useRun } from '../store/runStore';
import { PORT_COLOR } from '../canvas/validation';
import { cn } from '../lib/utils';

export function TypedEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<MvaEdge>) {
  const srcStatus = useRun((s) => s.runtime[source]?.status);
  const tgtStatus = useRun((s) => s.runtime[target]?.status);
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.32,
  });

  const portType = data?.portType ?? 'any';
  const color = PORT_COLOR[portType];
  const flowing = srcStatus === 'running' || tgtStatus === 'running';
  const stale = tgtStatus === 'stale';

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: stale ? '#D9C36A' : color,
          strokeOpacity: flowing ? 1 : stale ? 0.5 : 0.72,
          strokeWidth: selected ? 2.6 : 1.75,
          strokeDasharray: flowing ? '6 6' : stale ? '3 4' : undefined,
          animation: flowing ? 'leader 1s linear infinite' : undefined,
        }}
      />
      {(selected || flowing) && (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)` }}
            className={cn(
              'pointer-events-none absolute rounded-sm border border-bay-950/70 bg-bay-950/90 px-1 py-[1px]',
              'font-mono text-[11px] tracking-wider',
            )}
          >
            <span style={{ color }}>{portType}</span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
