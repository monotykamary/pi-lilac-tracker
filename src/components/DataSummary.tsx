import { Clock, Database, Lightning, Timer } from '@phosphor-icons/react';
import { SmartTooltip } from './SmartTooltip';
import type { ServerStatus } from '../types';

interface DataSummaryProps {
  snapshotCount: number;
  lastTimestamp: string | null;
  supplyUpdatedAt: string | null;
  serverStatus: ServerStatus | null;
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatTs(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleString();
}

function fmtInterval(ms: number): string {
  if (ms >= 600_000) return `${ms / 60000}m`;
  if (ms >= 60_000) return `${ms / 60000}m`;
  return `${Math.floor(ms / 1000)}s`;
}

function Pill({ icon: Icon, label, value, accent = false }: {
  icon: React.ElementType;
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className={`pill ${accent ? 'pill-accent' : ''}`}>
      <div className={`pill-icon-bg ${accent ? 'pill-icon-bg-accent' : ''} text-accent`}>
        <Icon weight="bold" size={14} />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-400 leading-none">
          {label}
        </p>
        <p className="metric-mono text-sm font-semibold text-zinc-800 dark:text-zinc-300 mt-1 leading-tight whitespace-nowrap">
          {value}
        </p>
      </div>
    </div>
  );
}

/* ── Snapshot Tooltip ── */
function SnapshotTooltip({ snapshotCount }: { snapshotCount: number }) {
  const perDay = snapshotCount > 0 ? (snapshotCount / 1).toFixed(0) : '0';
  const maxYearly = 105120; // ~1 per 5 min
  const fillPct = Math.min((snapshotCount / maxYearly) * 100, 100);

  return (
    <div className="glass-panel" style={{ padding: '14px 16px', minWidth: 260, maxWidth: 300 }}>
      <div className="tooltip-row-flex" style={{ marginBottom: 8 }}>
        <span className="tooltip-header">Snapshot History</span>
        <span className="tooltip-header-unit">records</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
        <span className="tooltip-value-lg">{snapshotCount.toLocaleString()}</span>
        <span style={{ fontSize: 10, color: '#a1a1aa' }}>total snapshots</span>
      </div>

      <div className="tooltip-mini-grid" style={{ marginBottom: 14 }}>
        <div className="tooltip-mini-card">
          <div className="tooltip-mini-label">Per day</div>
          <div className="tooltip-mini-value">~{perDay}</div>
        </div>
        <div className="tooltip-mini-card tooltip-mini-card-accent">
          <div className="tooltip-mini-label tooltip-mini-label-accent">Format</div>
          <div className="tooltip-mini-value">JSONL</div>
        </div>
        <div className="tooltip-mini-card tooltip-mini-card-moss">
          <div className="tooltip-mini-label tooltip-mini-label-moss">Retention</div>
          <div className="tooltip-mini-value">Unbounded</div>
        </div>
      </div>

      <div style={{ marginBottom: 4 }}>
        <div className="tooltip-row-flex" style={{ marginBottom: 4 }}>
          <span style={{ fontSize: 9, color: '#a1a1aa' }}>Storage utilization</span>
          <span className="metric-mono" style={{ fontSize: 10, fontWeight: 500, color: '#52525b' }}>{fillPct.toFixed(1)}% of yearly</span>
        </div>
        <div className="tooltip-progress-track">
          <div className="tooltip-progress-segment" style={{ width: `${fillPct}%`, background: '#0891b2' }} />
        </div>
      </div>

      <div className="tooltip-section" style={{ paddingTop: 10, marginTop: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="tooltip-row-flex">
            <span style={{ fontSize: 10, color: '#71717a' }}>Collection rate</span>
            <span className="tooltip-row-value">Every 5 min (1 min in fast mode)</span>
          </div>
          <div className="tooltip-row-flex">
            <span style={{ fontSize: 10, color: '#71717a' }}>Data points / model</span>
            <span className="tooltip-row-value">{Math.floor(snapshotCount / 3).toLocaleString()}</span>
          </div>
        </div>
      </div>

      <div className="tooltip-section-mild" style={{ paddingTop: 8, marginTop: 10 }}>
        <p className="tooltip-footer">
          Snapshots are polled from the Lilac /status API and written as newline-delimited JSON. Each snapshot captures pricing, supply state, and inferred throughput metrics for all tracked models.
        </p>
      </div>
    </div>
  );
}

/* ── Poll Status Tooltip ── */
function PollTooltip({ lastTimestamp, serverStatus }: { lastTimestamp: string | null; serverStatus: ServerStatus | null }) {
  const isFast = serverStatus?.fast_mode ?? false;
  const isActive = serverStatus?.polling ?? false;
  const statusColor = isActive ? '#059669' : '#dc2626';

  return (
    <div className="glass-panel" style={{ padding: '14px 16px', minWidth: 260, maxWidth: 300 }}>
      <div className="tooltip-row-flex" style={{ marginBottom: 8 }}>
        <span className="tooltip-header">Polling Status</span>
        <span className="tooltip-badge" style={{ background: `${statusColor}12`, color: statusColor }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: statusColor, display: 'inline-block' }} />
          {isActive ? 'Active' : 'Paused'}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
        <span className="tooltip-value-lg">{lastTimestamp ? timeAgo(lastTimestamp) : '—'}</span>
        <span style={{ fontSize: 10, color: '#a1a1aa' }}>since last poll</span>
      </div>

      <div className="tooltip-mini-grid" style={{ marginBottom: 14 }}>
        <div className="tooltip-mini-card tooltip-mini-card-accent">
          <div className="tooltip-mini-label tooltip-mini-label-accent">Mode</div>
          <div className="tooltip-mini-value">{isFast ? 'FAST' : 'Normal'}</div>
        </div>
        <div className="tooltip-mini-card tooltip-mini-card-moss">
          <div className="tooltip-mini-label tooltip-mini-label-moss">Interval</div>
          <div className="tooltip-mini-value">{serverStatus ? fmtInterval(serverStatus.interval_ms) : '—'}</div>
        </div>
        <div className="tooltip-mini-card">
          <div className="tooltip-mini-label">Status</div>
          <div className="tooltip-mini-value">{isActive ? 'Running' : 'Stopped'}</div>
        </div>
      </div>

      <div className="tooltip-section" style={{ paddingTop: 10, marginTop: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="tooltip-row-flex">
            <span style={{ fontSize: 10, color: '#71717a' }}>Last poll</span>
            <span className="tooltip-row-value">{lastTimestamp ? formatTs(lastTimestamp) : '—'}</span>
          </div>
          <div className="tooltip-row-flex">
            <span style={{ fontSize: 10, color: '#71717a' }}>Fast mode trigger</span>
            <span className="tooltip-row-value">State change detected</span>
          </div>
          <div className="tooltip-row-flex">
            <span style={{ fontSize: 10, color: '#71717a' }}>Fast mode duration</span>
            <span className="tooltip-row-value">10 minutes</span>
          </div>
        </div>
      </div>

      <div className="tooltip-section-mild" style={{ paddingTop: 8, marginTop: 10 }}>
        <p className="tooltip-footer">
          Fast mode (60s) activates for 10 minutes after any supply state change, then reverts to normal (5 min). This captures transitions quickly without constant high-frequency polling.
        </p>
      </div>
    </div>
  );
}

/* ── Supply Update Tooltip ── */
function SupplyTooltip({ supplyUpdatedAt }: { supplyUpdatedAt: string | null }) {
  return (
    <div className="glass-panel" style={{ padding: '14px 16px', minWidth: 260, maxWidth: 300 }}>
      <div className="tooltip-row-flex" style={{ marginBottom: 8 }}>
        <span className="tooltip-header">Supply Update</span>
        <span className="tooltip-header-unit">live</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
        <span className="tooltip-value-lg">{supplyUpdatedAt ? timeAgo(supplyUpdatedAt) : '—'}</span>
        <span style={{ fontSize: 10, color: '#a1a1aa' }}>since last change</span>
      </div>

      <div className="tooltip-mini-grid" style={{ marginBottom: 14 }}>
        <div className="tooltip-mini-card tooltip-mini-card-accent">
          <div className="tooltip-mini-label tooltip-mini-label-accent">Window</div>
          <div className="tooltip-mini-value">24h</div>
        </div>
        <div className="tooltip-mini-card tooltip-mini-card-moss">
          <div className="tooltip-mini-label tooltip-mini-label-moss">Source</div>
          <div className="tooltip-mini-value">Lilac</div>
        </div>
        <div className="tooltip-mini-card">
          <div className="tooltip-mini-label">Models</div>
          <div className="tooltip-mini-value">3 tracked</div>
        </div>
      </div>

      <div className="tooltip-section" style={{ paddingTop: 10, marginTop: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="tooltip-row-flex">
            <span style={{ fontSize: 10, color: '#71717a' }}>Last change</span>
            <span className="tooltip-row-value">{supplyUpdatedAt ? formatTs(supplyUpdatedAt) : '—'}</span>
          </div>
          <div className="tooltip-row-flex">
            <span style={{ fontSize: 10, color: '#71717a' }}>States</span>
            <span className="tooltip-row-value">Low · Medium · High · Surplus</span>
          </div>
          <div className="tooltip-row-flex">
            <span style={{ fontSize: 10, color: '#71717a' }}>API endpoint</span>
            <span className="tooltip-row-value">/api/v1/status</span>
          </div>
        </div>
      </div>

      <div className="tooltip-section-mild" style={{ paddingTop: 8, marginTop: 10 }}>
        <p className="tooltip-footer">
          Supply state changes are detected via the Lilac /status API. A 24-hour rolling window is used to determine pricing tiers. Transitions trigger fast-mode polling for 10 minutes.
        </p>
      </div>
    </div>
  );
}

/* ── Interval Tooltip ── */
function IntervalTooltip({ serverStatus }: { serverStatus: ServerStatus | null }) {
  const current = serverStatus?.interval_ms ?? 300_000;
  const defaultMs = 300_000;
  const fastMs = 60_000;
  const isFast = current === fastMs;
  const againstDefault = Math.max(0, (defaultMs - current) / defaultMs * 100);

  return (
    <div className="glass-panel" style={{ padding: '14px 16px', minWidth: 260, maxWidth: 300 }}>
      <div className="tooltip-row-flex" style={{ marginBottom: 8 }}>
        <span className="tooltip-header">Polling Interval</span>
        <span className="tooltip-header-unit">timing</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
        <span className="tooltip-value-lg">{serverStatus ? fmtInterval(serverStatus.interval_ms) : '—'}</span>
        <span style={{ fontSize: 10, color: '#a1a1aa' }}>current interval</span>
      </div>

      <div className="tooltip-mini-grid" style={{ marginBottom: 14 }}>
        <div className={isFast ? 'tooltip-mini-card tooltip-mini-card-accent' : 'tooltip-mini-card'}>
          <div className={isFast ? 'tooltip-mini-label tooltip-mini-label-accent' : 'tooltip-mini-label'}>Current</div>
          <div className="tooltip-mini-value">{serverStatus ? fmtInterval(serverStatus.interval_ms) : '—'}</div>
        </div>
        <div className="tooltip-mini-card">
          <div className="tooltip-mini-label">Default</div>
          <div className="tooltip-mini-value">5m</div>
        </div>
        <div className="tooltip-mini-card tooltip-mini-card-moss">
          <div className="tooltip-mini-label tooltip-mini-label-moss">Fast</div>
          <div className="tooltip-mini-value">30s</div>
        </div>
      </div>

      <div style={{ marginBottom: 4 }}>
        <div className="tooltip-row-flex" style={{ marginBottom: 4 }}>
          <span style={{ fontSize: 9, color: '#a1a1aa' }}>Speed vs default</span>
          <span className="metric-mono" style={{ fontSize: 10, fontWeight: 500, color: isFast ? '#d97706' : '#0891b2' }}>
            {isFast ? '2× faster' : 'Normal rate'}
          </span>
        </div>
        <div className="tooltip-progress-track">
          <div className="tooltip-progress-segment" style={{ width: `${againstDefault}%`, background: isFast ? '#d97706' : '#0891b2' }} />
        </div>
      </div>

      <div className="tooltip-section" style={{ paddingTop: 10, marginTop: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="tooltip-row-flex">
            <span style={{ fontSize: 10, color: '#71717a' }}>Normal rate</span>
            <span className="tooltip-row-value">1 snapshot / 5 min</span>
          </div>
          <div className="tooltip-row-flex">
            <span style={{ fontSize: 10, color: '#71717a' }}>Fast rate</span>
            <span className="tooltip-row-value">1 snapshot / min</span>
          </div>
          <div className="tooltip-row-flex">
            <span style={{ fontSize: 10, color: '#71717a' }}>Fast mode TTL</span>
            <span className="tooltip-row-value">10 minutes</span>
          </div>
        </div>
      </div>

      <div className="tooltip-section-mild" style={{ paddingTop: 8, marginTop: 10 }}>
        <p className="tooltip-footer">
          Lilac's discount window is ~10 minutes — normal mode polls twice per window (every 5 min) to catch transitions within half a window rather than waiting up to a full one. Fast mode activates after state changes to observe when the new state stabilises.
        </p>
      </div>
    </div>
  );
}

export default function DataSummary({ snapshotCount, lastTimestamp, supplyUpdatedAt, serverStatus }: DataSummaryProps) {
  return (
    <div className="pill-grid">
      <SmartTooltip content={<SnapshotTooltip snapshotCount={snapshotCount} />} preferredPlacement="bottom" gap={10}>
        <Pill icon={Database} label="Snapshots" value={snapshotCount.toLocaleString()} accent />
      </SmartTooltip>
      <SmartTooltip content={<PollTooltip lastTimestamp={lastTimestamp} serverStatus={serverStatus} />} preferredPlacement="bottom" gap={10}>
        <Pill icon={Clock} label="Last Poll" value={lastTimestamp ? timeAgo(lastTimestamp) : '—'} />
      </SmartTooltip>
      <SmartTooltip content={<SupplyTooltip supplyUpdatedAt={supplyUpdatedAt} />} preferredPlacement="bottom" gap={10}>
        <Pill icon={Lightning} label="Supply Updated" value={supplyUpdatedAt ? timeAgo(supplyUpdatedAt) : '—'} />
      </SmartTooltip>
      <SmartTooltip content={<IntervalTooltip serverStatus={serverStatus} />} preferredPlacement="bottom" gap={10}>
        <Pill icon={Timer} label="Poll Interval" value={serverStatus ? fmtInterval(serverStatus.interval_ms) : '—'} />
      </SmartTooltip>
    </div>
  );
}
