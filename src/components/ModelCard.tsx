import { clsx } from 'clsx';
import { motion } from 'framer-motion';
import { MODEL_LABELS, MODEL_COLORS, SUPPLY_STATE_COLORS } from '../types';
import type { ModelSnapshot } from '../types';

interface ModelCardProps {
  modelId: string;
  latest: ModelSnapshot | null;
  isSelected: boolean;
  onToggle: () => void;
}

function SupplyBadge({ state }: { state: string }) {
  const color = SUPPLY_STATE_COLORS[state] || SUPPLY_STATE_COLORS.unknown;
  return (
    <span className="supply-badge" style={{ backgroundColor: `${color}18`, color }}>
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
      {state}
    </span>
  );
}

function Stat({ label, value, large = false }: { label: string; value: string; large?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="stat-label">{label}</span>
      <span className={clsx(
        'metric-mono text-zinc-800 dark:text-zinc-100',
        large ? 'stat-value-lg' : 'stat-value-sm',
      )}>
        {value}
      </span>
    </div>
  );
}

export default function ModelCard({ modelId, latest, isSelected, onToggle }: ModelCardProps) {
  const label = MODEL_LABELS[modelId] || modelId;
  const color = MODEL_COLORS[modelId] || '#71717a';

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      onClick={onToggle}
      className={clsx('card-surface cursor-pointer', isSelected && 'ring-2')}
      style={
        isSelected
          ? {
              '--tw-ring-color': color,
              '--tw-ring-offset-color': 'var(--bg)',
              '--tw-ring-offset-width': '2px',
              borderColor: `${color}50`,
            } as React.CSSProperties
          : undefined
      }
    >
      <div className="p-5">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: color }} />
              <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 truncate">{label}</h3>
            </div>
            {latest && <SupplyBadge state={latest.supply_state} />}
          </div>

        {!latest ? (
          <p className="text-xs text-zinc-400">No data yet</p>
        ) : (
          <div className="space-y-4">
            <div className="flex">
              <div className="w-1/2 pr-3">
                <Stat label="Discount" value={`${latest.discount_percent}%`} large />
              </div>
              <div className="w-1/2 pl-3 card-divider">
                <Stat label="Multiplier" value={`${latest.credit_multiplier.toFixed(2)}×`} large />
              </div>
            </div>
            <div className="flex">
              <div className="w-1/2 pr-3">
                <Stat label="TPS" value={latest.tps !== null ? latest.tps.toFixed(1) : '—'} />
              </div>
              <div className="w-1/2 pl-3 card-divider">
                <Stat label="TTFT" value={latest.ttfb_seconds !== null ? `${latest.ttfb_seconds.toFixed(2)}s` : '—'} />
              </div>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
