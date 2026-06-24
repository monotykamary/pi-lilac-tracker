import { clsx } from 'clsx';
import { motion } from 'framer-motion';
import { MODEL_LABELS, MODEL_COLORS, SUPPLY_STATE_COLORS, discountColor } from '../types';
import type { ModelSnapshot } from '../types';

interface ModelCardProps {
  modelId: string;
  latest: ModelSnapshot | null;
  isSelected: boolean;
  onToggle: () => void;
}

// Compact inline supply chip for the card header. The shared .supply-badge is
// sized for the map header; this is the same dot+state idea at card scale.
function SupplyChip({ state }: { state: string }) {
  const color = SUPPLY_STATE_COLORS[state] || SUPPLY_STATE_COLORS.unknown;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide shrink-0"
      style={{ backgroundColor: `${color}1a`, color }}
      title={`Supply: ${state}`}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
      {state}
    </span>
  );
}

// Flat inline label+value pair — .stat-label over .stat-value, no box. The
// discount is the focal metric, carried by deal-quality color. See index.css
// for the scale tokens + the "never .pill inside a card" guardrail.
function Metric({
  label, value, color,
}: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="stat-label">{label}</span>
      <span
        className="metric-mono stat-value"
        style={color ? { color } : undefined}
      >
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
      <div style={{ padding: 'var(--space-card-pad)' }}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
            <h3 className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-200 truncate">{label}</h3>
            {latest && <SupplyChip state={latest.supply_state} />}
          </div>

          {!latest ? (
            <span className="text-[11px] text-zinc-400 shrink-0">No data yet</span>
          ) : (
            <div className="flex items-center gap-2.5 shrink-0">
              <Metric
                label="Discount"
                value={`${latest.discount_percent}%`}
                color={discountColor(latest.discount_percent)}
              />
              <div className="card-divider self-stretch" />
              <Metric
                label="TPS"
                value={latest.tps !== null ? `${latest.tps.toFixed(1)} t/s` : '—'}
              />
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
