import { useMemo, useState, useEffect, useRef } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { TRACKED_MODELS } from '../types';
import type { ModelSnapshot } from '../types';

interface TimelineChartProps {
  title: string;
  timeSeries: Record<string, { timestamp: string; snapshot: ModelSnapshot; supply_updated_at: string | null }[]>;
  selectedModel: string | null;
  extractValue: (m: ModelSnapshot) => number | null;
  unit?: string;
  yDomain?: [number | 'auto', number | 'auto'];
  colorByModel: Record<string, string>;
  labelByModel: Record<string, string>;
  formatValue?: (v: number) => string;
}

export default function TimelineChart({
  title,
  timeSeries,
  selectedModel,
  extractValue,
  unit = '',
  yDomain,
  colorByModel,
  labelByModel,
  formatValue = (v) => v.toFixed(1),
}: TimelineChartProps) {
  const [isDark, setIsDark] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const check = () => setIsDark(document.documentElement.classList.contains('dark'));
    check();
    const obs = new MutationObserver(check);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  const chartData = useMemo(() => {
    const timestamps = new Set<string>();
    const models = selectedModel ? [selectedModel] : [...TRACKED_MODELS];

    for (const id of models) {
      for (const point of (timeSeries[id] || [])) {
        timestamps.add(point.timestamp);
      }
    }

    const sorted = [...timestamps].sort();
    const pointByTsModel = new Map<string, Map<string, number | null>>();

    for (const id of models) {
      for (const point of (timeSeries[id] || [])) {
        if (!pointByTsModel.has(point.timestamp)) pointByTsModel.set(point.timestamp, new Map());
        pointByTsModel.get(point.timestamp)!.set(id, extractValue(point.snapshot));
      }
    }

    return sorted.map(ts => {
      const row: Record<string, unknown> = { timestamp: ts };
      const tsMap = pointByTsModel.get(ts);
      for (const id of models) {
        row[id] = tsMap?.get(id) ?? null;
      }
      return row;
    });
  }, [timeSeries, selectedModel, extractValue]);

  const models = selectedModel ? [selectedModel] : [...TRACKED_MODELS];

  const hasData = chartData.length > 0 && models.some(id =>
    chartData.some(row => row[id] !== null && row[id] !== undefined)
  );

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    const hr = d.getHours().toString().padStart(2, '0');
    const min = d.getMinutes().toString().padStart(2, '0');
    return `${hr}:${min}`;
  };

  const formatTimeFull = (ts: string) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  const textColor = isDark ? '#a1a1aa' : '#71717a';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

  return (
    <div className="card-surface p-5">
      <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-300 mb-4">{title}</h2>
      <div ref={containerRef} className="w-full min-w-0 relative" style={{ height: 280 }}>
        {!hasData ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-xs text-zinc-400 dark:text-zinc-500">No data available</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
              <XAxis
                dataKey="timestamp"
                tickFormatter={formatTime}
                tick={{ fontSize: 10, fill: textColor }}
                tickLine={false}
                axisLine={{ stroke: gridColor }}
                minTickGap={40}
              />
              <YAxis
                tick={{ fontSize: 10, fill: textColor }}
                tickLine={false}
                axisLine={false}
                domain={yDomain}
                tickFormatter={(v: number) => formatValue(v)}
                width={50}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: isDark ? '#27272a' : '#ffffff',
                  border: `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(228,228,231,0.6)'}`,
                  borderRadius: '8px',
                  fontSize: '11px',
                  padding: '8px 12px',
                }}
                labelFormatter={(label: unknown) => typeof label === 'string' ? formatTimeFull(label) : String(label)}
                formatter={(value: unknown, name: unknown) => {
                  const v = typeof value === 'number' ? value : null;
                  const n = typeof name === 'string' ? name : String(name);
                  return [
                    v !== null ? `${formatValue(v)}${unit}` : '—',
                    labelByModel[n] || n,
                  ];
                }}
              />
              <Legend
                formatter={(value: string) => labelByModel[value] || value}
                wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }}
              />
              {models.map(id => (
                <Line
                  key={id}
                  type="monotone"
                  dataKey={id}
                  stroke={colorByModel[id]}
                  strokeWidth={1.5}
                  dot={chartData.length < 20}
                  activeDot={{ r: 3, strokeWidth: 0 }}
                  connectNulls={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
