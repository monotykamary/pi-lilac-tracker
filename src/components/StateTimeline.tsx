import { useMemo } from 'react';
import { MODEL_LABELS, MODEL_COLORS, SUPPLY_STATE_COLORS, TRACKED_MODELS } from '../types';
import type { ModelSnapshot } from '../types';

interface StateTimelineProps {
  timeSeries: Record<string, { timestamp: string; snapshot: ModelSnapshot; supply_updated_at: string | null }[]>;
  selectedModel: string | null;
}

export default function StateTimeline({ timeSeries, selectedModel }: StateTimelineProps) {
  const models = selectedModel ? [selectedModel] : [...TRACKED_MODELS];

  const modelBlocks = useMemo(() => {
    const result: Record<string, { state: string; from: number; to: number }[]> = {};
    for (const id of models) {
      const points = timeSeries[id] || [];
      const blocks: { state: string; from: number; to: number }[] = [];
      let currentState = '';
      for (const p of points) {
        const t = new Date(p.timestamp).getTime();
        if (p.snapshot.supply_state !== currentState) {
          if (blocks.length > 0) {
            blocks[blocks.length - 1].to = t;
          }
          blocks.push({ state: p.snapshot.supply_state, from: t, to: t });
          currentState = p.snapshot.supply_state;
        } else {
          blocks[blocks.length - 1].to = t;
        }
      }
      result[id] = blocks;
    }
    return result;
  }, [timeSeries, models]);

  const timeRange = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const id of models) {
      const points = timeSeries[id] || [];
      if (points.length > 0) {
        const t0 = new Date(points[0].timestamp).getTime();
        const t1 = new Date(points[points.length - 1].timestamp).getTime();
        if (t0 < min) min = t0;
        if (t1 > max) max = t1;
      }
    }
    return { min, max };
  }, [timeSeries, models]);

  const totalMs = timeRange.max - timeRange.min;

  const formatTs = (ts: number) => {
    const d = new Date(ts);
    const mo = d.getMonth() + 1;
    const day = d.getDate();
    const hr = d.getHours().toString().padStart(2, '0');
    const min = d.getMinutes().toString().padStart(2, '0');
    return `${mo}/${day} ${hr}:${min}`;
  };

  const formatShortTime = (ts: number) => {
    const d = new Date(ts);
    const hr = d.getHours().toString().padStart(2, '0');
    const min = d.getMinutes().toString().padStart(2, '0');
    return `${hr}:${min}`;
  };

  const axisLabels = useMemo(() => {
    if (totalMs <= 0) return [];

    let count: number;
    if (totalMs < 300_000) count = 3;
    else if (totalMs < 3_600_000) count = 4;
    else if (totalMs < 86_400_000) count = 5;
    else count = 6;

    const labels: string[] = [];
    for (let i = 0; i < count; i++) {
      const t = timeRange.min + (totalMs * i) / (count - 1);
      const useFull = totalMs >= 86_400_000 || i === 0 || i === count - 1;
      labels.push(useFull ? formatTs(t) : formatShortTime(t));
    }
    return labels;
  }, [totalMs, timeRange.min]);

  if (totalMs <= 0) return null;

  return (
    <div className="card-surface p-5">
      <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mb-4">Supply State Timeline</h2>

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        {Object.entries(SUPPLY_STATE_COLORS).filter(([k]) => k !== 'unknown').map(([state, color]) => (
          <div key={state} className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color }} />
            <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">{state}</span>
          </div>
        ))}
      </div>

      <div className="space-y-3">
        {models.map(id => {
          const blocks = modelBlocks[id] || [];
          const label = MODEL_LABELS[id] || id;
          const color = MODEL_COLORS[id] || '#71717a';

          // Extend last block to global max so the track always fills
          if (blocks.length > 0) {
            blocks[blocks.length - 1].to = timeRange.max;
          }

          return (
            <div key={id} className="flex items-center gap-3 min-w-0">
              <div className="w-24 shrink-0 flex items-center gap-2 min-w-0">
                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300 truncate">{label}</span>
              </div>
              <div className="flex-1 h-8 timeline-track overflow-hidden relative min-w-0">
                {blocks.map((block, i) => {
                  const fromMs = block.from - timeRange.min;
                  const toMs = block.to - timeRange.min;
                  const leftPct = (fromMs / totalMs) * 100;
                  const widthPct = Math.max(0.5, ((toMs - fromMs) / totalMs) * 100);
                  const stateColor = SUPPLY_STATE_COLORS[block.state] || SUPPLY_STATE_COLORS.unknown;
                  const isFirst = i === 0;
                  const isLast = i === blocks.length - 1;

                  return (
                    <div
                      key={i}
                      className="absolute top-0 bottom-0 flex items-center justify-center"
                      style={{
                        left: `${leftPct}%`,
                        width: `${widthPct}%`,
                        backgroundColor: `${stateColor}18`,
                        borderLeft: isFirst ? 'none' : `2px solid ${stateColor}`,
                        borderRadius: isFirst ? '8px 0 0 8px' : isLast ? '0 8px 8px 0' : '0',
                      }}
                      title={`${label}: ${block.state} (${formatTs(block.from)} → ${formatTs(block.to)})`}
                    >
                      {widthPct > 10 && (
                        <span className="text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap px-1" style={{ color: stateColor }}>
                          {block.state}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3 mt-3 min-w-0">
        <div className="w-24 shrink-0" />
        <div className="flex-1 flex justify-between min-w-0">
          {axisLabels.map((label, i) => (
            <span key={i} className="timeline-label">
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
